import { Hono } from 'hono'
import { employeeBand } from '../../scripts/lib/employeeBands.js'
import {
  limitForZoom,
  fetchLimitForTarget,
  stratifiedSamplePoints,
} from '../../scripts/lib/point-sampling.js'
import { toCompactPoint, roundCoord, type CompactPoint } from '../../scripts/lib/points.js'
import { resolveOrganizationLocation } from '../location.js'
import {
  addressGroupFromSqlRow,
  type AddressGroupedPoint,
  type AddressGroupSqlRow,
} from '../addressGroups.js'
import { addressGroupKeySql } from '../../shared/address-groups.js'
import { getContext } from '../context.js'
import { maybeNotModified, resourceEtag } from '../httpCache.js'
import { queryViewportSummary } from '../viewport-summary.js'
import {
  appendAreaFilters,
  appendBboxFilter,
  buildFilterQuery,
  parseFilters,
  rtreeBboxParams,
} from '../filters.js'

const organizations = new Hono()

const KONSERN_CACHE_TTL_MS = 60 * 60 * 1000
const KONSERN_CACHE_MAX_SIZE = 500
const konsernCache = new Map<string, { expiresAt: number; data: unknown }>()

async function fetchKonsernstruktur(orgnr: string) {
  const cached = konsernCache.get(orgnr)
  if (cached && cached.expiresAt > Date.now()) {
    konsernCache.delete(orgnr)
    konsernCache.set(orgnr, cached)
    return cached.data
  }

  const response = await fetch(
    `https://data.brreg.no/enhetsregisteret/api/konsernstruktur/${orgnr}`,
    { headers: { Accept: 'application/json' } },
  )

  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`BRREG konsernstruktur feilet (${response.status})`)
  }

  const data = await response.json()
  konsernCache.set(orgnr, { expiresAt: Date.now() + KONSERN_CACHE_TTL_MS, data })

  if (konsernCache.size > KONSERN_CACHE_MAX_SIZE) {
    const oldest = konsernCache.keys().next().value!
    konsernCache.delete(oldest)
  }

  return data
}

const POINT_GROUP_SELECT = `MIN(o.orgnr) AS orgnr,
                MIN(o.org_type) AS org_type,
                MIN(o.org_type_label) AS org_type_label,
                MIN(o.navn) AS navn,
                MIN(o.address_text) AS address_text,
                MIN(o.postnummer) AS postnummer,
                MIN(o.kommunenummer) AS kommunenummer,
                MIN(o.lat) AS lat,
                MIN(o.lng) AS lng,
                MIN(o.adresse_id) AS adresse_id,
                MIN(o.naeringskode_section) AS naeringskode,
                MIN(o.employee_band) AS employee_band,
                MIN(o.entity_kind) AS entity_kind,
                COUNT(*) AS org_count,
                GROUP_CONCAT(o.orgnr) AS orgnrs,
                GROUP_CONCAT(DISTINCT o.org_type) AS types`

const ORG_DETAIL_SELECT = `orgnr, navn, org_type, org_type_label, address_text, postnummer,
              kommunenummer, lat, lng, naeringskode, naeringskode_label,
              antall_ansatte, har_registrert_antall_ansatte, entity_kind,
              overordnet_enhet, er_i_konsern, geocode_quality, matrikkel_key`

const POINTS_MAX_AGE = 20

type OrganizationDetailRow = {
  orgnr: string
  navn: string
  org_type: string
  org_type_label: string
  address_text: string
  postnummer: string
  kommunenummer: string
  lat: number | null
  lng: number | null
  naeringskode: string | null
  naeringskode_label: string | null
  antall_ansatte: number | null
  har_registrert_antall_ansatte: number
  entity_kind: string
  overordnet_enhet: string | null
  er_i_konsern: number
  geocode_quality: string | null
  matrikkel_key: string | null
}

function organizationFromDetailRow(row: OrganizationDetailRow) {
  return {
    orgnr: row.orgnr,
    navn: row.navn,
    orgType: row.org_type,
    orgTypeLabel: row.org_type_label,
    addressText: row.address_text,
    postnummer: row.postnummer,
    kommunenummer: row.kommunenummer,
    lat: row.lat,
    lng: row.lng,
    naeringskode: row.naeringskode,
    naeringskodeLabel: row.naeringskode_label,
    antallAnsatte: row.antall_ansatte,
    employeeBand: employeeBand(row.antall_ansatte, row.har_registrert_antall_ansatte === 1),
    entityKind: row.entity_kind,
    overordnetEnhet: row.overordnet_enhet,
    erIKonsern: row.er_i_konsern === 1,
    geocodeQuality: row.geocode_quality,
    matrikkelKey: row.matrikkel_key,
  }
}

function organizationQuery(filters: ReturnType<typeof parseFilters>, geocodedOnly = true) {
  const { conditions, params } = buildFilterQuery(filters, geocodedOnly, 'o')
  appendAreaFilters(filters, conditions, params, 'o')

  if (filters.bbox) {
    return { conditions, params, bbox: filters.bbox, useRtree: true as const }
  }

  return { conditions, params, useRtree: false as const }
}

function queryOrganizationPoints(
  filters: ReturnType<typeof parseFilters>,
  targetLimit: number,
): { rows: AddressGroupedPoint[]; sourceCount: number } {
  const { cachedPrepare } = getContext()
  const fetchLimit = fetchLimitForTarget(targetLimit, filters.zoom)
  const query = organizationQuery(filters)
  const groupKey = addressGroupKeySql('o')

  let raw: AddressGroupSqlRow[]

  if (query.useRtree) {
    const [minLng, maxLng, minLat, maxLat] = rtreeBboxParams(query.bbox)
    raw =
      fetchLimit == null
        ? (cachedPrepare(
            `SELECT ${POINT_GROUP_SELECT}
             FROM organizations o
             INNER JOIN orgs_rtree r ON r.id = o.rowid
             WHERE r.maxLng >= ? AND r.minLng <= ?
               AND r.maxLat >= ? AND r.minLat <= ?
               AND ${query.conditions.join(' AND ')}
             GROUP BY ${groupKey}`,
          ).all(minLng, maxLng, minLat, maxLat, ...query.params) as AddressGroupSqlRow[])
        : (cachedPrepare(
            `SELECT ${POINT_GROUP_SELECT}
             FROM organizations o
             INNER JOIN orgs_rtree r ON r.id = o.rowid
             WHERE r.maxLng >= ? AND r.minLng <= ?
               AND r.maxLat >= ? AND r.minLat <= ?
               AND ${query.conditions.join(' AND ')}
             GROUP BY ${groupKey}
             LIMIT ?`,
          ).all(
            minLng,
            maxLng,
            minLat,
            maxLat,
            ...query.params,
            fetchLimit,
          ) as AddressGroupSqlRow[])
  } else {
    appendBboxFilter(filters.bbox, query.conditions, query.params, 'o')
    raw =
      fetchLimit == null
        ? (cachedPrepare(
            `SELECT ${POINT_GROUP_SELECT}
             FROM organizations o
             WHERE ${query.conditions.join(' AND ')}
             GROUP BY ${groupKey}`,
          ).all(...query.params) as AddressGroupSqlRow[])
        : (cachedPrepare(
            `SELECT ${POINT_GROUP_SELECT}
             FROM organizations o
             WHERE ${query.conditions.join(' AND ')}
             GROUP BY ${groupKey}
             LIMIT ?`,
          ).all(...query.params, fetchLimit) as AddressGroupSqlRow[])
  }

  const grouped = raw.map(addressGroupFromSqlRow)
  const rows =
    fetchLimit == null
      ? grouped
      : stratifiedSamplePoints(grouped, targetLimit, filters.bbox, {
          orgType: (row) => row.orgType,
          lat: (row) => row.lat,
          lng: (row) => row.lng,
        })

  return { rows, sourceCount: raw.length }
}

function compactGroupedPoint(point: AddressGroupedPoint): CompactPoint {
  return toCompactPoint(point.orgnr, point.lng, point.lat, point.orgType, {
    navn: point.navn,
    orgTypeLabel: point.orgTypeLabel,
    addressText: point.addressText,
    postnummer: point.postnummer,
    naeringskode: point.naeringskode ?? undefined,
    employeeBand: point.employeeBand,
    entityKind: point.entityKind,
    kommunenummer: point.kommunenummer,
    orgCount: point.orgCount,
    orgnrs: point.orgnrs,
    typeList: point.typeList,
  })
}

organizations.get('/api/organizations/points', async (c) => {
  const { db } = getContext()
  const filters = parseFilters(c.req)
  const explicitLimit = Number(c.req.query('limit') ?? '')
  const limit = limitForZoom(
    filters.zoom,
    Number.isFinite(explicitLimit) ? explicitLimit : undefined,
  )
  const verbose = c.req.query('format') === 'full'

  const notModified = maybeNotModified(c, {
    etag: resourceEtag('organizations-points', c.req.url),
    maxAge: POINTS_MAX_AGE,
  })
  if (notModified) return notModified

  const { rows, sourceCount } = queryOrganizationPoints(filters, limit)
  const fetchCap = fetchLimitForTarget(limit, filters.zoom)
  const truncated = fetchCap != null && (sourceCount >= fetchCap || sourceCount > rows.length)

  const summary = filters.bbox ? await queryViewportSummary(db, filters, filters.zoom) : undefined

  if (verbose) {
    return c.json({
      points: rows.map((point) => ({
        orgnr: point.orgnr,
        orgType: point.orgType,
        orgTypeLabel: point.orgTypeLabel,
        navn: point.navn,
        addressText: point.addressText,
        postnummer: point.postnummer,
        kommunenummer: point.kommunenummer,
        lat: roundCoord(point.lat),
        lng: roundCoord(point.lng),
        naeringskode: point.naeringskode,
        employeeBand: point.employeeBand,
        entityKind: point.entityKind,
        adresseId: point.adresseId,
        orgCount: point.orgCount,
        orgnrs: point.orgnrs,
        typeList: point.typeList,
      })),
      count: rows.length,
      truncated,
      sampled: truncated,
      grouped: true,
      summary,
    })
  }

  const points: CompactPoint[] = rows.map(compactGroupedPoint)
  return c.json({
    points,
    count: points.length,
    truncated,
    sampled: truncated,
    grouped: true,
    summary,
  })
})

organizations.get('/api/organizations/search', (c) => {
  const { db, cachedPrepare } = getContext()
  const raw = c.req.query('q')?.trim() ?? ''
  if (raw.length < 2) {
    return c.json({ results: [] })
  }

  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 8) || 8, 1), 20)
  const digits = raw.replace(/\D/g, '')

  type SearchRow = {
    orgnr: string
    navn: string
    org_type: string
    org_type_label: string
    kommunenummer: string | null
    lat: number | null
    lng: number | null
  }

  const mapRow = (row: SearchRow) => ({
    orgnr: row.orgnr,
    navn: row.navn,
    orgType: row.org_type,
    orgTypeLabel: row.org_type_label,
    kommunenummer: row.kommunenummer ?? '',
    lat: row.lat,
    lng: row.lng,
  })

  if (digits.length === 9) {
    const row = db
      .prepare(
        `SELECT orgnr, navn, org_type, org_type_label, kommunenummer, lat, lng
         FROM organizations WHERE deleted = 0 AND orgnr = ?`,
      )
      .get(digits) as SearchRow | undefined
    return c.json({ results: row ? [mapRow(row)] : [] })
  }

  const ftsQuery = raw
    .replace(/[^\w\s\u00C0-\u024F-]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token}"`)
    .join(' ')

  let rows: SearchRow[]
  try {
    if (!ftsQuery) throw new Error('empty query')
    rows = cachedPrepare(
      `SELECT o.orgnr, o.navn, o.org_type, o.org_type_label, o.kommunenummer, o.lat, o.lng
       FROM organizations_fts fts
       INNER JOIN organizations o ON o.rowid = fts.rowid
       WHERE organizations_fts MATCH ?
         AND o.deleted = 0
       ORDER BY rank
       LIMIT ?`,
    ).all(`${ftsQuery}*`, limit) as SearchRow[]
  } catch {
    rows = []
  }

  if (rows.length === 0) {
    const pattern = `%${raw.replace(/[%_]/g, '')}%`
    rows = cachedPrepare(
      `SELECT orgnr, navn, org_type, org_type_label, kommunenummer, lat, lng
       FROM organizations
       WHERE deleted = 0 AND navn LIKE ? COLLATE NOCASE
       ORDER BY LENGTH(navn), navn
       LIMIT ?`,
    ).all(pattern, limit) as SearchRow[]
  }

  return c.json({ results: rows.map(mapRow) })
})

organizations.get('/api/organizations/:orgnr/locate', async (c) => {
  const { db } = getContext()
  const orgnr = c.req.param('orgnr').replace(/\D/g, '')
  if (orgnr.length !== 9) {
    return c.json({ error: 'Ugyldig organisasjonsnummer' }, 400)
  }

  const location = await resolveOrganizationLocation(db, orgnr)
  if (!location) {
    return c.json({ error: 'Organisasjon ikke funnet' }, 404)
  }

  return c.json({ location })
})

organizations.get('/api/organizations/:orgnr/konsern', async (c) => {
  const orgnr = c.req.param('orgnr').replace(/\D/g, '')
  if (orgnr.length !== 9) {
    return c.json({ error: 'Ugyldig organisasjonsnummer' }, 400)
  }

  try {
    const data = await fetchKonsernstruktur(orgnr)
    if (!data) {
      return c.json({ error: 'Ikke del av konsern' }, 404)
    }
    return c.json({ konsern: data })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Kunne ikke hente konsernstruktur' },
      502,
    )
  }
})

organizations.post('/api/organizations/batch', async (c) => {
  const { db } = getContext()
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Ugyldig JSON' }, 400)
  }

  const raw =
    body && typeof body === 'object' && Array.isArray((body as { orgnrs?: unknown }).orgnrs)
      ? (body as { orgnrs: unknown[] }).orgnrs
      : []
  const orgnrs = [
    ...new Set(
      raw
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.replace(/\D/g, ''))
        .filter((value) => value.length > 0),
    ),
  ].slice(0, 100)

  if (orgnrs.length === 0) {
    return c.json({ organizations: [] })
  }

  const BATCH_SIZES = [1, 5, 10, 25, 50, 100] as const
  const size = BATCH_SIZES.find((s) => s >= orgnrs.length) ?? BATCH_SIZES[BATCH_SIZES.length - 1]
  const stmt = db.prepare(
    `SELECT ${ORG_DETAIL_SELECT} FROM organizations
     WHERE deleted = 0 AND orgnr IN (${Array(size).fill('?').join(',')})`,
  )
  const padded = [...orgnrs]
  while (padded.length < size) padded.push('')
  const rows = stmt.all(...padded) as OrganizationDetailRow[]

  const byOrgnr = new Map(rows.map((row) => [row.orgnr, organizationFromDetailRow(row)]))
  const orgs = orgnrs
    .map((orgnr) => byOrgnr.get(orgnr))
    .filter((org): org is NonNullable<typeof org> => org != null)

  return c.json({ organizations: orgs })
})

organizations.get('/api/organizations/:orgnr', (c) => {
  const { db } = getContext()
  const orgnr = c.req.param('orgnr')
  const row = db
    .prepare(`SELECT ${ORG_DETAIL_SELECT} FROM organizations WHERE deleted = 0 AND orgnr = ?`)
    .get(orgnr) as OrganizationDetailRow | undefined

  if (!row) {
    return c.json({ error: 'Organisasjon ikke funnet' }, 404)
  }

  return c.json({ organization: organizationFromDetailRow(row) })
})

organizations.get('/api/organizations', (c) => {
  const { cachedPrepare } = getContext()
  const filters = parseFilters(c.req)
  const explicitLimit = Number(c.req.query('limit') ?? '')
  const limit = limitForZoom(
    filters.zoom,
    Number.isFinite(explicitLimit) ? explicitLimit : undefined,
  )
  const query = organizationQuery(filters)

  let rows: Array<{
    orgnr: string
    navn: string
    org_type: string
    org_type_label: string
    address_text: string
    postnummer: string
    kommunenummer: string
    lat: number
    lng: number
  }>

  if (query.useRtree) {
    const [minLng, maxLng, minLat, maxLat] = rtreeBboxParams(query.bbox)
    rows = cachedPrepare(
      `SELECT o.orgnr, o.navn, o.org_type, o.org_type_label, o.address_text, o.postnummer,
              o.kommunenummer, o.lat, o.lng
       FROM organizations o
       INNER JOIN orgs_rtree r ON r.id = o.rowid
       WHERE r.maxLng >= ? AND r.minLng <= ?
         AND r.maxLat >= ? AND r.minLat <= ?
         AND ${query.conditions.join(' AND ')}
       LIMIT ?`,
    ).all(minLng, maxLng, minLat, maxLat, ...query.params, limit) as typeof rows
  } else {
    appendBboxFilter(filters.bbox, query.conditions, query.params, 'o')
    rows = cachedPrepare(
      `SELECT o.orgnr, o.navn, o.org_type, o.org_type_label, o.address_text, o.postnummer,
              o.kommunenummer, o.lat, o.lng
       FROM organizations o
       WHERE ${query.conditions.join(' AND ')}
       LIMIT ?`,
    ).all(...query.params, limit) as typeof rows
  }

  const result = rows.map((row) => ({
    orgnr: row.orgnr,
    navn: row.navn,
    orgType: row.org_type,
    orgTypeLabel: row.org_type_label,
    addressText: row.address_text,
    postnummer: row.postnummer,
    kommunenummer: row.kommunenummer,
    lat: row.lat,
    lng: row.lng,
  }))

  return c.json({
    organizations: result,
    count: result.length,
    truncated: result.length >= limit,
  })
})

export default organizations

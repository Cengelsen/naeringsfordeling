import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { openDatabase, DEFAULT_DB_PATH, getStats, effectiveKommunenummerExpr } from '../scripts/lib/db.js'
import { employeeBand } from '../scripts/lib/employeeBands.js'
import { limitForZoom, fetchLimitForTarget, stratifiedSamplePoints } from '../scripts/lib/point-sampling.js'
import { toCompactPoint, roundCoord, type CompactPoint } from '../scripts/lib/points.js'
import { resolveOrganizationLocation } from './location.js'
import { queryViewportSummary } from './viewport-summary.js'
import { warmAddressSpatialIndex } from './addressSpatialIndex.js'
import { groupOrganizationPointsByAddress } from './addressGroups.js'
import {
  appendAreaFilters,
  appendBboxFilter,
  buildFilterQuery,
  parseFilters,
  rtreeBboxParams,
} from './filters.js'

const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`)
  console.error('Run yarn sync:full or yarn download-db first.')
  process.exit(1)
}

const db = openDatabase(dbPath)
const app = new Hono()

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

const POINT_SELECT = `o.orgnr, o.org_type, o.org_type_label, o.navn, o.address_text, o.postnummer,
                o.kommunenummer, o.lat, o.lng, o.adresse_id,
                o.naeringskode_section AS naeringskode,
                o.employee_band,
                o.entity_kind`

const ORG_DETAIL_SELECT = `orgnr, navn, org_type, org_type_label, address_text, postnummer,
              kommunenummer, lat, lng, naeringskode, naeringskode_label,
              antall_ansatte, har_registrert_antall_ansatte, entity_kind,
              overordnet_enhet, er_i_konsern, geocode_quality, matrikkel_key`

const stmtOrgFormer = db.prepare(
  `SELECT org_type AS kode, MIN(org_type_label) AS beskrivelse, COUNT(*) AS count
   FROM organizations WHERE deleted = 0 GROUP BY org_type ORDER BY beskrivelse`,
)
const stmtNaeringskoder = db.prepare(
  `SELECT substr(naeringskode, 1, 2) AS section, MIN(naeringskode_label) AS label, COUNT(*) AS count
   FROM organizations WHERE deleted = 0 AND naeringskode IS NOT NULL AND length(naeringskode) >= 2
   GROUP BY section ORDER BY section`,
)
const stmtKommuner = db.prepare(
  `SELECT kommunenummer AS nummer, COUNT(*) AS count
   FROM organizations WHERE deleted = 0 AND kommunenummer IS NOT NULL
   GROUP BY kommunenummer ORDER BY kommunenummer`,
)
const stmtOrgByOrgnr = db.prepare(
  `SELECT ${ORG_DETAIL_SELECT} FROM organizations WHERE deleted = 0 AND orgnr = ?`,
)
const stmtSearchByOrgnr = db.prepare(
  `SELECT orgnr, navn, org_type, org_type_label, kommunenummer, lat, lng
   FROM organizations WHERE deleted = 0 AND orgnr = ?`,
)

app.use('/*', cors())
app.use(compress())

function organizationQuery(filters: ReturnType<typeof parseFilters>, geocodedOnly = true) {
  const { conditions, params } = buildFilterQuery(filters, geocodedOnly, 'o')
  appendAreaFilters(filters, conditions, params, 'o')

  if (filters.bbox) {
    return { conditions, params, bbox: filters.bbox, useRtree: true as const }
  }

  return { conditions, params, useRtree: false as const }
}

type OrganizationPointRow = {
  orgnr: string
  org_type: string
  org_type_label: string
  navn: string
  address_text: string
  postnummer: string
  kommunenummer: string
  lat: number
  lng: number
  adresse_id: string | null
  naeringskode: string | null
  employee_band: string
  entity_kind: string
}

function queryOrganizationPoints(
  filters: ReturnType<typeof parseFilters>,
  targetLimit: number,
): { rows: OrganizationPointRow[]; sourceCount: number } {
  const fetchLimit = fetchLimitForTarget(targetLimit, filters.zoom)
  const query = organizationQuery(filters)

  let raw: OrganizationPointRow[]

  if (query.useRtree) {
    const [minLng, maxLng, minLat, maxLat] = rtreeBboxParams(query.bbox)
    raw = fetchLimit == null
      ? (db
          .prepare(
            `SELECT ${POINT_SELECT}
             FROM organizations o
             INNER JOIN orgs_rtree r ON r.id = o.rowid
             WHERE r.maxLng >= ? AND r.minLng <= ?
               AND r.maxLat >= ? AND r.minLat <= ?
               AND ${query.conditions.join(' AND ')}`,
          )
          .all(minLng, maxLng, minLat, maxLat, ...query.params) as OrganizationPointRow[])
      : (db
          .prepare(
            `SELECT ${POINT_SELECT}
             FROM organizations o
             INNER JOIN orgs_rtree r ON r.id = o.rowid
             WHERE r.maxLng >= ? AND r.minLng <= ?
               AND r.maxLat >= ? AND r.minLat <= ?
               AND ${query.conditions.join(' AND ')}
             LIMIT ?`,
          )
          .all(minLng, maxLng, minLat, maxLat, ...query.params, fetchLimit) as OrganizationPointRow[])
  } else {
    appendBboxFilter(filters.bbox, query.conditions, query.params, 'o')
    raw = fetchLimit == null
      ? (db
          .prepare(
            `SELECT ${POINT_SELECT}
             FROM organizations o
             WHERE ${query.conditions.join(' AND ')}`,
          )
          .all(...query.params) as OrganizationPointRow[])
      : (db
          .prepare(
            `SELECT ${POINT_SELECT}
             FROM organizations o
             WHERE ${query.conditions.join(' AND ')}
             LIMIT ?`,
          )
          .all(...query.params, fetchLimit) as OrganizationPointRow[])
  }

  const rows =
    fetchLimit == null
      ? raw
      : stratifiedSamplePoints(raw, targetLimit, filters.bbox, {
          orgType: (row) => row.org_type,
          lat: (row) => row.lat,
          lng: (row) => row.lng,
        })

  return { rows, sourceCount: raw.length }
}

app.get('/api/health', (c) => {
  const stats = getStats(db)
  return c.json({
    ok: true,
    database: dbPath,
    stats,
  })
})

app.get('/api/organisasjonsformer', (c) => {
  const rows = stmtOrgFormer.all() as Array<{ kode: string; beskrivelse: string; count: number }>
  return c.json({ organisasjonsformer: rows.map(({ kode, beskrivelse }) => ({ kode, beskrivelse })) })
})

app.get('/api/naeringskoder', (c) => {
  const rows = stmtNaeringskoder.all() as Array<{ section: string; label: string | null; count: number }>
  return c.json({
    naeringskoder: rows.map((row) => ({
      section: row.section,
      label: row.label,
      count: row.count,
    })),
  })
})

app.get('/api/kommuner', (c) => {
  const rows = stmtKommuner.all() as Array<{ nummer: string; count: number }>
  return c.json({ kommuner: rows })
})

app.get('/api/municipality-counts', (c) => {
  const filters = parseFilters(c.req)
  const { conditions, params } = buildFilterQuery(filters, false)
  appendAreaFilters(filters, conditions, params)

  const kommuneExpr = effectiveKommunenummerExpr()
  const rows = db
    .prepare(
      `SELECT ${kommuneExpr} AS kommunenummer, COUNT(*) AS count
       FROM organizations
       WHERE ${conditions.join(' AND ')} AND ${kommuneExpr} IS NOT NULL
       GROUP BY ${kommuneExpr}`,
    )
    .all(...params) as Array<{ kommunenummer: string; count: number }>

  return c.json({
    counts: rows.map((row) => ({
      kommunenummer: row.kommunenummer,
      count: row.count,
    })),
  })
})

app.get('/api/district-stats', (c) => {
  const level = c.req.query('level')
  const districtId = c.req.query('id')
  if (level !== 'fylke' && level !== 'kommune') {
    return c.json({ error: 'level must be fylke or kommune' }, 400)
  }
  if (!districtId) {
    return c.json({ error: 'id query parameter is required' }, 400)
  }

  const filters = parseFilters(c.req)
  const { conditions, params } = buildFilterQuery(filters, false)
  appendAreaFilters(filters, conditions, params)

  const kommuneExpr = effectiveKommunenummerExpr()
  const districtExpr = level === 'fylke' ? `substr(${kommuneExpr}, 1, 2)` : kommuneExpr
  conditions.push(`${districtExpr} = ?`)
  params.push(districtId)

  const rows = db
    .prepare(
      `SELECT org_type, COUNT(*) AS count
       FROM organizations
       WHERE ${conditions.join(' AND ')} AND ${kommuneExpr} IS NOT NULL
       GROUP BY org_type`,
    )
    .all(...params) as Array<{ org_type: string; count: number }>

  const byOrgType: Record<string, number> = {}
  let total = 0
  for (const row of rows) {
    byOrgType[row.org_type] = row.count
    total += row.count
  }

  return c.json({ total, byOrgType })
})

app.get('/api/viewport-summary', (c) => {
  const filters = parseFilters(c.req)
  if (!filters.bbox) {
    return c.json({ error: 'bbox query parameter is required' }, 400)
  }

  const summary = queryViewportSummary(db, filters, filters.zoom)
  return c.json({ summary })
})

app.get('/api/organizations/points', (c) => {
  const filters = parseFilters(c.req)
  const explicitLimit = Number(c.req.query('limit') ?? '')
  const limit = limitForZoom(
    filters.zoom,
    Number.isFinite(explicitLimit) ? explicitLimit : undefined,
  )
  const compact = c.req.query('format') === 'compact'
  const { rows, sourceCount } = queryOrganizationPoints(filters, limit)
  const fetchCap = fetchLimitForTarget(limit, filters.zoom)
  const truncated = fetchCap != null && (sourceCount >= fetchCap || sourceCount > rows.length)
  const grouped = groupOrganizationPointsByAddress(rows)

  if (compact) {
    const points: CompactPoint[] = grouped.map((point) =>
      toCompactPoint(point.orgnr, point.lng, point.lat, point.orgType, {
        navn: point.navn,
        orgTypeLabel: point.orgTypeLabel,
        addressText: point.addressText,
        postnummer: point.postnummer,
        naeringskode: point.naeringskode ?? undefined,
        employeeBand: point.employeeBand,
        entityKind: point.entityKind,
      }),
    )
    return c.json({
      points,
      count: points.length,
      truncated,
      sampled: truncated,
      grouped: true,
    })
  }

  return c.json({
    points: grouped.map((point) => ({
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
    count: grouped.length,
    truncated,
    sampled: truncated,
    grouped: true,
  })
})

app.get('/api/organizations/search', (c) => {
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
    const row = stmtSearchByOrgnr.get(digits) as SearchRow | undefined
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
    rows = db
      .prepare(
        `SELECT o.orgnr, o.navn, o.org_type, o.org_type_label, o.kommunenummer, o.lat, o.lng
         FROM organizations_fts fts
         INNER JOIN organizations o ON o.rowid = fts.rowid
         WHERE organizations_fts MATCH ?
           AND o.deleted = 0
         ORDER BY rank
         LIMIT ?`,
      )
      .all(`${ftsQuery}*`, limit) as SearchRow[]
  } catch {
    const pattern = `%${raw.replace(/[%_]/g, '')}%`
    rows = db
      .prepare(
        `SELECT orgnr, navn, org_type, org_type_label, kommunenummer, lat, lng
         FROM organizations
         WHERE deleted = 0 AND navn LIKE ? COLLATE NOCASE
         ORDER BY LENGTH(navn), navn
         LIMIT ?`,
      )
      .all(pattern, limit) as SearchRow[]
  }

  return c.json({ results: rows.map(mapRow) })
})

app.get('/api/organizations/:orgnr/locate', async (c) => {
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

app.get('/api/organizations/:orgnr/konsern', async (c) => {
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

const BATCH_ORG_MAX = 100

/** One round-trip for address popups listing many orgs at the same marker. */
app.post('/api/organizations/batch', async (c) => {
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
  ].slice(0, BATCH_ORG_MAX)

  if (orgnrs.length === 0) {
    return c.json({ organizations: [] })
  }

  const placeholders = orgnrs.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT ${ORG_DETAIL_SELECT}
       FROM organizations
       WHERE deleted = 0 AND orgnr IN (${placeholders})`,
    )
    .all(...orgnrs) as OrganizationDetailRow[]

  const byOrgnr = new Map(rows.map((row) => [row.orgnr, organizationFromDetailRow(row)]))
  const organizations = orgnrs
    .map((orgnr) => byOrgnr.get(orgnr))
    .filter((org): org is NonNullable<typeof org> => org != null)

  return c.json({ organizations })
})

app.get('/api/organizations/:orgnr', (c) => {
  const orgnr = c.req.param('orgnr')
  const row = stmtOrgByOrgnr.get(orgnr) as OrganizationDetailRow | undefined

  if (!row) {
    return c.json({ error: 'Organisasjon ikke funnet' }, 404)
  }

  return c.json({
    organization: organizationFromDetailRow(row),
  })
})

app.get('/api/organizations', (c) => {
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
    rows = db
      .prepare(
        `SELECT o.orgnr, o.navn, o.org_type, o.org_type_label, o.address_text, o.postnummer,
                o.kommunenummer, o.lat, o.lng
         FROM organizations o
         INNER JOIN orgs_rtree r ON r.id = o.rowid
         WHERE r.maxLng >= ? AND r.minLng <= ?
           AND r.maxLat >= ? AND r.minLat <= ?
           AND ${query.conditions.join(' AND ')}
         LIMIT ?`,
      )
      .all(minLng, maxLng, minLat, maxLat, ...query.params, limit) as typeof rows
  } else {
    appendBboxFilter(filters.bbox, query.conditions, query.params, 'o')
    rows = db
      .prepare(
        `SELECT o.orgnr, o.navn, o.org_type, o.org_type_label, o.address_text, o.postnummer,
                o.kommunenummer, o.lat, o.lng
         FROM organizations o
         WHERE ${query.conditions.join(' AND ')}
         LIMIT ?`,
      )
      .all(...query.params, limit) as typeof rows
  }

  const organizations = rows.map((row) => ({
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
    organizations,
    count: organizations.length,
    truncated: organizations.length >= limit,
  })
})

const port = Number(process.env.PORT ?? 3001)

console.log(`API server on http://localhost:${port}`)
console.log(`Database: ${dbPath}`)

serve({ fetch: app.fetch, port })

// Build O(log N) address index after listen so the port opens immediately.
setImmediate(() => {
  try {
    warmAddressSpatialIndex(db)
  } catch (error) {
    console.error('Failed to warm address spatial index', error)
  }
})

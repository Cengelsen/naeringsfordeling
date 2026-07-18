import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { openDatabase, DEFAULT_DB_PATH, getStats } from '../scripts/lib/db.js'
import {
  appendAreaFilters,
  appendBboxFilter,
  buildFilterQuery,
  limitForZoom,
  parseFilters,
  rtreeBboxParams,
} from './filters.js'
import { toCompactPoint, roundCoord, type CompactPoint } from '../scripts/lib/points.js'

const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`)
  console.error('Run yarn sync:full or yarn download-db first.')
  process.exit(1)
}

const db = openDatabase(dbPath)
const app = new Hono()

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

function queryOrganizationPoints(
  filters: ReturnType<typeof parseFilters>,
  limit: number,
) {
  const query = organizationQuery(filters)

  if (query.useRtree) {
    const [minLng, maxLng, minLat, maxLat] = rtreeBboxParams(query.bbox)
    return db
      .prepare(
        `SELECT o.orgnr, o.org_type, o.lat, o.lng
         FROM organizations o
         INNER JOIN orgs_rtree r ON r.id = o.rowid
         WHERE r.maxLng >= ? AND r.minLng <= ?
           AND r.maxLat >= ? AND r.minLat <= ?
           AND ${query.conditions.join(' AND ')}
         LIMIT ?`,
      )
      .all(minLng, maxLng, minLat, maxLat, ...query.params, limit) as Array<{
      orgnr: string
      org_type: string
      lat: number
      lng: number
    }>
  }

  appendBboxFilter(filters.bbox, query.conditions, query.params, 'o')
  return db
    .prepare(
      `SELECT o.orgnr, o.org_type, o.lat, o.lng
       FROM organizations o
       WHERE ${query.conditions.join(' AND ')}
       LIMIT ?`,
    )
    .all(...query.params, limit) as Array<{
    orgnr: string
    org_type: string
    lat: number
    lng: number
  }>
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
  const rows = db
    .prepare(
      `SELECT org_type AS kode, MIN(org_type_label) AS beskrivelse, COUNT(*) AS count
       FROM organizations
       WHERE deleted = 0
       GROUP BY org_type
       ORDER BY beskrivelse`,
    )
    .all() as Array<{ kode: string; beskrivelse: string; count: number }>

  return c.json({ organisasjonsformer: rows.map(({ kode, beskrivelse }) => ({ kode, beskrivelse })) })
})

app.get('/api/kommuner', (c) => {
  const rows = db
    .prepare(
      `SELECT kommunenummer AS nummer, COUNT(*) AS count
       FROM organizations
       WHERE deleted = 0 AND kommunenummer IS NOT NULL
       GROUP BY kommunenummer
       ORDER BY kommunenummer`,
    )
    .all() as Array<{ nummer: string; count: number }>

  return c.json({ kommuner: rows })
})

app.get('/api/municipality-counts', (c) => {
  const filters = parseFilters(c.req)
  const { conditions, params } = buildFilterQuery(filters, false)
  appendAreaFilters(filters, conditions, params)

  const rows = db
    .prepare(
      `SELECT kommunenummer, COUNT(*) AS count
       FROM organizations
       WHERE ${conditions.join(' AND ')} AND kommunenummer IS NOT NULL
       GROUP BY kommunenummer`,
    )
    .all(...params) as Array<{ kommunenummer: string; count: number }>

  return c.json({
    counts: rows.map((row) => ({
      kommunenummer: row.kommunenummer,
      count: row.count,
    })),
  })
})

app.get('/api/organizations/points', (c) => {
  const filters = parseFilters(c.req)
  const explicitLimit = Number(c.req.query('limit') ?? '')
  const limit = limitForZoom(
    filters.zoom,
    Number.isFinite(explicitLimit) ? explicitLimit : undefined,
  )
  const compact = c.req.query('format') === 'compact'
  const rows = queryOrganizationPoints(filters, limit)

  if (compact) {
    const points: CompactPoint[] = rows.map((row) =>
      toCompactPoint(row.orgnr, row.lng, row.lat, row.org_type),
    )
    return c.json({
      points,
      count: points.length,
      truncated: points.length >= limit,
    })
  }

  return c.json({
    points: rows.map((row) => ({
      orgnr: row.orgnr,
      orgType: row.org_type,
      lat: roundCoord(row.lat),
      lng: roundCoord(row.lng),
    })),
    count: rows.length,
    truncated: rows.length >= limit,
  })
})

app.get('/api/organizations/:orgnr', (c) => {
  const orgnr = c.req.param('orgnr')
  const row = db
    .prepare(
      `SELECT orgnr, navn, org_type, org_type_label, address_text, postnummer,
              kommunenummer, lat, lng
       FROM organizations
       WHERE deleted = 0 AND orgnr = ?`,
    )
    .get(orgnr) as
    | {
        orgnr: string
        navn: string
        org_type: string
        org_type_label: string
        address_text: string
        postnummer: string
        kommunenummer: string
        lat: number | null
        lng: number | null
      }
    | undefined

  if (!row) {
    return c.json({ error: 'Organisasjon ikke funnet' }, 404)
  }

  return c.json({
    organization: {
      orgnr: row.orgnr,
      navn: row.navn,
      orgType: row.org_type,
      orgTypeLabel: row.org_type_label,
      addressText: row.address_text,
      postnummer: row.postnummer,
      kommunenummer: row.kommunenummer,
      lat: row.lat,
      lng: row.lng,
    },
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

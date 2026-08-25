import { Hono } from 'hono'
import { effectiveKommunenummerExpr } from '../../scripts/lib/db.js'
import { getContext } from '../context.js'
import { appendAreaFilters, buildFilterQuery, parseFilters } from '../filters.js'
import { maybeNotModified, resourceEtag } from '../httpCache.js'
import { queryViewportSummary } from '../viewport-summary.js'

const VIEWPORT_MAX_AGE = 20

const geography = new Hono()

geography.get('/api/municipality-counts', (c) => {
  const { cachedPrepare } = getContext()
  const filters = parseFilters(c.req)
  const { conditions, params } = buildFilterQuery(filters, false)
  appendAreaFilters(filters, conditions, params)

  const kommuneExpr = effectiveKommunenummerExpr()
  const rows = cachedPrepare(
    `SELECT ${kommuneExpr} AS kommunenummer, COUNT(*) AS count
     FROM organizations
     WHERE ${conditions.join(' AND ')} AND ${kommuneExpr} IS NOT NULL
     GROUP BY ${kommuneExpr}`,
  ).all(...params) as Array<{ kommunenummer: string; count: number }>

  return c.json({
    counts: rows.map((row) => ({
      kommunenummer: row.kommunenummer,
      count: row.count,
    })),
  })
})

geography.get('/api/district-stats', (c) => {
  const { cachedPrepare } = getContext()
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

  const rows = cachedPrepare(
    `SELECT org_type, COUNT(*) AS count
     FROM organizations
     WHERE ${conditions.join(' AND ')} AND ${kommuneExpr} IS NOT NULL
     GROUP BY org_type`,
  ).all(...params) as Array<{ org_type: string; count: number }>

  const byOrgType: Record<string, number> = {}
  let total = 0
  for (const row of rows) {
    byOrgType[row.org_type] = row.count
    total += row.count
  }

  return c.json({ total, byOrgType })
})

geography.get('/api/viewport-summary', async (c) => {
  const { db } = getContext()
  const filters = parseFilters(c.req)
  if (!filters.bbox) {
    return c.json({ error: 'bbox query parameter is required' }, 400)
  }

  const notModified = maybeNotModified(c, {
    etag: resourceEtag('viewport-summary', c.req.url),
    maxAge: VIEWPORT_MAX_AGE,
  })
  if (notModified) return notModified

  const summary = await queryViewportSummary(db, filters, filters.zoom)
  return c.json({ summary })
})

export default geography

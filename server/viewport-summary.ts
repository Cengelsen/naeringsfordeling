import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { effectiveKommunenummerExpr } from '../scripts/lib/db.js'
import {
  appendAreaFilters,
  buildFilterQuery,
  rtreeBboxParams,
  type ApiFilters,
} from './filters.js'

export interface ViewportSummary {
  totalInViewport: number
  geocodedInBbox: number
  ungeocodedInViewport: number
  byOrgType: Record<string, number>
  renderMode: 'aggregate' | 'individual'
  kommunerInViewport: number
}

interface GeoBounds {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

type GeoJsonFeature = {
  properties?: { kommunenummer?: string }
  geometry?: {
    type: string
    coordinates: number[][][] | number[][][][]
  }
}

let kommuneBoundsCache: Map<string, GeoBounds> | null = null

function geoBoundsIntersects(a: GeoBounds, b: GeoBounds): boolean {
  return !(
    a.maxLat < b.minLat ||
    a.minLat > b.maxLat ||
    a.maxLng < b.minLng ||
    a.minLng > b.maxLng
  )
}

function extendBounds(bounds: GeoBounds, lat: number, lng: number) {
  bounds.minLat = Math.min(bounds.minLat, lat)
  bounds.maxLat = Math.max(bounds.maxLat, lat)
  bounds.minLng = Math.min(bounds.minLng, lng)
  bounds.maxLng = Math.max(bounds.maxLng, lng)
}

function ringBounds(ring: number[][]): GeoBounds | null {
  if (ring.length === 0) return null
  const bounds: GeoBounds = {
    minLat: ring[0]![1]!,
    maxLat: ring[0]![1]!,
    minLng: ring[0]![0]!,
    maxLng: ring[0]![0]!,
  }
  for (const [lng, lat] of ring) {
    extendBounds(bounds, lat!, lng!)
  }
  return bounds
}

function featureBounds(feature: GeoJsonFeature): GeoBounds | null {
  const geometry = feature.geometry
  if (!geometry) return null

  if (geometry.type === 'Polygon') {
    return ringBounds(geometry.coordinates[0] as number[][])
  }

  if (geometry.type === 'MultiPolygon') {
    let merged: GeoBounds | null = null
    for (const polygon of geometry.coordinates as number[][][][]) {
      const part = ringBounds(polygon[0]!)
      if (!part) continue
      if (!merged) {
        merged = { ...part }
        continue
      }
      extendBounds(merged, part.minLat, part.minLng)
      extendBounds(merged, part.maxLat, part.maxLng)
    }
    return merged
  }

  return null
}

function loadKommuneBoundsIndex(): Map<string, GeoBounds> {
  if (kommuneBoundsCache) return kommuneBoundsCache

  const geojsonPath = join(process.cwd(), 'public/data/kommuner.geojson')
  if (!existsSync(geojsonPath)) {
    kommuneBoundsCache = new Map()
    return kommuneBoundsCache
  }

  const geojson = JSON.parse(readFileSync(geojsonPath, 'utf8')) as {
    features: GeoJsonFeature[]
  }

  const index = new Map<string, GeoBounds>()
  for (const feature of geojson.features) {
    const kommunenummer = feature.properties?.kommunenummer
    if (!kommunenummer) continue
    const bounds = featureBounds(feature)
    if (bounds) index.set(kommunenummer, bounds)
  }

  kommuneBoundsCache = index
  return index
}

export function kommunerIntersectingBbox(bbox: [number, number, number, number]): string[] {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const viewport: GeoBounds = { minLng, minLat, maxLng, maxLat }
  const index = loadKommuneBoundsIndex()
  const matches: string[] = []

  for (const [kommunenummer, bounds] of index.entries()) {
    if (geoBoundsIntersects(viewport, bounds)) {
      matches.push(kommunenummer)
    }
  }

  return matches.sort()
}

export function queryViewportSummary(
  db: Database.Database,
  filters: ApiFilters,
  zoom?: number,
): ViewportSummary {
  if (!filters.bbox) {
    throw new Error('bbox is required')
  }

  const detailMinZoom = 12
  const renderMode: ViewportSummary['renderMode'] =
    zoom != null && zoom >= detailMinZoom ? 'individual' : 'aggregate'

  const kommuner = kommunerIntersectingBbox(filters.bbox)
  const kommuneExpr = effectiveKommunenummerExpr()

  const { conditions: geocodedConditions, params: geocodedParams } = buildFilterQuery(
    filters,
    true,
    'o',
  )
  appendAreaFilters(filters, geocodedConditions, geocodedParams, 'o')

  const [minLng, maxLng, minLat, maxLat] = rtreeBboxParams(filters.bbox)

  const geocodedRow = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM organizations o
       INNER JOIN orgs_rtree r ON r.id = o.rowid
       WHERE r.maxLng >= ? AND r.minLng <= ?
         AND r.maxLat >= ? AND r.minLat <= ?
         AND ${geocodedConditions.join(' AND ')}`,
    )
    .get(minLng, maxLng, minLat, maxLat, ...geocodedParams) as { count: number }

  const typeRows = db
    .prepare(
      `SELECT o.org_type AS org_type, COUNT(*) AS count
       FROM organizations o
       INNER JOIN orgs_rtree r ON r.id = o.rowid
       WHERE r.maxLng >= ? AND r.minLng <= ?
         AND r.maxLat >= ? AND r.minLat <= ?
         AND ${geocodedConditions.join(' AND ')}
       GROUP BY o.org_type`,
    )
    .all(minLng, maxLng, minLat, maxLat, ...geocodedParams) as Array<{
    org_type: string
    count: number
  }>

  const byOrgType: Record<string, number> = {}
  for (const row of typeRows) {
    byOrgType[row.org_type] = row.count
  }

  let totalInViewport = geocodedRow.count

  if (kommuner.length > 0) {
    const { conditions: allConditions, params: allParams } = buildFilterQuery(filters, false, 'o')
    allConditions.push(`${kommuneExpr} IN (${kommuner.map(() => '?').join(',')})`)
    allParams.push(...kommuner)

    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM organizations o
         WHERE ${allConditions.join(' AND ')}`,
      )
      .get(...allParams) as { count: number }

    totalInViewport = totalRow.count
  } else {
    totalInViewport = geocodedRow.count
  }

  const geocodedInBbox = geocodedRow.count
  const ungeocodedInViewport = Math.max(0, totalInViewport - geocodedInBbox)

  return {
    totalInViewport,
    geocodedInBbox,
    ungeocodedInViewport,
    byOrgType,
    renderMode,
    kommunerInViewport: kommuner.length,
  }
}

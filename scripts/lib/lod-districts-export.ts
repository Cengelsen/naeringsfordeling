import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson'
import { union } from 'polyclip-ts'
import type Database from 'better-sqlite3'
import { effectiveKommunenummerExpr } from './db.js'

export type DistrictLevel = 'fylke' | 'kommune'
export type DistrictGeometry = Polygon | MultiPolygon
export type OrgTypeCounts = Map<string, number>

export interface DistrictFeature {
  districtId: string
  label: string
  geometry: DistrictGeometry
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }
}

const FYLKE_NAMES: Record<string, string> = {
  '03': 'Oslo',
  '11': 'Rogaland',
  '15': 'Møre og Romsdal',
  '18': 'Nordland',
  '21': 'Svalbard',
  '22': 'Jan Mayen',
  '30': 'Viken',
  '31': 'Østfold',
  '32': 'Akershus',
  '33': 'Buskerud',
  '34': 'Innlandet',
  '38': 'Vestfold og Telemark',
  '39': 'Vestfold',
  '40': 'Telemark',
  '42': 'Agder',
  '46': 'Vestland',
  '50': 'Trøndelag',
  '54': 'Troms og Finnmark',
  '55': 'Troms',
  '56': 'Finnmark',
}

function fylkeFromKommune(kommunenummer: string): string {
  return kommunenummer.slice(0, 2)
}

function geometryToMultiPolygonCoords(geometry: Geometry): Polygon['coordinates'][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates
  return []
}

function ringBounds(ring: number[][]): DistrictFeature['bounds'] | null {
  if (ring.length === 0) return null
  const bounds = {
    minLat: ring[0]![1]!,
    maxLat: ring[0]![1]!,
    minLng: ring[0]![0]!,
    maxLng: ring[0]![0]!,
  }
  for (const [lng, lat] of ring) {
    bounds.minLat = Math.min(bounds.minLat, lat!)
    bounds.maxLat = Math.max(bounds.maxLat, lat!)
    bounds.minLng = Math.min(bounds.minLng, lng!)
    bounds.maxLng = Math.max(bounds.maxLng, lng!)
  }
  return bounds
}

function featureBounds(geometry: DistrictGeometry): DistrictFeature['bounds'] | null {
  if (geometry.type === 'Polygon') {
    return ringBounds(geometry.coordinates[0]!)
  }
  let merged: DistrictFeature['bounds'] | null = null
  for (const polygon of geometry.coordinates) {
    const part = ringBounds(polygon[0]!)
    if (!part) continue
    if (!merged) {
      merged = { ...part }
      continue
    }
    merged.minLat = Math.min(merged.minLat, part.minLat)
    merged.maxLat = Math.max(merged.maxLat, part.maxLat)
    merged.minLng = Math.min(merged.minLng, part.minLng)
    merged.maxLng = Math.max(merged.maxLng, part.maxLng)
  }
  return merged
}

function loadKommuneGeojson(): FeatureCollection {
  const geojsonPath = join(process.cwd(), 'public/data/kommuner.geojson')
  if (!existsSync(geojsonPath)) {
    throw new Error(`Missing ${geojsonPath}. Run yarn download-kommuner first.`)
  }
  return JSON.parse(readFileSync(geojsonPath, 'utf8')) as FeatureCollection
}

export function buildDistrictFeatures(level: DistrictLevel): DistrictFeature[] {
  const geojson = loadKommuneGeojson()
  const districts: DistrictFeature[] = []

  if (level === 'kommune') {
    for (const feature of geojson.features) {
      const kommunenummer = feature.properties?.kommunenummer as string | undefined
      if (!kommunenummer || feature.geometry.type === 'GeometryCollection') continue
      const geometry = feature.geometry as DistrictGeometry
      const bounds = featureBounds(geometry)
      if (!bounds) continue
      districts.push({
        districtId: kommunenummer,
        label: (feature.properties?.kommunenavn as string | undefined) ?? kommunenummer,
        geometry,
        bounds,
      })
    }
    return districts.sort((a, b) => a.districtId.localeCompare(b.districtId))
  }

  const byFylke = new Map<string, Polygon['coordinates'][][]>()
  for (const feature of geojson.features) {
    const kommunenummer = feature.properties?.kommunenummer as string | undefined
    if (!kommunenummer || feature.geometry.type === 'GeometryCollection') continue
    const fylkesnummer = fylkeFromKommune(kommunenummer)
    const geoms = byFylke.get(fylkesnummer) ?? []
    geoms.push(geometryToMultiPolygonCoords(feature.geometry))
    byFylke.set(fylkesnummer, geoms)
  }

  for (const [fylkesnummer, geoms] of byFylke.entries()) {
    if (geoms.length === 0) continue
    const merged = union(...(geoms as Parameters<typeof union>))
    if (merged.length === 0) continue
    const geometry: DistrictGeometry =
      merged.length === 1
        ? { type: 'Polygon', coordinates: merged[0]! }
        : { type: 'MultiPolygon', coordinates: merged }
    const bounds = featureBounds(geometry)
    if (!bounds) continue
    districts.push({
      districtId: fylkesnummer,
      label: FYLKE_NAMES[fylkesnummer] ?? `Fylke ${fylkesnummer}`,
      geometry,
      bounds,
    })
  }

  return districts.sort((a, b) => a.districtId.localeCompare(b.districtId))
}

export function loadOrgCountsByDistrict(db: Database.Database, level: DistrictLevel): Map<string, OrgTypeCounts> {
  const kommuneExpr = effectiveKommunenummerExpr()
  const districtExpr = level === 'fylke' ? `substr(${kommuneExpr}, 1, 2)` : kommuneExpr

  const rows = db
    .prepare(
      `SELECT ${districtExpr} AS district_id, org_type, COUNT(*) AS count
       FROM organizations
       WHERE deleted = 0
         AND konkurs = 0
         AND under_avvikling = 0
         AND lat IS NOT NULL
         AND lng IS NOT NULL
         AND entity_kind = 'enhet'
         AND ${kommuneExpr} IS NOT NULL
       GROUP BY ${districtExpr}, org_type`,
    )
    .all() as Array<{ district_id: string; org_type: string; count: number }>

  const byDistrict = new Map<string, OrgTypeCounts>()
  for (const row of rows) {
    if (!row.district_id) continue
    let bucket = byDistrict.get(row.district_id)
    if (!bucket) {
      bucket = new Map()
      byDistrict.set(row.district_id, bucket)
    }
    bucket.set(row.org_type, (bucket.get(row.org_type) ?? 0) + row.count)
  }

  return byDistrict
}

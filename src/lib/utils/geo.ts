import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson'
import { union } from 'polyclip-ts'
import type { FylkeFeatureProperties, KommuneFeatureProperties } from '../types'

export type KommuneFeature = Feature<Geometry, KommuneFeatureProperties>
export type FylkeFeature = Feature<Polygon | MultiPolygon, FylkeFeatureProperties>

export function fylkeFromKommune(kommunenummer: string): string {
  return kommunenummer.slice(0, 2)
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

export function fylkeName(kode: string): string {
  return FYLKE_NAMES[kode] ?? `Fylke ${kode}`
}

export function kommuneFeatures(geojson: FeatureCollection): KommuneFeature[] {
  return geojson.features as KommuneFeature[]
}

function geometryToMultiPolygonCoords(geometry: Geometry): Polygon['coordinates'][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates
  return []
}

/** Dissolve kommune polygons into one feature per fylke (cached per input reference). */
const fylkeGeojsonCache = new WeakMap<FeatureCollection, FeatureCollection<Polygon | MultiPolygon, FylkeFeatureProperties>>()

export function buildFylkeGeojson(
  kommunerGeojson: FeatureCollection,
): FeatureCollection<Polygon | MultiPolygon, FylkeFeatureProperties> {
  const cached = fylkeGeojsonCache.get(kommunerGeojson)
  if (cached) return cached

  const byFylke = new Map<string, Polygon['coordinates'][][]>()
  for (const feature of kommuneFeatures(kommunerGeojson)) {
    const kode = fylkeFromKommune(feature.properties.kommunenummer)
    const geoms = byFylke.get(kode) ?? []
    geoms.push(geometryToMultiPolygonCoords(feature.geometry))
    byFylke.set(kode, geoms)
  }

  const features: FylkeFeature[] = []
  for (const [fylkesnummer, geoms] of byFylke) {
    if (geoms.length === 0) continue
    const merged = union(...(geoms as Parameters<typeof union>))
    if (merged.length === 0) continue

    features.push({
      type: 'Feature',
      properties: {
        fylkesnummer,
        fylkesnavn: fylkeName(fylkesnummer),
      },
      geometry:
        merged.length === 1
          ? { type: 'Polygon', coordinates: merged[0] }
          : { type: 'MultiPolygon', coordinates: merged },
    })
  }

  features.sort((a, b) => a.properties.fylkesnummer.localeCompare(b.properties.fylkesnummer))

  const collection: FeatureCollection<Polygon | MultiPolygon, FylkeFeatureProperties> = {
    type: 'FeatureCollection',
    features,
  }
  fylkeGeojsonCache.set(kommunerGeojson, collection)
  return collection
}

export interface GeoBounds {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

export function geoBoundsIntersects(a: GeoBounds, b: GeoBounds): boolean {
  return !(
    a.maxLat < b.minLat ||
    a.minLat > b.maxLat ||
    a.maxLng < b.minLng ||
    a.minLng > b.maxLng
  )
}

export function geoBoundsCenter(bounds: GeoBounds): [lat: number, lng: number] {
  return [(bounds.minLat + bounds.maxLat) / 2, (bounds.minLng + bounds.maxLng) / 2]
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
    minLat: ring[0][1],
    maxLat: ring[0][1],
    minLng: ring[0][0],
    maxLng: ring[0][0],
  }

  for (const [lng, lat] of ring) {
    extendBounds(bounds, lat, lng)
  }

  return bounds
}

export function featureGeoBounds(feature: KommuneFeature): GeoBounds | null {
  const geometry = feature.geometry

  if (geometry.type === 'Polygon') {
    return ringBounds(geometry.coordinates[0])
  }

  if (geometry.type === 'MultiPolygon') {
    let merged: GeoBounds | null = null
    for (const polygon of geometry.coordinates) {
      const part = ringBounds(polygon[0])
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

export function kommuneBoundsIndex(geojson: FeatureCollection): Map<string, GeoBounds> {
  const index = new Map<string, GeoBounds>()
  for (const feature of kommuneFeatures(geojson)) {
    const bounds = featureGeoBounds(feature)
    if (bounds) {
      index.set(feature.properties.kommunenummer, bounds)
    }
  }
  return index
}

import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { KommuneFeatureProperties } from '../types'

export type KommuneFeature = Feature<Geometry, KommuneFeatureProperties>

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

export function centroid(feature: KommuneFeature): [number, number] {
  const geometry = feature.geometry
  let sumLat = 0
  let sumLng = 0
  let count = 0

  const addRing = (ring: number[][]) => {
    for (const [lng, lat] of ring) {
      sumLng += lng
      sumLat += lat
      count += 1
    }
  }

  if (geometry.type === 'Polygon') {
    addRing(geometry.coordinates[0])
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      addRing(polygon[0])
    }
  }

  if (count === 0) return [0, 0]
  return [sumLat / count, sumLng / count]
}

export function kommuneFeatures(geojson: FeatureCollection): KommuneFeature[] {
  return geojson.features as KommuneFeature[]
}

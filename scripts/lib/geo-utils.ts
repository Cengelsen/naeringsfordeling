import type { MultiPolygon, Polygon } from 'geojson'

export type Bounds = {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

export type AreaGeometry = Polygon | MultiPolygon

export function ringBounds(ring: number[][]): Bounds | null {
  if (ring.length === 0) return null
  const bounds: Bounds = {
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

export function geometryBounds(geometry: AreaGeometry): Bounds | null {
  if (geometry.type === 'Polygon') {
    return ringBounds(geometry.coordinates[0]!)
  }
  let merged: Bounds | null = null
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

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!
    const yi = ring[i]![1]!
    const xj = ring[j]![0]!
    const yj = ring[j]![1]!
    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function pointInPolygonCoords(lng: number, lat: number, coordinates: Polygon['coordinates']): boolean {
  if (!pointInRing(lng, lat, coordinates[0]!)) return false
  for (let hole = 1; hole < coordinates.length; hole++) {
    if (pointInRing(lng, lat, coordinates[hole]!)) return false
  }
  return true
}

export function pointInGeometry(lng: number, lat: number, geometry: AreaGeometry): boolean {
  if (geometry.type === 'Polygon') {
    return pointInPolygonCoords(lng, lat, geometry.coordinates)
  }
  return geometry.coordinates.some((polygon) => pointInPolygonCoords(lng, lat, polygon))
}

export function pointInBounds(lng: number, lat: number, bounds: Bounds): boolean {
  return (
    lat >= bounds.minLat &&
    lat <= bounds.maxLat &&
    lng >= bounds.minLng &&
    lng <= bounds.maxLng
  )
}

function roundCoordinate(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function roundNestedCoordinates(coords: unknown, digits: number): unknown {
  if (!Array.isArray(coords)) return coords
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    return [roundCoordinate(coords[0], digits), roundCoordinate(coords[1], digits)]
  }
  return coords.map((part) => roundNestedCoordinates(part, digits))
}

export function roundGeometryCoordinates(geometry: AreaGeometry, digits = 5): AreaGeometry {
  return {
    type: geometry.type,
    coordinates: roundNestedCoordinates(geometry.coordinates, digits) as AreaGeometry['coordinates'],
  }
}

const GRID_DEG = 0.05

function gridKeysForBounds(bounds: Bounds): string[] {
  const keys: string[] = []
  const minLatIdx = Math.floor(bounds.minLat / GRID_DEG)
  const maxLatIdx = Math.floor(bounds.maxLat / GRID_DEG)
  const minLngIdx = Math.floor(bounds.minLng / GRID_DEG)
  const maxLngIdx = Math.floor(bounds.maxLng / GRID_DEG)
  for (let latIdx = minLatIdx; latIdx <= maxLatIdx; latIdx++) {
    for (let lngIdx = minLngIdx; lngIdx <= maxLngIdx; lngIdx++) {
      keys.push(`${latIdx}_${lngIdx}`)
    }
  }
  return keys
}

export function buildSpatialGridIndex<T extends { bounds: Bounds }>(
  items: T[],
): Map<string, T[]> {
  const index = new Map<string, T[]>()
  for (const item of items) {
    for (const key of gridKeysForBounds(item.bounds)) {
      let bucket = index.get(key)
      if (!bucket) {
        bucket = []
        index.set(key, bucket)
      }
      bucket.push(item)
    }
  }
  return index
}

export function findItemAtLocation<T extends { bounds: Bounds; geometry: AreaGeometry }>(
  index: Map<string, T[]>,
  lat: number,
  lng: number,
): T | null {
  const latIdx = Math.floor(lat / GRID_DEG)
  const lngIdx = Math.floor(lng / GRID_DEG)

  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      const bucket = index.get(`${latIdx + dLat}_${lngIdx + dLng}`)
      if (!bucket) continue
      for (const item of bucket) {
        if (!pointInBounds(lng, lat, item.bounds)) continue
        if (pointInGeometry(lng, lat, item.geometry)) return item
      }
    }
  }

  return null
}

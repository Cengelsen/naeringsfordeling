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

export function extendBounds(bounds: GeoBounds, lat: number, lng: number) {
  bounds.minLat = Math.min(bounds.minLat, lat)
  bounds.maxLat = Math.max(bounds.maxLat, lat)
  bounds.minLng = Math.min(bounds.minLng, lng)
  bounds.maxLng = Math.max(bounds.maxLng, lng)
}

export function ringBounds(ring: number[][]): GeoBounds | null {
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

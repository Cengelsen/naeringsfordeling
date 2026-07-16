import type { CompactPoint } from './points.js'

/** Kommuner with at least this many points are split into a lat/lng grid. */
export const GRID_KOMMUNE_THRESHOLD = 10_000

/** Grid cell size in decimal degrees (~4 km in Norway). */
export const GRID_CELL_DEG = 0.04

export function gridCellId(lat: number, lng: number, cellDeg = GRID_CELL_DEG): string {
  const latIdx = Math.floor(lat / cellDeg)
  const lngIdx = Math.floor(lng / cellDeg)
  return `${latIdx}_${lngIdx}`
}

export function gridCellsForBbox(
  bbox: [number, number, number, number],
  cellDeg = GRID_CELL_DEG,
): string[] {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const minLatIdx = Math.floor(minLat / cellDeg)
  const maxLatIdx = Math.floor(maxLat / cellDeg)
  const minLngIdx = Math.floor(minLng / cellDeg)
  const maxLngIdx = Math.floor(maxLng / cellDeg)

  const cells: string[] = []
  for (let latIdx = minLatIdx; latIdx <= maxLatIdx; latIdx++) {
    for (let lngIdx = minLngIdx; lngIdx <= maxLngIdx; lngIdx++) {
      cells.push(`${latIdx}_${lngIdx}`)
    }
  }
  return cells
}

export function shouldGridKommune(pointCount: number, threshold = GRID_KOMMUNE_THRESHOLD): boolean {
  return pointCount >= threshold
}

export function groupPointsByGrid(
  points: CompactPoint[],
  cellDeg = GRID_CELL_DEG,
): Map<string, CompactPoint[]> {
  const grouped = new Map<string, CompactPoint[]>()
  for (const point of points) {
    const [, lng, lat] = point
    const cell = gridCellId(lat, lng, cellDeg)
    const bucket = grouped.get(cell) ?? []
    bucket.push(point)
    grouped.set(cell, bucket)
  }
  return grouped
}

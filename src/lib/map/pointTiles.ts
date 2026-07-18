import type { OrganizationPoint } from '../types'
import { assetUrl } from '../utils/assets'
import { filterPointsInBbox, fromCompactPoints, type CompactPoint } from './points'

/** Kommuner with at least this many points are split into a lat/lng grid. */
export const GRID_KOMMUNE_THRESHOLD = 10_000

/** Grid cell size in decimal degrees (~4 km in Norway). */
export const GRID_CELL_DEG = 0.04

export interface PointsIndexEntry {
  kommunenummer: string
  count: number
  gridded: boolean
}

export interface PointsIndex {
  total: number
  cellDeg: number
  gridThreshold: number
  kommuner: PointsIndexEntry[]
}

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

let pointsIndexPromise: Promise<PointsIndex | null> | null = null

export async function loadPointsIndex(): Promise<PointsIndex | null> {
  if (!pointsIndexPromise) {
    pointsIndexPromise = fetch(assetUrl('data/points/index.json'))
      .then(async (response) => {
        if (!response.ok) return null
        return (await response.json()) as PointsIndex
      })
      .catch(() => null)
  }
  return pointsIndexPromise
}

export function resetPointsIndexCache() {
  pointsIndexPromise = null
}

async function fetchKommuneTileFile(path: string): Promise<OrganizationPoint[] | null> {
  try {
    const response = await fetch(path)
    if (!response.ok) return null
    const data = (await response.json()) as { points: CompactPoint[] }
    return fromCompactPoints(data.points)
  } catch {
    return null
  }
}

async function fetchKommuneMonolith(kommunenummer: string): Promise<OrganizationPoint[] | null> {
  return fetchKommuneTileFile(assetUrl(`data/points/${kommunenummer}.json`))
}

async function fetchKommuneGridCells(
  kommunenummer: string,
  bbox: [number, number, number, number],
  cellDeg: number,
): Promise<OrganizationPoint[] | null> {
  const cells = gridCellsForBbox(bbox, cellDeg)
  const results = await Promise.all(
    cells.map((cell) => fetchKommuneTileFile(assetUrl(`data/points/${kommunenummer}/${cell}.json`))),
  )

  const loaded = results.filter((result): result is OrganizationPoint[] => result != null)
  if (loaded.length === 0) return null

  return loaded.flat()
}

export async function fetchKommunePointsForViewport(
  kommunenummer: string,
  bbox: [number, number, number, number],
): Promise<OrganizationPoint[] | null> {
  const index = await loadPointsIndex()
  const entry = index?.kommuner.find((item) => item.kommunenummer === kommunenummer)

  if (entry?.gridded) {
    const cellDeg = index?.cellDeg ?? GRID_CELL_DEG
    const gridded = await fetchKommuneGridCells(kommunenummer, bbox, cellDeg)
    if (gridded) return filterPointsInBbox(gridded, bbox)
  }

  const monolith = await fetchKommuneMonolith(kommunenummer)
  if (!monolith) return null
  return filterPointsInBbox(monolith, bbox)
}

export async function fetchViewportPointTiles(
  kommunenumre: string[],
  bbox: [number, number, number, number],
): Promise<OrganizationPoint[] | null> {
  if (kommunenumre.length === 0) return null

  const results = await Promise.all(
    kommunenumre.map((kommunenummer) => fetchKommunePointsForViewport(kommunenummer, bbox)),
  )

  if (results.every((result) => result == null)) return null
  return results.flatMap((result) => result ?? [])
}

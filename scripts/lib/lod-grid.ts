/** LOD grid cell sizes in decimal degrees. */
export const LOD_CELL_DEG = {
  coarse: 0.32,
  medium: 0.08,
  fine: 0.02,
} as const

export type LodBand = keyof typeof LOD_CELL_DEG

export const LOD_BANDS: LodBand[] = ['coarse', 'medium', 'fine']

export const LOD_LAYER_NAMES = {
  coarse: 'cells_coarse',
  medium: 'cells_medium',
  fine: 'cells_fine',
  points: 'organizations',
} as const

export const LOD_ZOOM_RANGES = {
  coarse: { minZoom: 4, maxZoom: 7 },
  medium: { minZoom: 7, maxZoom: 10 },
  fine: { minZoom: 10, maxZoom: 12 },
  points: { minZoom: 12, maxZoom: 16 },
} as const

export function gridCellId(lat: number, lng: number, cellDeg: number): string {
  const latIdx = Math.floor(lat / cellDeg)
  const lngIdx = Math.floor(lng / cellDeg)
  return `${latIdx}_${lngIdx}`
}

export function gridCellCentroid(cellId: string, cellDeg: number): [lng: number, lat: number] {
  const [latIdxRaw, lngIdxRaw] = cellId.split('_')
  const latIdx = Number(latIdxRaw)
  const lngIdx = Number(lngIdxRaw)
  const lat = (latIdx + 0.5) * cellDeg
  const lng = (lngIdx + 0.5) * cellDeg
  return [lng, lat]
}

export function cellDegForBand(band: LodBand): number {
  return LOD_CELL_DEG[band]
}

export function layerNameForBand(band: LodBand): string {
  return LOD_LAYER_NAMES[band]
}

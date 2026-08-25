export type Bbox = [minLng: number, minLat: number, maxLng: number, maxLat: number]

/** Web-mercator tile x/y range covering a WGS84 bbox at zoom z. */
export function tileRangeForBbox(
  west: number,
  south: number,
  east: number,
  north: number,
  z: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const zoom = Math.max(0, Math.floor(z))
  const n = 2 ** zoom
  const lonToX = (lon: number) => Math.floor(((lon + 180) / 360) * n)
  const latToY = (lat: number) => {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat))
    const rad = (clamped * Math.PI) / 180
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
  }
  const minX = Math.max(0, lonToX(west))
  const maxX = Math.min(n - 1, lonToX(east))
  const minY = Math.max(0, latToY(north))
  const maxY = Math.min(n - 1, latToY(south))
  return { minX, maxX, minY, maxY }
}

function tileToLng(x: number, z: number): number {
  const n = 2 ** z
  return (x / n) * 360 - 180
}

function tileToLat(y: number, z: number): number {
  const n = 2 ** z
  const rad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  return (rad * 180) / Math.PI
}

/**
 * Expand a viewport bbox to the web-mercator tile bounds that cover it at `zoom`.
 * Exclusive edges are inset by a tiny epsilon so snapping twice is a no-op.
 */
export function snapBboxToTileGrid(bbox: Bbox, zoom: number): Bbox {
  const z = Math.max(0, Math.floor(zoom))
  const [west, south, east, north] = bbox
  const { minX, maxX, minY, maxY } = tileRangeForBbox(west, south, east, north, z)
  // Keep the returned box inside the covering tiles so lonToX/latToY round-trip.
  const edgeInset = 1e-9
  return [
    tileToLng(minX, z),
    tileToLat(maxY + 1, z) + edgeInset,
    tileToLng(maxX + 1, z) - edgeInset,
    tileToLat(minY, z) - edgeInset,
  ]
}

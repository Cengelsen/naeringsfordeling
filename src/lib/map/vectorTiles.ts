import maplibregl from 'maplibre-gl'
import { PMTiles, Protocol } from 'pmtiles'
import { DETAIL_MIN_ZOOM } from '../lodConfig'
import { assetUrl } from '../utils/assets'
import { tileRangeForBbox } from '../../../shared/tiles'

export { tileRangeForBbox }

export const VECTOR_TILES_PATH = assetUrl('data/points.pmtiles')
export const VECTOR_TILES_MANIFEST = assetUrl('data/points/manifest.json')
export const VECTOR_TILES_LAYER = 'organizations'
const MAX_PREFETCH_TILES_DETAIL = 120

export interface VectorTilesLayerSpec {
  name: string
  minZoom: number
  maxZoom: number
}

export interface VectorTilesManifest {
  total: number
  layer: string
  format: string
  path: string
  orgTypes: string[]
  layers?: VectorTilesLayerSpec[]
  /** True when tippecanoe kept every address (`--drop-rate=1`). */
  preserveAllPoints?: boolean
  filters: {
    excludeKonkurs: boolean
    excludeUnderAvvikling: boolean
    vatRegisteredOnly: boolean
    entityKinds?: string[]
  }
  generatedAt?: string
}

let sharedProtocol: Protocol | null = null

export function ensurePmtilesProtocol() {
  if (sharedProtocol) return
  sharedProtocol = new Protocol()
  maplibregl.addProtocol('pmtiles', sharedProtocol.tile)
}

export function vectorTilesSourceUrl(): string {
  const base = `${location.origin}${VECTOR_TILES_PATH}`
  return `pmtiles://${base}`
}

function absoluteTilesUrl(): string {
  return `${location.origin}${VECTOR_TILES_PATH}`
}

function sharedPmtiles(): PMTiles {
  ensurePmtilesProtocol()
  const url = absoluteTilesUrl()
  let tiles = sharedProtocol!.get(url)
  if (!tiles) {
    tiles = new PMTiles(url)
    sharedProtocol!.add(tiles)
  }
  return tiles
}

function padBounds(
  bounds: { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number },
  padRatio: number,
): { west: number; south: number; east: number; north: number } {
  const west = bounds.getWest()
  const south = bounds.getSouth()
  const east = bounds.getEast()
  const north = bounds.getNorth()
  const padX = (east - west) * padRatio
  const padY = (north - south) * padRatio
  return {
    west: west - padX,
    south: south - padY,
    east: east + padX,
    north: north + padY,
  }
}

/** Prefer tiles near viewport centre when the range exceeds the request budget. */
function prioritizeTiles(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  limit: number,
): Array<{ x: number; y: number }> {
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const tiles: Array<{ x: number; y: number; d: number }> = []
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      const dx = x - cx
      const dy = y - cy
      tiles.push({ x, y, d: dx * dx + dy * dy })
    }
  }
  tiles.sort((a, b) => a.d - b.d)
  return tiles.slice(0, limit).map(({ x, y }) => ({ x, y }))
}

async function prefetchZoomLevel(
  west: number,
  south: number,
  east: number,
  north: number,
  zoom: number,
  maxTiles: number,
): Promise<void> {
  const { minX, maxX, minY, maxY } = tileRangeForBbox(west, south, east, north, zoom)
  const width = maxX - minX + 1
  const height = maxY - minY + 1
  if (width <= 0 || height <= 0) return

  const selected =
    width * height <= maxTiles
      ? (() => {
          const list: Array<{ x: number; y: number }> = []
          for (let x = minX; x <= maxX; x += 1) {
            for (let y = minY; y <= maxY; y += 1) list.push({ x, y })
          }
          return list
        })()
      : prioritizeTiles(minX, maxX, minY, maxY, maxTiles)

  const tiles = sharedPmtiles()
  await Promise.all(selected.map(({ x, y }) => tiles.getZxy(zoom, x, y).catch(() => null)))
}

/**
 * Warm the shared PMTiles cache for organization tiles around the viewport.
 * Call while still on grunnkretser so z15 paint is mostly cache hits.
 * Prefetches paint zoom and (when different) bake zoom; centre-first when dense.
 */
export async function prefetchOrganizationTiles(
  bounds: { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number },
  options: { leafletZoom: number; bakedMinZoom?: number } = { leafletZoom: DETAIL_MIN_ZOOM },
): Promise<void> {
  const bakedMin = options.bakedMinZoom ?? Math.max(0, DETAIL_MIN_ZOOM - 2)
  const paintZoom = Math.max(0, DETAIL_MIN_ZOOM - 1)
  const leafletZoom = options.leafletZoom
  // GL zoom MapLibre uses near/at detail.
  const primaryZoom = Math.max(bakedMin, Math.min(18, Math.max(leafletZoom - 1, paintZoom)))
  const padded = padBounds(bounds, 0.2)
  // Higher budget near detail (smaller tiles); still centre-first if dense.
  const maxTiles =
    primaryZoom >= paintZoom ? MAX_PREFETCH_TILES_DETAIL : primaryZoom >= bakedMin ? 80 : 48

  const jobs = [
    prefetchZoomLevel(padded.west, padded.south, padded.east, padded.north, primaryZoom, maxTiles),
  ]
  if (bakedMin < primaryZoom) {
    jobs.push(
      prefetchZoomLevel(
        padded.west,
        padded.south,
        padded.east,
        padded.north,
        bakedMin,
        Math.min(64, maxTiles),
      ),
    )
  }
  await Promise.all(jobs)
}

export function isPolygonLodLayer(name: string): boolean {
  return name.endsWith('_poly')
}

export function isAggregateLodLayer(name: string): boolean {
  return (
    name.startsWith('districts_') || name.startsWith('grunnkretser_') || name.startsWith('cells_')
  )
}

export function manifestHasLodLayers(manifest: VectorTilesManifest | null | undefined): boolean {
  return Boolean(manifest?.layers?.some((layer) => isAggregateLodLayer(layer.name)))
}

export function aggregateLayersFromManifest(
  manifest: VectorTilesManifest | null | undefined,
): VectorTilesLayerSpec[] {
  return (
    manifest?.layers?.filter(
      (layer) => layer.name !== VECTOR_TILES_LAYER && isAggregateLodLayer(layer.name),
    ) ?? []
  )
}

export function pointsLayerFromManifest(
  manifest: VectorTilesManifest | null | undefined,
): VectorTilesLayerSpec | null {
  const spec = manifest?.layers?.find((layer) => layer.name === VECTOR_TILES_LAYER)
  const glMinZoom = Math.max(0, DETAIL_MIN_ZOOM - 2)
  if (spec) {
    return { ...spec, minZoom: Math.min(spec.minZoom, glMinZoom), maxZoom: 24 }
  }
  if (manifest?.layer) {
    return { name: manifest.layer, minZoom: glMinZoom, maxZoom: 24 }
  }
  return null
}

/**
 * True when the organizations PMTiles band includes the MapLibre zoom used at
 * Leaflet detail (GL = Leaflet − 1) and tippecanoe did not rate-drop points.
 */
export function orgDetailTilesCoverLeafletZoom(
  manifest: VectorTilesManifest | null | undefined,
  leafletDetailMinZoom: number = DETAIL_MIN_ZOOM,
): boolean {
  if (!manifest?.preserveAllPoints) return false
  const bakedMin =
    manifest.layers?.find((layer) => layer.name === VECTOR_TILES_LAYER)?.minZoom ??
    (manifest.layer === VECTOR_TILES_LAYER ? leafletDetailMinZoom : null)
  if (bakedMin == null) return false
  return bakedMin <= Math.max(0, leafletDetailMinZoom - 1)
}

async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 2,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(input, init)
      if (response.ok || response.status < 500 || attempt >= retries) return response
    } catch (err) {
      if (attempt >= retries) throw err
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt))
  }
}

export async function loadVectorTilesManifest(): Promise<VectorTilesManifest | null> {
  try {
    const response = await fetchWithRetry(VECTOR_TILES_MANIFEST)
    if (!response.ok) return null
    return (await response.json()) as VectorTilesManifest
  } catch {
    return null
  }
}

export async function probeVectorTiles(): Promise<{
  available: boolean
  manifest: VectorTilesManifest | null
}> {
  try {
    // Prefer a tiny Range GET over HEAD — large PMTiles on CDN/GitHub Pages
    // often stall or omit useful HEAD responses, which used to disable vector
    // mode and fall through to an empty static-points path.
    const [probe, manifest] = await Promise.all([
      fetchWithRetry(VECTOR_TILES_PATH, {
        method: 'GET',
        headers: { Range: 'bytes=0-15' },
      }),
      loadVectorTilesManifest(),
    ])
    const magicOk =
      (probe.status === 206 || probe.status === 200) &&
      (await probe.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf)
        return (
          bytes.length >= 7 &&
          bytes[0] === 0x50 && // P
          bytes[1] === 0x4d && // M
          bytes[2] === 0x54 && // T
          bytes[3] === 0x69 && // i
          bytes[4] === 0x6c && // l
          bytes[5] === 0x65 && // e
          bytes[6] === 0x73 // s
        )
      }))
    return {
      available: magicOk && manifest !== null,
      manifest,
    }
  } catch {
    return { available: false, manifest: null }
  }
}

/** LOD district/grunnkrets tiles (fixed geography, pre-baked colours). */
export function lodTilesAvailable(manifest: VectorTilesManifest | null | undefined): boolean {
  return manifestHasLodLayers(manifest)
}

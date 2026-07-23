import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { DETAIL_MIN_ZOOM } from '../lodConfig'
import { assetUrl } from '../utils/assets'

export const VECTOR_TILES_PATH = assetUrl('data/points.pmtiles')
export const VECTOR_TILES_MANIFEST = assetUrl('data/points/manifest.json')
export const VECTOR_TILES_LAYER = 'organizations'

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

let protocolRegistered = false

export function ensurePmtilesProtocol() {
  if (protocolRegistered) return
  maplibregl.addProtocol('pmtiles', new Protocol().tile)
  protocolRegistered = true
}

export function vectorTilesSourceUrl(): string {
  const base = `${location.origin}${VECTOR_TILES_PATH}`
  return `pmtiles://${base}`
}

export function isPolygonLodLayer(name: string): boolean {
  return name.endsWith('_poly')
}

export function isAggregateLodLayer(name: string): boolean {
  return (
    name.startsWith('districts_') ||
    name.startsWith('grunnkretser_') ||
    name.startsWith('cells_')
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
  // maplibre-gl-leaflet: GL zoom = Leaflet zoom - 1
  const glMinZoom = Math.max(0, DETAIL_MIN_ZOOM - 1)
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
 * Older archives baked from z15 and/or used densest/rate dropping.
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

export async function loadVectorTilesManifest(): Promise<VectorTilesManifest | null> {
  try {
    const response = await fetch(VECTOR_TILES_MANIFEST)
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
    const [head, manifest] = await Promise.all([
      fetch(VECTOR_TILES_PATH, { method: 'HEAD' }),
      loadVectorTilesManifest(),
    ])
    return {
      available: head.ok && manifest !== null,
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

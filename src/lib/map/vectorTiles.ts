import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
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

export function manifestHasLodLayers(manifest: VectorTilesManifest | null | undefined): boolean {
  return Boolean(manifest?.layers?.some((layer) => layer.name.startsWith('cells_')))
}

export function aggregateLayersFromManifest(
  manifest: VectorTilesManifest | null | undefined,
): VectorTilesLayerSpec[] {
  return manifest?.layers?.filter((layer) => layer.name.startsWith('cells_')) ?? []
}

export function pointsLayerFromManifest(
  manifest: VectorTilesManifest | null | undefined,
): VectorTilesLayerSpec | null {
  const spec = manifest?.layers?.find((layer) => layer.name === VECTOR_TILES_LAYER)
  if (spec) return spec
  if (manifest?.layer) {
    return { name: manifest.layer, minZoom: 0, maxZoom: 24 }
  }
  return null
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
  if (import.meta.env.VITE_HAS_PMTILES !== 'true') {
    return { available: false, manifest: null }
  }

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

import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { assetUrl } from '../utils/assets'

export const VECTOR_TILES_PATH = assetUrl('data/points.pmtiles')
export const VECTOR_TILES_MANIFEST = assetUrl('data/points/manifest.json')
export const VECTOR_TILES_LAYER = 'organizations'

export interface VectorTilesManifest {
  total: number
  layer: string
  format: string
  path: string
  orgTypes: string[]
  filters: {
    excludeKonkurs: boolean
    excludeUnderAvvikling: boolean
    vatRegisteredOnly: boolean
  }
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

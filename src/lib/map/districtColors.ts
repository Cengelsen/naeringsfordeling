import type { Feature, FeatureCollection } from 'geojson'
import { assetUrl } from '../utils/assets'

export const DISTRICT_COLORS_MANIFEST = assetUrl('data/districts/manifest.json')

export interface DistrictColorLayerSpec {
  id: string
  path: string
  minZoom: number
  maxZoom: number
  features: number
  byFylke?: boolean
  fylkePathTemplate?: string
}

export interface DistrictColorsManifest {
  total: number
  orgTypes: string[]
  layers: DistrictColorLayerSpec[]
  generatedAt?: string
}

export interface DistrictColorProperties {
  color: string
  count: number
  total?: number
  dominantOrgType: string
  orgTypeBreakdown: string
  districtId?: string
  districtLevel?: string
  label?: string
  kommunenummer?: string
}

export type DistrictColorFeature = Feature & {
  properties: DistrictColorProperties
}

const layerCache = new Map<string, FeatureCollection>()

export async function loadDistrictColorsManifest(): Promise<DistrictColorsManifest | null> {
  try {
    const response = await fetch(DISTRICT_COLORS_MANIFEST)
    if (!response.ok) return null
    return (await response.json()) as DistrictColorsManifest
  } catch {
    return null
  }
}

export async function probeDistrictColors(): Promise<{
  available: boolean
  manifest: DistrictColorsManifest | null
}> {
  const manifest = await loadDistrictColorsManifest()
  if (!manifest?.layers?.length) {
    return { available: false, manifest: null }
  }

  return { available: true, manifest }
}

async function fetchGeoJsonText(path: string): Promise<string | null> {
  const normalized = path.startsWith('/') ? path.slice(1) : path
  const gzPath = `${normalized}.gz`

  try {
    const gzResponse = await fetch(assetUrl(gzPath))
    if (gzResponse.ok) {
      // Vite (and many static hosts) advertise Content-Encoding: gzip for *.gz
      // files, so fetch() already decompressed the body. Double-gunzip then fails
      // and we used to fall through to a missing uncompressed file → blank map.
      const encoding = gzResponse.headers.get('Content-Encoding') ?? ''
      if (/gzip|deflate|br/i.test(encoding)) {
        return await gzResponse.text()
      }

      if (gzResponse.body && typeof DecompressionStream !== 'undefined') {
        try {
          const stream = gzResponse.body.pipeThrough(new DecompressionStream('gzip'))
          const text = await new Response(stream).text()
          if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
            return text
          }
        } catch {
          // Body may already be plain JSON despite missing Content-Encoding.
        }
      }

      const text = await gzResponse.text()
      if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
        return text
      }
    }
  } catch {
    // Fall back to uncompressed GeoJSON below.
  }

  try {
    const response = await fetch(assetUrl(normalized))
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

async function loadGeoJsonPath(path: string): Promise<FeatureCollection | null> {
  const normalized = path.startsWith('/') ? path.slice(1) : path
  const cached = layerCache.get(normalized)
  if (cached) return cached

  const text = await fetchGeoJsonText(path)
  if (!text) return null

  try {
    const data = JSON.parse(text) as FeatureCollection
    layerCache.set(normalized, data)
    return data
  } catch {
    return null
  }
}

function fylkePath(template: string, fylke: string): string {
  return template.replace('{fylke}', fylke)
}

async function loadGrunnkretserByFylke(
  spec: DistrictColorLayerSpec,
  fylker: string[],
): Promise<FeatureCollection | null> {
  const template = spec.fylkePathTemplate
  if (!template) {
    return loadGeoJsonPath(spec.path)
  }

  // Wait for a real viewport fylke list — never invent a default (e.g. Vestland).
  if (fylker.length === 0) {
    return { type: 'FeatureCollection', features: [] }
  }

  const mergedFeatures: FeatureCollection['features'] = []
  for (const fylke of fylker) {
    const part = await loadGeoJsonPath(fylkePath(template, fylke))
    if (part?.features?.length) {
      mergedFeatures.push(...part.features)
    }
  }

  return { type: 'FeatureCollection', features: mergedFeatures }
}

export async function loadDistrictColorLayer(
  spec: DistrictColorLayerSpec | string,
  options: { fylker?: string[] } = {},
): Promise<FeatureCollection | null> {
  if (typeof spec === 'string') {
    return loadGeoJsonPath(spec)
  }

  if (spec.byFylke) {
    return loadGrunnkretserByFylke(spec, options.fylker ?? [])
  }

  return loadGeoJsonPath(spec.path)
}

export function activeDistrictLayer(
  manifest: DistrictColorsManifest,
  zoom: number,
): DistrictColorLayerSpec | null {
  for (const layer of manifest.layers) {
    if (zoom >= layer.minZoom && zoom <= layer.maxZoom) {
      return layer
    }
  }
  return null
}

/** Human-readable LOD band label for the current zoom. */
export function detailLevelLabel(
  zoom: number,
  options: {
    visualization: 'dots' | 'choropleth'
    districtLevel?: 'fylke' | 'kommune'
    dotsDetailMinZoom: number
    manifest?: DistrictColorsManifest | null
  },
): string {
  if (options.visualization === 'choropleth') {
    return options.districtLevel === 'fylke' ? 'Fylke' : 'Kommune'
  }

  if (zoom >= options.dotsDetailMinZoom) {
    return 'Enkeltadresser'
  }

  const layer = options.manifest ? activeDistrictLayer(options.manifest, zoom) : null
  switch (layer?.id) {
    case 'fylke':
      return 'Fylke'
    case 'kommune':
      return 'Kommune'
    case 'grunnkretser':
      return 'Grunnkretser'
    default:
      if (zoom <= 6) return 'Fylke'
      if (zoom <= 11) return 'Kommune'
      if (zoom < options.dotsDetailMinZoom) return 'Grunnkretser'
      return 'Enkeltadresser'
  }
}

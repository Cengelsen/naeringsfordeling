import {
  DETAIL_MIN_ZOOM,
  FYLKE_MAX_ZOOM,
  FYLKE_MIN_ZOOM,
  GRUNNKRETS_MAX_ZOOM,
  GRUNNKRETS_MIN_ZOOM,
  KOMMUNE_MAX_ZOOM,
  KOMMUNE_MIN_ZOOM,
} from '../../src/lib/lodConfig.js'

export const LOD_LAYER_NAMES = {
  fylkePoly: 'districts_fylke_poly',
  fylke: 'districts_fylke',
  kommunePoly: 'districts_kommune_poly',
  kommune: 'districts_kommune',
  grunnkretserPoly: 'grunnkretser_poly',
  points: 'organizations',
} as const

/**
 * Pre-rendered zoom bands.
 * Note: maplibre-gl-leaflet uses GL zoom = Leaflet zoom - 1, so the organizations
 * tippecanoe layer is baked from DETAIL_MIN_ZOOM - 1 (Leaflet z15 → GL z14 tiles).
 */
export const LOD_ZOOM_RANGES = {
  fylke: { minZoom: FYLKE_MIN_ZOOM, maxZoom: FYLKE_MAX_ZOOM },
  kommune: { minZoom: KOMMUNE_MIN_ZOOM, maxZoom: KOMMUNE_MAX_ZOOM },
  grunnkretser: { minZoom: GRUNNKRETS_MIN_ZOOM, maxZoom: GRUNNKRETS_MAX_ZOOM },
  points: { minZoom: Math.max(0, DETAIL_MIN_ZOOM - 1), maxZoom: 18 },
} as const

export type LodLayerExport =
  | {
      kind: 'district'
      level: 'fylke' | 'kommune'
      polyLayer: string
      pointLayer: string
      minZoom: number
      maxZoom: number
    }
  | {
      kind: 'grunnkretser'
      polyLayer: string
      minZoom: number
      maxZoom: number
    }
  | {
      kind: 'points'
      layer: string
      minZoom: number
      maxZoom: number
    }

export const LOD_EXPORT_LAYERS: LodLayerExport[] = [
  {
    kind: 'district',
    level: 'fylke',
    polyLayer: LOD_LAYER_NAMES.fylkePoly,
    pointLayer: LOD_LAYER_NAMES.fylke,
    minZoom: LOD_ZOOM_RANGES.fylke.minZoom,
    maxZoom: LOD_ZOOM_RANGES.fylke.maxZoom,
  },
  {
    kind: 'district',
    level: 'kommune',
    polyLayer: LOD_LAYER_NAMES.kommunePoly,
    pointLayer: LOD_LAYER_NAMES.kommune,
    minZoom: LOD_ZOOM_RANGES.kommune.minZoom,
    maxZoom: LOD_ZOOM_RANGES.kommune.maxZoom,
  },
  {
    kind: 'grunnkretser',
    polyLayer: LOD_LAYER_NAMES.grunnkretserPoly,
    minZoom: LOD_ZOOM_RANGES.grunnkretser.minZoom,
    maxZoom: LOD_ZOOM_RANGES.grunnkretser.maxZoom,
  },
  {
    kind: 'points',
    layer: LOD_LAYER_NAMES.points,
    minZoom: LOD_ZOOM_RANGES.points.minZoom,
    maxZoom: LOD_ZOOM_RANGES.points.maxZoom,
  },
]

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

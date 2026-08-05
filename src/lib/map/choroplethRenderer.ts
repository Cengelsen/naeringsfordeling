import L from 'leaflet'
import { colorForValue } from '../utils/colors'
import type { KommuneFeature, FylkeFeature } from '../utils/geo'
import type { ColorScheme } from '../types'

export interface ChoroplethContext {
  getMap(): L.Map | null
  getGeoLayer(): L.GeoJSON | null
}

export function styleKommuneFeature(
  feature: KommuneFeature | undefined,
  options: {
    isVisible: (kommunenummer: string) => boolean
    getCount: (kommunenummer: string) => number
    visualization: string
    maxCount: number
    colorScheme: ColorScheme
  },
) {
  const kommunenummer = feature?.properties.kommunenummer ?? ''
  const visible = options.isVisible(kommunenummer)
  const count = visible ? options.getCount(kommunenummer) : 0

  if (options.visualization === 'dots') {
    return {
      fillColor: '#64748b',
      weight: visible ? 1 : 0.3,
      opacity: visible ? 0.55 : 0.2,
      color: '#475569',
      fillOpacity: visible ? 0.08 : 0.03,
    }
  }

  return {
    fillColor: colorForValue(count, options.maxCount, options.colorScheme),
    weight: visible ? 1 : 0.3,
    opacity: visible ? 1 : 0.35,
    color: '#475569',
    fillOpacity: visible ? 0.78 : 0.15,
  }
}

export function styleFylkeFeature(
  feature: FylkeFeature | undefined,
  options: {
    isVisible: (fylkesnummer: string) => boolean
    getCount: (fylkesnummer: string) => number
    maxCount: number
    colorScheme: ColorScheme
  },
) {
  const fylkesnummer = feature?.properties.fylkesnummer ?? ''
  const visible = options.isVisible(fylkesnummer)
  const count = visible ? options.getCount(fylkesnummer) : 0

  return {
    fillColor: colorForValue(count, options.maxCount, options.colorScheme),
    weight: visible ? 1 : 0.3,
    opacity: visible ? 1 : 0.35,
    color: '#475569',
    fillOpacity: visible ? 0.78 : 0.15,
  }
}

export function bindHoverHighlight(
  path: L.Path,
  featureLayer: L.Layer,
  ctx: ChoroplethContext,
) {
  path.on({
    mouseover: (e) => {
      const target = e.target as L.Path
      target.setStyle({ weight: 2.5, color: '#0ea5e9', opacity: 1, fillOpacity: 0.9 })
      target.bringToFront()
      ctx.getMap()?.getContainer().style.setProperty('cursor', 'pointer')
    },
    mouseout: () => {
      ctx.getGeoLayer()?.resetStyle(featureLayer)
      ctx.getMap()?.getContainer().style.removeProperty('cursor')
    },
  })
}

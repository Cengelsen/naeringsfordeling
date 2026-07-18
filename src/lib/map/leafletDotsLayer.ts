import L from 'leaflet'
import type { OrganizationPoint } from '../types'
import { colorForOrgType } from '../utils/orgTypeColors'
import { jitterCoordinates } from './jitter'
import type { MaplibreDotsController, MaplibreDotsLayerOptions } from './maplibreDotsLayer'

const MAX_LEAFLET_DOTS = 4000

/**
 * Canvas-backed Leaflet fallback when MapLibre/WebGL is unavailable.
 * Vector tiles are not supported in this mode.
 */
export function createLeafletDotsLayer(
  map: L.Map,
  options: MaplibreDotsLayerOptions,
): MaplibreDotsController {
  const layer = L.layerGroup().addTo(map)
  let currentPoints: OrganizationPoint[] = []
  let visibleOrgTypes: string[] = []
  let colorTypes = options.orgTypesForColors ?? []
  let stale = false

  function pointRadius(): number {
    const zoom = map.getZoom()
    const detail = options.dotsDetailMinZoom
    if (zoom >= detail + 4) return 7
    if (zoom >= detail + 1) return 5
    return 4
  }

  function rebuild() {
    layer.clearLayers()

    const allowed =
      visibleOrgTypes.length > 0 ? new Set(visibleOrgTypes) : null
    const filtered = allowed
      ? currentPoints.filter((point) => allowed.has(point.orgType))
      : currentPoints

    const capped =
      filtered.length > MAX_LEAFLET_DOTS ? filtered.slice(0, MAX_LEAFLET_DOTS) : filtered

    const grouped = new Map<string, number>()
    const radius = pointRadius()
    const opacity = stale ? 0.45 : 0.85

    for (const point of capped) {
      const locationKey = `${point.lat.toFixed(5)}:${point.lng.toFixed(5)}`
      const index = grouped.get(locationKey) ?? 0
      grouped.set(locationKey, index + 1)
      const totalAtPoint = grouped.get(locationKey) ?? 1
      const [lat, lng] = jitterCoordinates(point.lat, point.lng, index, totalAtPoint)

      const marker = L.circleMarker([lat, lng], {
        radius,
        fillColor: colorForOrgType(point.orgType, colorTypes),
        color: '#0f172a',
        weight: 0.75,
        opacity,
        fillOpacity: opacity,
      })

      marker.on('click', (event: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(event)
        options.onPointClick(point.orgnr, event.latlng)
      })

      marker.addTo(layer)
    }
  }

  function onZoomEnd() {
    if (currentPoints.length > 0) rebuild()
  }

  map.on('zoomend', onZoomEnd)

  return {
    setPoints(points) {
      currentPoints = points
      if (colorTypes.length === 0) {
        colorTypes = [...new Set(points.map((point) => point.orgType))].sort()
      }
      rebuild()
    },
    setVisibleOrgTypes(orgTypes) {
      visibleOrgTypes = [...orgTypes]
      rebuild()
    },
    setClustering() {
      // Clustering requires MapLibre; ignored in Leaflet fallback.
    },
    setStale(nextStale) {
      stale = nextStale
      rebuild()
    },
    bringToFront() {
      layer.eachLayer((child) => {
        if (child instanceof L.CircleMarker) child.bringToFront()
      })
    },
    remove() {
      map.off('zoomend', onZoomEnd)
      map.getContainer().style.cursor = ''
      layer.remove()
    },
  }
}

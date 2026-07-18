import L from 'leaflet'
import type { OrganizationPoint } from '../types'
import { colorForOrgType } from '../utils/orgTypeColors'
import { groupPointsByLocation, orgnrsFromGroup } from './addressGroups'
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

  function squareSize(): number {
    return pointRadius() * 2 + 2
  }

  function addSquareMarker(
    lat: number,
    lng: number,
    color: string,
    orgnrs: string[],
    orgCount: number,
  ) {
    const size = squareSize()
    const opacity = stale ? 0.45 : 0.85
    const marker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'org-dot-square-wrap',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        html: `<div class="org-dot-square" style="width:${size}px;height:${size}px;background:${color};border:1.5px solid #0f172a;opacity:${opacity};box-sizing:border-box" title="${orgCount} organisasjoner"></div>`,
      }),
    })

    marker.on('click', (event: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(event)
      options.onMarkerClick(orgnrs, event.latlng)
    })

    marker.addTo(layer)
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

    const groups = groupPointsByLocation(capped)
    const radius = pointRadius()
    const opacity = stale ? 0.45 : 0.85

    for (const group of groups) {
      const orgnrs = orgnrsFromGroup(group)
      const color = colorForOrgType(group.orgType, colorTypes)

      if (group.orgCount === 1) {
        const point = group.orgs[0]!
        const marker = L.circleMarker([group.lat, group.lng], {
          radius,
          fillColor: color,
          color: '#0f172a',
          weight: 0.75,
          opacity,
          fillOpacity: opacity,
        })

        marker.on('click', (event: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(event)
          options.onMarkerClick([point.orgnr], event.latlng)
        })

        marker.addTo(layer)
      } else {
        addSquareMarker(group.lat, group.lng, color, orgnrs, group.orgCount)
      }
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
        if (child instanceof L.CircleMarker || child instanceof L.Marker) child.bringToFront()
      })
    },
    remove() {
      map.off('zoomend', onZoomEnd)
      map.getContainer().style.cursor = ''
      layer.remove()
    },
  }
}

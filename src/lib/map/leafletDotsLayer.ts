import L from 'leaflet'
import type { OrganizationPoint } from '../types'
import { colorForOrgType } from '../utils/orgTypeColors'
import { groupPointsByLocation, orgnrsFromGroup } from './addressGroups'
import type { MaplibreDotsController, MaplibreDotsLayerOptions, DotFilters } from './maplibreDotsLayer'
import { filterPointsByMapFilters } from './points'
import { coloredSegments, matrixSquareHtml } from './splitSquareMarker'

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
  let dotFilters: DotFilters = {
    orgTypes: [],
    naeringskodeSections: [],
    employeeBands: [],
    entityKinds: [],
  }
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
    return pointRadius() * 2
  }

  function addSquareMarker(
    lat: number,
    lng: number,
    group: ReturnType<typeof groupPointsByLocation>[number],
    orgnrs: string[],
  ) {
    const size = squareSize()
    const opacity = stale ? 0.45 : 0.85
    const html = matrixSquareHtml(
      coloredSegments(group, colorTypes),
      size,
      opacity,
      `${group.orgCount} organisasjoner`,
    )
    const marker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'org-dot-square-wrap',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        html,
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

    const filtered = filterPointsByMapFilters(currentPoints, dotFilters)

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
        addSquareMarker(group.lat, group.lng, group, orgnrs)
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
      dotFilters = { ...dotFilters, orgTypes: [...orgTypes] }
      rebuild()
    },
    setDotFilters(filters) {
      dotFilters = {
        orgTypes: [...filters.orgTypes],
        naeringskodeSections: [...filters.naeringskodeSections],
        employeeBands: [...filters.employeeBands],
        entityKinds: [...filters.entityKinds],
      }
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
        if ('bringToFront' in child && typeof child.bringToFront === 'function') {
          child.bringToFront()
        }
      })
    },
    remove() {
      map.off('zoomend', onZoomEnd)
      map.getContainer().style.cursor = ''
      layer.remove()
    },
    countRenderedFeatures() {
      return layer.getLayers().length
    },
  }
}

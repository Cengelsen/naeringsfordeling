import L from 'leaflet'
import type { OrganizationPoint } from '../types'
import { colorForOrgType } from '../utils/orgTypeColors'
import {
  groupPointsByLocation,
  isPreGroupedAddressPoint,
  orgnrsFromGroup,
} from './addressGroups'
import type { MaplibreDotsController, MaplibreDotsLayerOptions, DotFilters } from './maplibreDotsLayer'
import { filterPointsByMapFilters } from './points'

const MAX_LEAFLET_DOTS = 4000
const POINT_OPACITY_DEFAULT = 0.85
const POINT_OPACITY_STALE = 0.45

/**
 * Canvas-backed Leaflet fallback when MapLibre/WebGL is unavailable.
 * One circle per address; multi-org addresses are larger. No split-square icons.
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

  function pointRadius(orgCount: number): number {
    const zoom = map.getZoom()
    const detail = options.dotsDetailMinZoom
    const base = zoom >= detail + 4 ? 7 : zoom >= detail + 1 ? 5 : 4
    return orgCount > 1 ? base + 1 : base
  }

  function addCircleMarker(
    lat: number,
    lng: number,
    orgType: string,
    orgnrs: string[],
    orgCount: number,
    hint?: Partial<OrganizationPoint> | null,
  ) {
    const radius = pointRadius(orgCount)
    const opacity = stale ? POINT_OPACITY_STALE : POINT_OPACITY_DEFAULT
    const color = colorForOrgType(orgType, colorTypes)
    const marker = L.circleMarker([lat, lng], {
      radius,
      fillColor: color,
      color: '#0f172a',
      weight: orgCount > 1 ? 1.5 : 0.75,
      opacity,
      fillOpacity: opacity,
    })

    marker.on('click', (event: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(event)
      options.onMarkerClick(orgnrs, event.latlng, hint)
    })

    marker.addTo(layer)
  }

  function rebuild() {
    layer.clearLayers()
    if (map.getZoom() < options.dotsDetailMinZoom) return

    const filtered = filterPointsByMapFilters(currentPoints, dotFilters)
    const capped =
      filtered.length > MAX_LEAFLET_DOTS ? filtered.slice(0, MAX_LEAFLET_DOTS) : filtered

    if (capped.length > 0 && isPreGroupedAddressPoint(capped[0]!)) {
      for (const point of capped) {
        const orgCount = point.orgCount ?? 1
        const orgnrs = (point.orgnrs ?? point.orgnr).split(',').filter(Boolean)
        addCircleMarker(point.lat, point.lng, point.orgType, orgnrs, orgCount, point)
      }
      return
    }

    for (const group of groupPointsByLocation(capped)) {
      const orgnrs = orgnrsFromGroup(group)
      const primary = group.orgs[0]
      addCircleMarker(group.lat, group.lng, group.orgType, orgnrs, group.orgCount, primary ?? null)
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
    setClustering() {},
    setStale(nextStale) {
      stale = nextStale
      rebuild()
    },
    setVisible(visible) {
      if (!visible) {
        layer.remove()
      } else if (!map.hasLayer(layer)) {
        layer.addTo(map)
        rebuild()
      }
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

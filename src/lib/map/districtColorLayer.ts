import L from 'leaflet'
import type { FeatureCollection } from 'geojson'
import { fylkeFromKommune } from '../utils/geo'
import {
  activeDistrictLayer,
  loadDistrictColorLayer,
  type DistrictColorFeature,
  type DistrictColorsManifest,
} from './districtColors'

export interface DistrictColorLayerOptions {
  onFeatureClick: (feature: DistrictColorFeature, latlng: L.LatLng) => void
  getViewportFylker?: () => string[]
}

export interface DistrictColorFilters {
  orgTypes: string[]
  selectedFylke: string
  selectedKommune: string
}

export interface DistrictColorController {
  setZoom(zoom: number): void
  setFilters(filters: DistrictColorFilters): void
  setViewportFylker(fylker: string[]): void
  show(): void
  hide(): void
  remove(): void
}

function fylkerKey(fylker: string[]): string {
  return [...fylker].sort().join(',')
}

export function createDistrictColorLayer(
  map: L.Map,
  manifest: DistrictColorsManifest,
  options: DistrictColorLayerOptions,
): DistrictColorController {
  const root = L.layerGroup().addTo(map)
  let activeLayerId: string | null = null
  let activeFylkerKey = ''
  let currentZoom = map.getZoom()
  let loadGeneration = 0
  let filters: DistrictColorFilters = {
    orgTypes: [],
    selectedFylke: '',
    selectedKommune: '',
  }
  let visible = true

  function featureVisible(feature: DistrictColorFeature): boolean {
    const props = feature.properties
    if (filters.orgTypes.length > 0 && !filters.orgTypes.includes(props.dominantOrgType)) {
      return false
    }

    if (filters.selectedKommune) {
      if (props.districtLevel === 'kommune') {
        return props.districtId === filters.selectedKommune
      }
      if (props.districtLevel === 'fylke') {
        return props.districtId === fylkeFromKommune(filters.selectedKommune)
      }
      if (props.districtLevel === 'grunnkrets' && props.kommunenummer) {
        return props.kommunenummer === filters.selectedKommune
      }
      return true
    }

    if (filters.selectedFylke) {
      if (props.districtLevel === 'fylke') {
        return props.districtId === filters.selectedFylke
      }
      if (props.districtLevel === 'kommune' && props.districtId) {
        return fylkeFromKommune(props.districtId) === filters.selectedFylke
      }
      if (props.districtLevel === 'grunnkrets' && props.kommunenummer) {
        return fylkeFromKommune(props.kommunenummer) === filters.selectedFylke
      }
      return true
    }

    return true
  }

  function styleFeature(feature?: DistrictColorFeature): L.PathOptions {
    const color = feature?.properties.color ?? '#64748b'
    const show = feature ? featureVisible(feature) : false
    return {
      fillColor: color,
      color: '#0f172a',
      weight: show ? 1 : 0,
      opacity: show ? 0.85 : 0,
      fillOpacity: show ? 0.5 : 0,
    }
  }

  function restyleLayers() {
    root.eachLayer((layer) => {
      if (layer instanceof L.GeoJSON) {
        layer.setStyle((feature) => styleFeature(feature as DistrictColorFeature))
      }
    })
  }

  async function renderActiveLayer(forceReload = false) {
    if (!visible) return

    const spec = activeDistrictLayer(manifest, currentZoom)
    if (!spec) {
      root.clearLayers()
      activeLayerId = null
      activeFylkerKey = ''
      return
    }

    const viewportFylker =
      spec.byFylke && options.getViewportFylker ? options.getViewportFylker() : []
    const nextFylkerKey = spec.byFylke ? fylkerKey(viewportFylker) : ''

    if (
      !forceReload &&
      spec.id === activeLayerId &&
      nextFylkerKey === activeFylkerKey &&
      root.getLayers().length > 0
    ) {
      restyleLayers()
      return
    }

    const generation = ++loadGeneration
    activeLayerId = spec.id
    activeFylkerKey = nextFylkerKey

    const geojson = await loadDistrictColorLayer(spec, {
      fylker: spec.byFylke ? viewportFylker : undefined,
    })
    if (generation !== loadGeneration) return
    if (!geojson) {
      // Reset so the next ensure/setViewport call retries instead of restyling stale layers.
      activeLayerId = null
      activeFylkerKey = ''
      return
    }

    root.clearLayers()
    L.geoJSON(geojson, {
      style: (feature) => styleFeature(feature as DistrictColorFeature),
      onEachFeature: (feature, layer) => {
        const typed = feature as DistrictColorFeature
        layer.on('click', (event: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(event)
          options.onFeatureClick(typed, event.latlng)
        })
        layer.on({
          mouseover: (event: L.LeafletMouseEvent) => {
            const target = event.target as L.Path
            if (!featureVisible(typed)) return
            target.setStyle({ weight: 2, opacity: 1, fillOpacity: 0.65 })
            target.bringToFront()
          },
          mouseout: (event: L.LeafletMouseEvent) => {
            const target = event.target as L.Path
            target.setStyle(styleFeature(typed))
          },
        })
      },
    }).addTo(root)
  }

  void renderActiveLayer(true)

  return {
    setZoom(zoom) {
      if (zoom === currentZoom) return
      currentZoom = zoom
      void renderActiveLayer()
    },
    setFilters(next) {
      filters = { ...next }
      restyleLayers()
    },
    setViewportFylker(_fylker) {
      void renderActiveLayer()
    },
    show() {
      visible = true
      root.addTo(map)
      void renderActiveLayer()
    },
    hide() {
      visible = false
      loadGeneration += 1
      root.clearLayers()
      root.remove()
    },
    remove() {
      visible = false
      loadGeneration += 1
      root.clearLayers()
      root.remove()
    },
  }
}

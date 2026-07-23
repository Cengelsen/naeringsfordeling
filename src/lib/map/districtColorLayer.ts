import L from 'leaflet'
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import { fylkeFromKommune } from '../utils/geo'
import {
  activeDistrictLayer,
  loadDistrictColorLayer,
  prefetchDistrictColorLayers,
  type DistrictColorFeature,
  type DistrictColorsManifest,
} from './districtColors'
import { forEachPathLayer } from './pathLayers'

export interface DistrictColorLayerOptions {
  onFeatureClick: (feature: DistrictColorFeature, latlng: L.LatLng) => void
  getViewportFylker?: () => string[]
  getViewportBounds?: () => L.LatLngBounds | null
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
  prefetchUpcoming(fylker: string[]): void
  show(): void
  hide(): void
  bringToFront(): void
  remove(): void
}

function fylkerKey(fylker: string[]): string {
  return [...fylker].sort().join(',')
}

function geometryBounds(geometry: Geometry): L.LatLngBounds | null {
  if (geometry.type === 'GeometryCollection') return null

  const bounds = L.latLngBounds([])
  const addRing = (ring: number[][]) => {
    for (const [lng, lat] of ring) {
      if (typeof lat === 'number' && typeof lng === 'number') {
        bounds.extend([lat, lng])
      }
    }
  }

  if (geometry.type === 'Polygon') {
    addRing(geometry.coordinates[0] ?? [])
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      addRing(polygon[0] ?? [])
    }
  } else {
    return null
  }

  return bounds.isValid() ? bounds : null
}

function featureIntersectsViewport(
  feature: Feature,
  viewport: L.LatLngBounds | null,
): boolean {
  if (!viewport || !feature.geometry) return true
  const bounds = geometryBounds(feature.geometry)
  if (!bounds) return true
  return viewport.intersects(bounds)
}

export function createDistrictColorLayer(
  map: L.Map,
  manifest: DistrictColorsManifest,
  options: DistrictColorLayerOptions,
): DistrictColorController {
  const root = L.layerGroup().addTo(map)
  const canvasRenderer = L.canvas({ padding: 0.5 })
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
      weight: show ? 0.6 : 0,
      opacity: show ? 0.7 : 0,
      fillOpacity: show ? 0.5 : 0,
      renderer: canvasRenderer,
    }
  }

  function restyleLayers() {
    root.eachLayer((layer) => {
      if (layer instanceof L.GeoJSON) {
        layer.setStyle((feature) => styleFeature(feature as DistrictColorFeature))
      }
    })
  }

  function clipToViewport(geojson: FeatureCollection): FeatureCollection {
    const viewport = options.getViewportBounds?.() ?? null
    if (!viewport || geojson.features.length < 400) return geojson

    // Slightly expand so pans don't immediately blank edges.
    const padded = viewport.pad(0.15)
    return {
      type: 'FeatureCollection',
      features: geojson.features.filter((feature) => featureIntersectsViewport(feature, padded)),
    }
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
      activeLayerId = null
      activeFylkerKey = ''
      return
    }

    const clipped = spec.byFylke ? clipToViewport(geojson) : geojson

    root.clearLayers()
    L.geoJSON(clipped, {
      style: (feature) => styleFeature(feature as DistrictColorFeature),
      onEachFeature: (feature, layer) => {
        const typed = feature as DistrictColorFeature
        forEachPathLayer(layer, (path) => {
          path.on('click', (event: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(event)
            options.onFeatureClick(typed, event.latlng)
          })
          path.on({
            mouseover: (event: L.LeafletMouseEvent) => {
              if (!featureVisible(typed)) return
              const target = event.target as L.Path
              target.setStyle({ weight: 2, opacity: 1, fillOpacity: 0.65 })
              target.bringToFront()
              map.getContainer().style.cursor = 'pointer'
            },
            mouseout: (event: L.LeafletMouseEvent) => {
              const target = event.target as L.Path
              target.setStyle(styleFeature(typed))
              map.getContainer().style.cursor = ''
            },
          })
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
    prefetchUpcoming(fylker) {
      const grunnkrets = manifest.layers.find((layer) => layer.id === 'grunnkretser')
      if (!grunnkrets || fylker.length === 0) return
      void prefetchDistrictColorLayers(grunnkrets, fylker)
    },
    show() {
      visible = true
      root.addTo(map)
      void renderActiveLayer()
    },
    hide() {
      visible = false
      // Keep GeoJSON in memory so zooming back to aggregate is instant.
      root.remove()
    },
    bringToFront() {
      const candidate = root as L.Layer & { bringToFront?: () => void }
      candidate.bringToFront?.()
    },
    remove() {
      visible = false
      loadGeneration += 1
      root.clearLayers()
      root.remove()
    },
  }
}

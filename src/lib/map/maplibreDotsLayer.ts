import type { FeatureCollection, Point } from 'geojson'
import L from 'leaflet'
import maplibregl from 'maplibre-gl'
import type { GeoJSONSource } from 'maplibre-gl'
import '@maplibre/maplibre-gl-leaflet'
import type { OrganizationPoint } from '../types'
import { orgTypeColorExpression } from '../utils/orgTypeColors'
import { ensurePmtilesProtocol, VECTOR_TILES_LAYER } from './vectorTiles'
import { jitterCoordinates } from './jitter'
import { removeOrphanMaplibreGlLayers } from './maplibreLeaflet'

const SOURCE_ID = 'org-dots'
const CLUSTER_LAYER_ID = 'org-clusters'
const CLUSTER_COUNT_LAYER_ID = 'org-cluster-count'
const POINT_LAYER_ID = 'org-points'
const CLICK_TOLERANCE_PX = 10

function pointRadiusExpression(detailMinZoom: number): maplibregl.ExpressionSpecification {
  const mlDetailZoom = Math.max(0, detailMinZoom - 1)
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    mlDetailZoom,
    4,
    mlDetailZoom + 3,
    6,
    mlDetailZoom + 6,
    8,
  ]
}

const TRANSPARENT_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': 'rgba(0,0,0,0)',
      },
    },
  ],
}

export interface MaplibreDotsLayerOptions {
  dotsDetailMinZoom: number
  dotsClustering: boolean
  vectorTilesUrl?: string | null
  orgTypesForColors?: string[]
  onPointClick: (orgnr: string, latlng: L.LatLng) => void
  onVectorTilesError?: (message: string) => void
}

export interface MaplibreDotsController {
  setPoints(points: OrganizationPoint[]): void
  setVisibleOrgTypes(orgTypes: string[]): void
  setClustering(enabled: boolean): void
  setStale(stale: boolean): void
  bringToFront(): void
  remove(): void
}

function pointsToGeoJson(points: OrganizationPoint[]): FeatureCollection<Point> {
  const grouped = new Map<string, number>()

  const features = points.map((point) => {
    const locationKey = `${point.lat.toFixed(5)}:${point.lng.toFixed(5)}`
    const index = grouped.get(locationKey) ?? 0
    grouped.set(locationKey, index + 1)
    const totalAtPoint = grouped.get(locationKey) ?? 1
    const [lat, lng] = jitterCoordinates(point.lat, point.lng, index, totalAtPoint)

    return {
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [lng, lat],
      },
      properties: {
        orgnr: point.orgnr,
        orgType: point.orgType,
      },
    }
  })

  return {
    type: 'FeatureCollection',
    features,
  }
}

export function createMaplibreDotsLayer(
  map: L.Map,
  options: MaplibreDotsLayerOptions,
): MaplibreDotsController {
  const vectorMode = Boolean(options.vectorTilesUrl)
  let ready = false
  let styleReady = false
  let stale = false
  let clusteringEnabled = options.dotsClustering
  let currentTypes = options.orgTypesForColors ?? []
  let visibleOrgTypes: string[] = []
  let currentPoints: OrganizationPoint[] = []
  let pendingPoints: OrganizationPoint[] | null = null
  let clickLayers = vectorMode ? [POINT_LAYER_ID] : clusteringEnabled ? [POINT_LAYER_ID, CLUSTER_LAYER_ID] : [POINT_LAYER_ID]

  const clusterMaxZoom = Math.max(0, options.dotsDetailMinZoom - 1)

  if (vectorMode) {
    ensurePmtilesProtocol()
  }

  const glLayer = L.maplibreGL({
    style: TRANSPARENT_STYLE,
    interactive: false,
    attributionControl: false,
    pane: 'markerPane',
  } as Parameters<typeof L.maplibreGL>[0])

  try {
    glLayer.addTo(map)
  } catch (error) {
    removeOrphanMaplibreGlLayers(map)
    throw error
  }

  const container = glLayer.getContainer()
  container.style.zIndex = '650'
  container.style.pointerEvents = 'none'
  container.style.background = 'transparent'

  const mlMap = glLayer.getMaplibreMap()
  if (!mlMap) {
    removeOrphanMaplibreGlLayers(map)
    throw new Error('Failed to initialize MapLibre map (WebGL unavailable)')
  }

  mlMap.dragPan.disable()
  mlMap.scrollZoom.disable()
  mlMap.boxZoom.disable()
  mlMap.doubleClickZoom.disable()
  mlMap.touchZoomRotate.disable()
  mlMap.keyboard.disable()

  function pointLayerFilter(): maplibregl.FilterSpecification {
    const typeFilter =
      visibleOrgTypes.length > 0
        ? (['in', ['get', 'orgType'], ['literal', visibleOrgTypes]] as maplibregl.FilterSpecification)
        : null

    if (vectorMode || !clusteringEnabled) {
      return typeFilter ?? true
    }

    const unclustered: maplibregl.FilterSpecification = ['!', ['has', 'point_count']]
    return typeFilter ? (['all', unclustered, typeFilter] as maplibregl.FilterSpecification) : unclustered
  }

  function applyTypeVisibility() {
    if (!mlMap.getLayer(POINT_LAYER_ID)) return
    mlMap.setFilter(POINT_LAYER_ID, pointLayerFilter())

    if (!vectorMode && clusteringEnabled) {
      const hideClusters = visibleOrgTypes.length > 0 ? 'none' : 'visible'
      if (mlMap.getLayer(CLUSTER_LAYER_ID)) {
        mlMap.setLayoutProperty(CLUSTER_LAYER_ID, 'visibility', hideClusters)
      }
      if (mlMap.getLayer(CLUSTER_COUNT_LAYER_ID)) {
        mlMap.setLayoutProperty(CLUSTER_COUNT_LAYER_ID, 'visibility', hideClusters)
      }
    }
  }

  function applyPointColors(types: string[]) {
    if (!mlMap.getLayer(POINT_LAYER_ID)) return
    mlMap.setPaintProperty(
      POINT_LAYER_ID,
      'circle-color',
      types.length > 0 ? orgTypeColorExpression(types) : '#64748b',
    )
  }

  function applyOpacity() {
    const pointOpacity = stale ? 0.45 : 0.88
    const clusterOpacity = stale ? 0.55 : 0.92
    const labelOpacity = stale ? 0.65 : 1

    if (mlMap.getLayer(POINT_LAYER_ID)) {
      mlMap.setPaintProperty(POINT_LAYER_ID, 'circle-opacity', pointOpacity)
    }
    if (mlMap.getLayer(CLUSTER_LAYER_ID)) {
      mlMap.setPaintProperty(CLUSTER_LAYER_ID, 'circle-opacity', clusterOpacity)
    }
    if (mlMap.getLayer(CLUSTER_COUNT_LAYER_ID)) {
      mlMap.setPaintProperty(CLUSTER_COUNT_LAYER_ID, 'text-opacity', labelOpacity)
    }
  }

  function removeDataLayers() {
    for (const id of [POINT_LAYER_ID, CLUSTER_LAYER_ID, CLUSTER_COUNT_LAYER_ID]) {
      if (mlMap.getLayer(id)) mlMap.removeLayer(id)
    }
    if (mlMap.getSource(SOURCE_ID)) mlMap.removeSource(SOURCE_ID)
  }

  function addPointLayer() {
    mlMap.addLayer({
      id: POINT_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      ...(vectorMode ? { 'source-layer': VECTOR_TILES_LAYER } : {}),
      minzoom: vectorMode ? 0 : Math.max(0, options.dotsDetailMinZoom - 2),
      filter: pointLayerFilter(),
      paint: {
        'circle-color':
          currentTypes.length > 0 ? orgTypeColorExpression(currentTypes) : '#64748b',
        'circle-radius': pointRadiusExpression(options.dotsDetailMinZoom),
        'circle-stroke-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          Math.max(0, options.dotsDetailMinZoom - 1),
          0.5,
          Math.max(0, options.dotsDetailMinZoom + 4),
          1,
        ],
        'circle-stroke-color': '#0f172a',
        'circle-opacity': 0.88,
      },
    })
  }

  function setupDataLayers(clustered: boolean) {
    if (!styleReady) return

    removeDataLayers()
    clusteringEnabled = clustered
    clickLayers = vectorMode ? [POINT_LAYER_ID] : clustered ? [POINT_LAYER_ID, CLUSTER_LAYER_ID] : [POINT_LAYER_ID]

    if (vectorMode && options.vectorTilesUrl) {
      mlMap.addSource(SOURCE_ID, {
        type: 'vector',
        url: options.vectorTilesUrl,
      })
      addPointLayer()
      applyPointColors(currentTypes)
      applyTypeVisibility()
      applyOpacity()
      ready = true
      return
    }

    mlMap.addSource(SOURCE_ID, {
      type: 'geojson',
      data: pointsToGeoJson(currentPoints),
      ...(clustered
        ? { cluster: true, clusterMaxZoom, clusterRadius: 50 }
        : {}),
    })

    if (clustered) {
      mlMap.addLayer({
        id: CLUSTER_LAYER_ID,
        type: 'circle',
        source: SOURCE_ID,
        minzoom: 0,
        maxzoom: options.dotsDetailMinZoom,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'step',
            ['get', 'point_count'],
            '#38bdf8',
            25,
            '#0ea5e9',
            100,
            '#0284c7',
            500,
            '#0369a1',
          ],
          'circle-radius': ['step', ['get', 'point_count'], 16, 25, 20, 100, 26, 500, 32],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#0f172a',
          'circle-opacity': 0.92,
        },
      })

      mlMap.addLayer({
        id: CLUSTER_COUNT_LAYER_ID,
        type: 'symbol',
        source: SOURCE_ID,
        minzoom: 0,
        maxzoom: options.dotsDetailMinZoom,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-size': 12,
        },
        paint: {
          'text-color': '#f8fafc',
        },
      })
    }

    addPointLayer()
    applyPointColors(currentTypes)
    applyTypeVisibility()
    applyOpacity()
    ready = true
  }

  function updateSource(points: OrganizationPoint[]) {
    if (vectorMode) return

    currentPoints = points
    currentTypes = [...new Set(points.map((point) => point.orgType))].sort()
    const source = mlMap.getSource(SOURCE_ID) as GeoJSONSource | undefined
    if (source) {
      source.setData(pointsToGeoJson(points))
      applyPointColors(currentTypes)
      applyOpacity()
    }
  }

  function initStyle() {
    if (styleReady) return
    styleReady = true
    setupDataLayers(clusteringEnabled)
    if (pendingPoints) {
      updateSource(pendingPoints)
      pendingPoints = null
    }
  }

  mlMap.on('error', (event) => {
    if (!vectorMode) return
    const message = event.error?.message ?? 'Vector tile source failed'
    options.onVectorTilesError?.(message)
  })

  mlMap.on('load', initStyle)
  mlMap.once('styledata', initStyle)

  async function handleClusterFeature(feature: maplibregl.MapGeoJSONFeature) {
    const clusterId = feature.properties?.cluster_id
    if (clusterId == null) return

    const source = mlMap.getSource(SOURCE_ID) as GeoJSONSource
    const expansionZoom = await source.getClusterExpansionZoom(clusterId)
    const [lng, lat] = (feature.geometry as Point).coordinates

    map.setView([lat, lng], Math.min(expansionZoom + 1, map.getMaxZoom()), {
      animate: true,
    })
  }

  function handlePointFeature(feature: maplibregl.MapGeoJSONFeature) {
    const orgnr = feature.properties?.orgnr as string | undefined
    if (!orgnr) return

    const [lng, lat] = (feature.geometry as Point).coordinates
    options.onPointClick(orgnr, L.latLng(lat, lng))
  }

  function featuresAtClick(latlng: L.LatLng): maplibregl.MapGeoJSONFeature[] {
    const point = mlMap.project([latlng.lng, latlng.lat])
    return mlMap.queryRenderedFeatures(
      [
        [point.x - CLICK_TOLERANCE_PX, point.y - CLICK_TOLERANCE_PX],
        [point.x + CLICK_TOLERANCE_PX, point.y + CLICK_TOLERANCE_PX],
      ],
      { layers: clickLayers },
    )
  }

  function handleLeafletClick(event: L.LeafletMouseEvent) {
    if (!ready) return

    const features = featuresAtClick(event.latlng)
    if (features.length === 0) return

    L.DomEvent.stopPropagation(event)

    const pointFeature = features.find((feature) => feature.layer.id === POINT_LAYER_ID)
    if (pointFeature) {
      handlePointFeature(pointFeature)
      return
    }

    const clusterFeature = features.find((feature) => feature.layer.id === CLUSTER_LAYER_ID)
    if (clusterFeature) {
      void handleClusterFeature(clusterFeature)
    }
  }

  function handleLeafletMouseMove(event: L.LeafletMouseEvent) {
    if (!ready) {
      map.getContainer().style.cursor = ''
      return
    }

    const hasFeature = featuresAtClick(event.latlng).length > 0
    map.getContainer().style.cursor = hasFeature ? 'pointer' : ''
  }

  map.on('click', handleLeafletClick)
  map.on('mousemove', handleLeafletMouseMove)

  return {
    setPoints(points) {
      if (vectorMode) return
      if (!ready) {
        pendingPoints = points
        currentPoints = points
        return
      }
      updateSource(points)
    },
    setClustering(enabled) {
      if (vectorMode || (enabled === clusteringEnabled && ready)) return
      clusteringEnabled = enabled
      if (!styleReady) return
      ready = false
      setupDataLayers(enabled)
    },
    setVisibleOrgTypes(orgTypes) {
      visibleOrgTypes = [...orgTypes]
      if (ready) applyTypeVisibility()
    },
    setStale(nextStale) {
      stale = nextStale
      if (ready) applyOpacity()
    },
    bringToFront() {
      const pane = glLayer.getPane()
      if (pane) pane.appendChild(container)
    },
    remove() {
      map.off('click', handleLeafletClick)
      map.off('mousemove', handleLeafletMouseMove)
      map.getContainer().style.cursor = ''
      try {
        glLayer.remove()
      } catch {
        // ignore partial teardown
      }
      removeOrphanMaplibreGlLayers(map)
    },
  }
}

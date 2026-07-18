import type { FeatureCollection, Point } from 'geojson'
import L from 'leaflet'
import maplibregl from 'maplibre-gl'
import type { GeoJSONSource } from 'maplibre-gl'
import '@maplibre/maplibre-gl-leaflet'
import type { OrganizationPoint } from '../types'
import { orgTypeColorExpression } from '../utils/orgTypeColors'
import { ensurePmtilesProtocol, VECTOR_TILES_LAYER } from './vectorTiles'
import { groupPointsByLocation, locationKey, orgnrsFromGroup } from './addressGroups'
import { removeOrphanMaplibreGlLayers } from './maplibreLeaflet'

const SOURCE_ID = 'org-dots'
const CLUSTER_LAYER_ID = 'org-clusters'
const CLUSTER_COUNT_LAYER_ID = 'org-cluster-count'
const POINT_LAYER_ID = 'org-points'
const MULTI_POINT_LAYER_ID = 'org-points-multi'
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

function multiMarkerSizeExpression(detailMinZoom: number): maplibregl.ExpressionSpecification {
  const mlDetailZoom = Math.max(0, detailMinZoom - 1)
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    mlDetailZoom,
    14,
    mlDetailZoom + 3,
    18,
    mlDetailZoom + 6,
    22,
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
  onMarkerClick: (orgnrs: string[], latlng: L.LatLng) => void
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
  const groups = groupPointsByLocation(points)

  const features = groups.map((group) => {
    const orgnrs = orgnrsFromGroup(group)
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [group.lng, group.lat],
      },
      properties: {
        orgnr: orgnrs[0],
        orgType: group.orgType,
        orgCount: group.orgCount,
        orgnrs: orgnrs.join(','),
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
  let clickLayers = vectorMode
    ? [POINT_LAYER_ID]
    : clusteringEnabled
      ? [MULTI_POINT_LAYER_ID, POINT_LAYER_ID, CLUSTER_LAYER_ID]
      : [MULTI_POINT_LAYER_ID, POINT_LAYER_ID]

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

  function pointLayerFilter(singleOnly: boolean): maplibregl.FilterSpecification {
    const typeFilter =
      visibleOrgTypes.length > 0
        ? (['in', ['get', 'orgType'], ['literal', visibleOrgTypes]] as maplibregl.FilterSpecification)
        : null

    const countFilter: maplibregl.FilterSpecification = singleOnly
      ? ['==', ['get', 'orgCount'], 1]
      : ['>', ['get', 'orgCount'], 1]

    if (vectorMode || !clusteringEnabled) {
      const base = vectorMode ? (typeFilter ?? true) : (['all', countFilter, typeFilter ?? true] as maplibregl.FilterSpecification)
      return base
    }

    const unclustered: maplibregl.FilterSpecification = ['!', ['has', 'point_count']]
    return typeFilter
      ? (['all', unclustered, countFilter, typeFilter] as maplibregl.FilterSpecification)
      : (['all', unclustered, countFilter] as maplibregl.FilterSpecification)
  }

  function applyTypeVisibility() {
    if (mlMap.getLayer(POINT_LAYER_ID)) {
      mlMap.setFilter(POINT_LAYER_ID, pointLayerFilter(true))
    }
    if (mlMap.getLayer(MULTI_POINT_LAYER_ID)) {
      mlMap.setFilter(MULTI_POINT_LAYER_ID, pointLayerFilter(false))
    }

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
    const colorExpr = types.length > 0 ? orgTypeColorExpression(types) : '#64748b'
    if (mlMap.getLayer(POINT_LAYER_ID)) {
      mlMap.setPaintProperty(POINT_LAYER_ID, 'circle-color', colorExpr)
    }
    if (mlMap.getLayer(MULTI_POINT_LAYER_ID)) {
      mlMap.setPaintProperty(MULTI_POINT_LAYER_ID, 'text-color', colorExpr)
    }
  }

  function applyOpacity() {
    const pointOpacity = stale ? 0.45 : 0.88
    const clusterOpacity = stale ? 0.55 : 0.92
    const labelOpacity = stale ? 0.65 : 1

    if (mlMap.getLayer(POINT_LAYER_ID)) {
      mlMap.setPaintProperty(POINT_LAYER_ID, 'circle-opacity', pointOpacity)
    }
    if (mlMap.getLayer(MULTI_POINT_LAYER_ID)) {
      mlMap.setPaintProperty(MULTI_POINT_LAYER_ID, 'text-opacity', pointOpacity)
    }
    if (mlMap.getLayer(CLUSTER_LAYER_ID)) {
      mlMap.setPaintProperty(CLUSTER_LAYER_ID, 'circle-opacity', clusterOpacity)
    }
    if (mlMap.getLayer(CLUSTER_COUNT_LAYER_ID)) {
      mlMap.setPaintProperty(CLUSTER_COUNT_LAYER_ID, 'text-opacity', labelOpacity)
    }
  }

  function removeDataLayers() {
    for (const id of [POINT_LAYER_ID, MULTI_POINT_LAYER_ID, CLUSTER_LAYER_ID, CLUSTER_COUNT_LAYER_ID]) {
      if (mlMap.getLayer(id)) mlMap.removeLayer(id)
    }
    if (mlMap.getSource(SOURCE_ID)) mlMap.removeSource(SOURCE_ID)
  }

  function addSinglePointLayer() {
    mlMap.addLayer({
      id: POINT_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      ...(vectorMode ? { 'source-layer': VECTOR_TILES_LAYER } : {}),
      minzoom: vectorMode ? 0 : Math.max(0, options.dotsDetailMinZoom - 2),
      filter: pointLayerFilter(true),
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

  function addMultiPointLayer() {
    mlMap.addLayer({
      id: MULTI_POINT_LAYER_ID,
      type: 'symbol',
      source: SOURCE_ID,
      minzoom: Math.max(0, options.dotsDetailMinZoom - 2),
      filter: pointLayerFilter(false),
      layout: {
        'text-field': '■',
        'text-size': multiMarkerSizeExpression(options.dotsDetailMinZoom),
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color':
          currentTypes.length > 0 ? orgTypeColorExpression(currentTypes) : '#64748b',
        'text-halo-color': '#0f172a',
        'text-halo-width': 1,
        'text-opacity': 0.88,
      },
    })
  }

  function setupDataLayers(clustered: boolean) {
    if (!styleReady) return

    removeDataLayers()
    clusteringEnabled = clustered
    clickLayers = vectorMode
      ? [POINT_LAYER_ID]
      : clustered
        ? [MULTI_POINT_LAYER_ID, POINT_LAYER_ID, CLUSTER_LAYER_ID]
        : [MULTI_POINT_LAYER_ID, POINT_LAYER_ID]

    if (vectorMode && options.vectorTilesUrl) {
      mlMap.addSource(SOURCE_ID, {
        type: 'vector',
        url: options.vectorTilesUrl,
      })
      addSinglePointLayer()
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

    addSinglePointLayer()
    addMultiPointLayer()
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

  function orgnrsFromFeature(feature: maplibregl.MapGeoJSONFeature): string[] {
    const orgCount = feature.properties?.orgCount as number | undefined
    const orgnrsProp = feature.properties?.orgnrs as string | undefined
    if (orgCount != null && orgCount > 1 && orgnrsProp) {
      return orgnrsProp.split(',')
    }
    const orgnr = feature.properties?.orgnr as string | undefined
    return orgnr ? [orgnr] : []
  }

  function handlePointFeatures(features: maplibregl.MapGeoJSONFeature[]) {
    const pointFeatures = features.filter(
      (feature) =>
        feature.layer.id === POINT_LAYER_ID || feature.layer.id === MULTI_POINT_LAYER_ID,
    )
    if (pointFeatures.length === 0) return

    const multiFeature = pointFeatures.find((feature) => feature.layer.id === MULTI_POINT_LAYER_ID)
    if (multiFeature) {
      const orgnrs = orgnrsFromFeature(multiFeature)
      if (orgnrs.length === 0) return
      const [lng, lat] = (multiFeature.geometry as Point).coordinates
      options.onMarkerClick(orgnrs, L.latLng(lat, lng))
      return
    }

    const byLocation = new Map<string, { lat: number; lng: number; orgnrs: string[] }>()
    for (const feature of pointFeatures) {
      for (const orgnr of orgnrsFromFeature(feature)) {
        const [lng, lat] = (feature.geometry as Point).coordinates
        const key = locationKey(lat, lng)
        const entry = byLocation.get(key) ?? { lat, lng, orgnrs: [] }
        if (!entry.orgnrs.includes(orgnr)) entry.orgnrs.push(orgnr)
        byLocation.set(key, entry)
      }
    }

    const primary = pointFeatures[0]!
    const [lng, lat] = (primary.geometry as Point).coordinates
    const key = locationKey(lat, lng)
    const group = byLocation.get(key)
    if (!group || group.orgnrs.length === 0) return

    options.onMarkerClick(group.orgnrs, L.latLng(group.lat, group.lng))
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

    const pointFeatures = features.filter(
      (feature) =>
        feature.layer.id === POINT_LAYER_ID || feature.layer.id === MULTI_POINT_LAYER_ID,
    )
    if (pointFeatures.length > 0) {
      handlePointFeatures(pointFeatures)
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

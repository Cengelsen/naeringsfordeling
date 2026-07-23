import type { FeatureCollection, Point } from 'geojson'
import L from 'leaflet'
import maplibregl from 'maplibre-gl'
import type { GeoJSONSource } from 'maplibre-gl'
import '@maplibre/maplibre-gl-leaflet'
import type { OrganizationPoint } from '../types'
import type { EmployeeBand } from '../utils/employeeBands'
import { bakedColorExpression, orgTypeColorExpression } from '../utils/orgTypeColors'
import { ensurePmtilesProtocol, isPolygonLodLayer, VECTOR_TILES_LAYER, type VectorTilesLayerSpec } from './vectorTiles'
import { groupPointsByLocation, locationKey, orgnrsFromGroup } from './addressGroups'
import { removeOrphanMaplibreGlLayers } from './maplibreLeaflet'
import {
  colorMixKey,
  coloredSegments,
  createSplitSquareImageData,
  SPLIT_SQUARE_IMAGE_SIZE,
} from './splitSquareMarker'

const SOURCE_ID = 'org-dots'
const CLUSTER_LAYER_ID = 'org-clusters'
const CLUSTER_COUNT_LAYER_ID = 'org-cluster-count'
const POINT_LAYER_ID = 'org-points'
const MULTI_POINT_LAYER_ID = 'org-points-multi'
const CLICK_TOLERANCE_PX = 10

function aggregateLayerId(sourceLayer: string): string {
  return `org-${sourceLayer}`
}

function districtFillLayerId(sourceLayer: string): string {
  return `org-fill-${sourceLayer}`
}

function isDistrictMarkerLayer(sourceLayer: string): boolean {
  return sourceLayer.startsWith('districts_') && !sourceLayer.endsWith('_poly')
}

function supercellRadiusExpression(): maplibregl.ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    4,
    ['step', ['get', 'count'], 4, 50, 5, 200, 7, 1000, 10],
    10,
    ['step', ['get', 'count'], 5, 50, 6, 200, 8, 1000, 11],
    12,
    4,
  ]
}

function pointRadiusExpression(detailMinZoom: number): maplibregl.ExpressionSpecification {
  const mlDetailZoom = Math.max(0, detailMinZoom - 1)
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    3,
    mlDetailZoom,
    4,
    mlDetailZoom + 3,
    6,
    mlDetailZoom + 6,
    8,
  ]
}

function multiMarkerIconSizeExpression(detailMinZoom: number): maplibregl.ExpressionSpecification {
  const mlDetailZoom = Math.max(0, detailMinZoom - 1)
  const toIconSize = (radius: number) => (radius * 2) / SPLIT_SQUARE_IMAGE_SIZE

  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    mlDetailZoom,
    toIconSize(4),
    mlDetailZoom + 3,
    toIconSize(6),
    mlDetailZoom + 6,
    toIconSize(8),
  ]
}

function pointsToGeoJson(points: OrganizationPoint[], colorTypes: string[]): FeatureCollection<Point> {
  const groups = groupPointsByLocation(points)

  const features = groups.map((group) => {
    const orgnrs = orgnrsFromGroup(group)
    const primary = group.orgs[0]
    const naeringskode = primary?.naeringskode ?? ''
    const properties: Record<string, string | number> = {
      orgnr: orgnrs[0]!,
      orgType: group.orgType,
      orgCount: group.orgCount,
      orgnrs: orgnrs.join(','),
      entityKind: primary?.entityKind ?? 'enhet',
      employeeBand: primary?.employeeBand ?? 'unknown',
      naeringskode: naeringskode.length >= 2 ? naeringskode.slice(0, 2) : naeringskode,
    }

    if (group.orgCount > 1) {
      properties.colorMixKey = colorMixKey(coloredSegments(group, colorTypes))
    }

    return {
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [group.lng, group.lat],
      },
      properties,
    }
  })

  return {
    type: 'FeatureCollection',
    features,
  }
}

function syncMultiSquareImages(
  mlMap: maplibregl.Map,
  points: OrganizationPoint[],
  colorTypes: string[],
) {
  for (const group of groupPointsByLocation(points)) {
    if (group.orgCount <= 1) continue

    const key = colorMixKey(coloredSegments(group, colorTypes))
    if (mlMap.hasImage(key)) continue

    mlMap.addImage(key, createSplitSquareImageData(coloredSegments(group, colorTypes)), {
      pixelRatio: 1,
    })
  }
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

export interface DotFilters {
  orgTypes: string[]
  naeringskodeSections: string[]
  employeeBands: EmployeeBand[]
  entityKinds: ('enhet' | 'underenhet')[]
}

export interface MaplibreDotsLayerOptions {
  dotsDetailMinZoom: number
  dotsClustering: boolean
  vectorTilesUrl?: string | null
  lodLayers?: VectorTilesLayerSpec[]
  pointsLayer?: VectorTilesLayerSpec | null
  orgTypesForColors?: string[]
  onMarkerClick: (orgnrs: string[], latlng: L.LatLng) => void
  onAggregateClick?: (info: {
    orgType: string
    count: number
    latlng: L.LatLng
    label?: string
    total?: number
    districtLevel?: string
    orgTypeBreakdown?: string
  }) => void
  onVectorTilesError?: (message: string) => void
}

export interface MaplibreDotsController {
  setPoints(points: OrganizationPoint[]): void
  setVisibleOrgTypes(orgTypes: string[]): void
  setDotFilters(filters: DotFilters): void
  setClustering(enabled: boolean): void
  setStale(stale: boolean): void
  bringToFront(): void
  countRenderedFeatures(): number
  remove(): void
}

export function createMaplibreDotsLayer(
  map: L.Map,
  options: MaplibreDotsLayerOptions,
): MaplibreDotsController {
  const vectorMode = Boolean(options.vectorTilesUrl)
  const lodLayers = options.lodLayers ?? []
  const pointsLayerSpec = options.pointsLayer ?? null
  const pointsMinZoom = options.dotsDetailMinZoom
  const pointsMaxZoom = pointsLayerSpec?.maxZoom ?? 24
  const pointsSourceLayer = pointsLayerSpec?.name ?? VECTOR_TILES_LAYER
  let ready = false
  let styleReady = false
  let stale = false
  let clusteringEnabled = options.dotsClustering
  let currentTypes = options.orgTypesForColors ?? []
  let dotFilters: DotFilters = {
    orgTypes: [],
    naeringskodeSections: [],
    employeeBands: [],
    entityKinds: [],
  }
  let currentPoints: OrganizationPoint[] = []
  let pendingPoints: OrganizationPoint[] | null = null
  function lodClickLayerIds(): string[] {
    return lodLayers.flatMap((layer) => {
      if (isPolygonLodLayer(layer.name)) {
        return [districtFillLayerId(layer.name)]
      }
      if (isDistrictMarkerLayer(layer.name)) {
        return []
      }
      return [aggregateLayerId(layer.name)]
    })
  }

  let clickLayers = vectorMode ? [...lodClickLayerIds(), POINT_LAYER_ID] : clusteringEnabled
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

  function propertyInFilter(
    property: string,
    values: string[],
  ): maplibregl.FilterSpecification | null {
    if (values.length === 0) return null
    return ['in', ['get', property], ['literal', values]]
  }

  function pointLayerFilter(singleOnly: boolean): maplibregl.FilterSpecification {
    const parts: maplibregl.FilterSpecification[] = []
    const typeFilter = propertyInFilter('orgType', dotFilters.orgTypes)

    if (typeFilter) parts.push(typeFilter)

    const countFilter: maplibregl.FilterSpecification = singleOnly
      ? ['==', ['get', 'orgCount'], 1]
      : ['>', ['get', 'orgCount'], 1]

    if (vectorMode || !clusteringEnabled) {
      if (vectorMode) {
        return parts.length > 0 ? (['all', ...parts] as maplibregl.FilterSpecification) : true
      }
      return parts.length > 0
        ? (['all', countFilter, ...parts] as maplibregl.FilterSpecification)
        : countFilter
    }

    const unclustered: maplibregl.FilterSpecification = ['!', ['has', 'point_count']]
    return parts.length > 0
      ? (['all', unclustered, countFilter, ...parts] as maplibregl.FilterSpecification)
      : (['all', unclustered, countFilter] as maplibregl.FilterSpecification)
  }

  function aggregateLayerFilter(): maplibregl.FilterSpecification {
    const typeFilter = propertyInFilter('dominantOrgType', dotFilters.orgTypes)
    return typeFilter ?? true
  }

  function applyTypeVisibility() {
    for (const spec of lodLayers) {
      const layerId = aggregateLayerId(spec.name)
      if (mlMap.getLayer(layerId)) {
        mlMap.setFilter(layerId, aggregateLayerFilter())
      }
    }

    if (mlMap.getLayer(POINT_LAYER_ID)) {
      mlMap.setFilter(POINT_LAYER_ID, pointLayerFilter(true))
    }
    if (mlMap.getLayer(MULTI_POINT_LAYER_ID)) {
      mlMap.setFilter(MULTI_POINT_LAYER_ID, pointLayerFilter(false))
    }

    if (!vectorMode && clusteringEnabled) {
      const hideClusters =
        dotFilters.orgTypes.length > 0 ||
        dotFilters.naeringskodeSections.length > 0 ||
        dotFilters.employeeBands.length > 0 ||
        dotFilters.entityKinds.length > 0
          ? 'none'
          : 'visible'
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
  }

  function applyOpacity() {
    const pointOpacity = stale ? 0.45 : 0.88
    const clusterOpacity = stale ? 0.55 : 0.92
    const labelOpacity = stale ? 0.65 : 1
    const aggregateFillOpacity = stale ? 0.28 : 0.42
    const aggregateCircleOpacity = stale ? 0.4 : 0.82

    for (const spec of lodLayers) {
      if (isPolygonLodLayer(spec.name)) {
        const fillId = districtFillLayerId(spec.name)
        if (mlMap.getLayer(fillId)) {
          mlMap.setPaintProperty(fillId, 'fill-opacity', aggregateFillOpacity)
        }
        continue
      }
      const layerId = aggregateLayerId(spec.name)
      if (mlMap.getLayer(layerId)) {
        mlMap.setPaintProperty(layerId, 'circle-opacity', aggregateCircleOpacity)
      }
    }

    if (mlMap.getLayer(POINT_LAYER_ID)) {
      mlMap.setPaintProperty(POINT_LAYER_ID, 'circle-opacity', pointOpacity)
    }
    if (mlMap.getLayer(MULTI_POINT_LAYER_ID)) {
      mlMap.setPaintProperty(MULTI_POINT_LAYER_ID, 'icon-opacity', pointOpacity)
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
    for (const spec of lodLayers) {
      if (isPolygonLodLayer(spec.name)) {
        const fillId = districtFillLayerId(spec.name)
        if (mlMap.getLayer(fillId)) mlMap.removeLayer(fillId)
      }
      const layerId = aggregateLayerId(spec.name)
      if (mlMap.getLayer(layerId)) mlMap.removeLayer(layerId)
    }
    if (mlMap.getSource(SOURCE_ID)) mlMap.removeSource(SOURCE_ID)
  }

  function addAggregateLayers() {
    for (const spec of lodLayers) {
      if (isPolygonLodLayer(spec.name)) {
        const fillId = districtFillLayerId(spec.name)
        mlMap.addLayer({
          id: fillId,
          type: 'fill',
          source: SOURCE_ID,
          'source-layer': spec.name,
          minzoom: spec.minZoom,
          maxzoom: spec.maxZoom,
          filter: aggregateLayerFilter(),
          paint: {
            'fill-color': bakedColorExpression(),
            'fill-opacity': 0.42,
            'fill-outline-color': '#0f172a',
          },
        })
        continue
      }

      if (isDistrictMarkerLayer(spec.name)) {
        continue
      }

      const layerId = aggregateLayerId(spec.name)
      const radius = supercellRadiusExpression()

      mlMap.addLayer({
        id: layerId,
        type: 'circle',
        source: SOURCE_ID,
        'source-layer': spec.name,
        minzoom: spec.minZoom,
        maxzoom: spec.maxZoom,
        filter: aggregateLayerFilter(),
        paint: {
          'circle-color': bakedColorExpression(),
          'circle-radius': radius,
          'circle-stroke-width': 0.75,
          'circle-stroke-color': '#0f172a',
          'circle-opacity': 0.72,
        },
      })
    }
  }

  function addSinglePointLayer() {
    mlMap.addLayer({
      id: POINT_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      ...(vectorMode ? { 'source-layer': pointsSourceLayer } : {}),
      minzoom: vectorMode ? pointsMinZoom : 0,
      maxzoom: vectorMode ? pointsMaxZoom : 24,
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
      minzoom: 0,
      filter: pointLayerFilter(false),
      layout: {
        'icon-image': ['get', 'colorMixKey'],
        'icon-size': multiMarkerIconSizeExpression(options.dotsDetailMinZoom),
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-opacity': 0.88,
      },
    })
  }

  function setupDataLayers(clustered: boolean) {
    if (!styleReady) return

    removeDataLayers()
    clusteringEnabled = clustered
    clickLayers = vectorMode
      ? [...lodClickLayerIds(), POINT_LAYER_ID]
      : clustered
        ? [MULTI_POINT_LAYER_ID, POINT_LAYER_ID, CLUSTER_LAYER_ID]
        : [MULTI_POINT_LAYER_ID, POINT_LAYER_ID]

    if (vectorMode && options.vectorTilesUrl) {
      mlMap.addSource(SOURCE_ID, {
        type: 'vector',
        url: options.vectorTilesUrl,
      })
      addAggregateLayers()
      addSinglePointLayer()
      applyPointColors(currentTypes)
      applyTypeVisibility()
      applyOpacity()
      ready = true
      return
    }

    mlMap.addSource(SOURCE_ID, {
      type: 'geojson',
      data: pointsToGeoJson(currentPoints, currentTypes),
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
    syncMultiSquareImages(mlMap, currentPoints, currentTypes)
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
      syncMultiSquareImages(mlMap, points, currentTypes)
      source.setData(pointsToGeoJson(points, currentTypes))
      applyPointColors(currentTypes)
      applyTypeVisibility()
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

  function handleAggregateFeature(
    feature: maplibregl.MapGeoJSONFeature,
    latlng: L.LatLng,
  ) {
    const orgType =
      (feature.properties?.dominantOrgType as string | undefined) ??
      (feature.properties?.orgType as string | undefined)
    const count =
      (feature.properties?.count as number | undefined) ??
      (feature.properties?.total as number | undefined)
    if (!orgType || count == null) return
    options.onAggregateClick?.({
      orgType,
      count,
      latlng,
      label: feature.properties?.label as string | undefined,
      total: feature.properties?.total as number | undefined,
      districtLevel: feature.properties?.districtLevel as string | undefined,
      orgTypeBreakdown: feature.properties?.orgTypeBreakdown as string | undefined,
    })
  }

  function isAggregateLayerId(layerId: string): boolean {
    return lodLayers.some((spec) => {
      if (isPolygonLodLayer(spec.name)) {
        return layerId === districtFillLayerId(spec.name)
      }
      return layerId === aggregateLayerId(spec.name)
    })
  }

  function handleLeafletClick(event: L.LeafletMouseEvent) {
    if (!ready) return

    const features = featuresAtClick(event.latlng)
    if (features.length === 0) return

    L.DomEvent.stopPropagation(event)

    const aggregateFeature = features.find((feature) => isAggregateLayerId(feature.layer.id))
    if (aggregateFeature && map.getZoom() < options.dotsDetailMinZoom) {
      handleAggregateFeature(aggregateFeature, event.latlng)
      return
    }

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
      dotFilters = { ...dotFilters, orgTypes: [...orgTypes] }
      if (ready) applyTypeVisibility()
    },
    setDotFilters(filters) {
      dotFilters = {
        orgTypes: [...filters.orgTypes],
        naeringskodeSections: [...filters.naeringskodeSections],
        employeeBands: [...filters.employeeBands],
        entityKinds: [...filters.entityKinds],
      }
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
    countRenderedFeatures() {
      if (!ready) return 0
      const layers = clickLayers.filter((id) => mlMap.getLayer(id))
      if (layers.length === 0) return 0
      const bounds = map.getBounds()
      const sw = mlMap.project([bounds.getWest(), bounds.getSouth()])
      const ne = mlMap.project([bounds.getEast(), bounds.getNorth()])
      return mlMap.queryRenderedFeatures([sw, ne], { layers }).length
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

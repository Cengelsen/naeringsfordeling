import type { FeatureCollection, Point } from 'geojson'
import L from 'leaflet'
import maplibregl, { setMaxParallelImageRequests } from 'maplibre-gl'
import type { GeoJSONSource } from 'maplibre-gl'
import '@maplibre/maplibre-gl-leaflet'
import type { OrganizationPoint } from '../types'
import type { EmployeeBand } from '../utils/employeeBands'
import { bakedColorExpression, orgTypeColorExpression } from '../utils/orgTypeColors'
import {
  ensurePmtilesProtocol,
  isPolygonLodLayer,
  VECTOR_TILES_LAYER,
  type VectorTilesLayerSpec,
} from './vectorTiles'
import {
  groupPointsByLocation,
  isPreGroupedAddressPoint,
  orgnrsFromGroup,
} from './addressGroups'
import { removeOrphanMaplibreGlLayers } from './maplibreLeaflet'

const SOURCE_ID = 'org-dots'
const POINT_LAYER_ID = 'org-points'
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

function pointRadiusExpression(detailMinZoom: number): maplibregl.ExpressionSpecification {
  const mlDetailZoom = Math.max(0, detailMinZoom - 1)
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    mlDetailZoom,
    ['case', ['>', ['coalesce', ['get', 'orgCount'], 1], 1], 5, 4],
    mlDetailZoom + 3,
    ['case', ['>', ['coalesce', ['get', 'orgCount'], 1], 1], 7, 6],
    mlDetailZoom + 6,
    ['case', ['>', ['coalesce', ['get', 'orgCount'], 1], 1], 9, 8],
  ]
}

function addressPointToFeature(
  point: OrganizationPoint,
): FeatureCollection<Point>['features'][number] {
  const orgCount = point.orgCount ?? 1
  const orgnrs = point.orgnrs ?? point.orgnr
  const typeList =
    point.typeList ?? (point.orgType === 'MIXED' ? ',,' : `,${point.orgType},`)
  const naeringskode = point.naeringskode ?? ''
  const properties: Record<string, string | number> = {
    orgnr: point.orgnr,
    orgType: point.orgType,
    orgCount,
    orgnrs,
    typeList,
    entityKind: point.entityKind ?? 'enhet',
    employeeBand: point.employeeBand ?? 'unknown',
    naeringskode: naeringskode.length >= 2 ? naeringskode.slice(0, 2) : naeringskode,
  }
  if (point.adresseId) properties.adresseId = point.adresseId

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
    properties,
  }
}

function pointsToGeoJson(
  points: OrganizationPoint[],
  _colorTypes: string[],
): FeatureCollection<Point> {
  if (points.length > 0 && isPreGroupedAddressPoint(points[0]!)) {
    return {
      type: 'FeatureCollection',
      features: points.map((point) => addressPointToFeature(point)),
    }
  }

  const features = groupPointsByLocation(points).map((group) => {
    const orgnrs = orgnrsFromGroup(group)
    const primary = group.orgs[0]
    const naeringskode = primary?.naeringskode ?? ''
    const properties: Record<string, string | number> = {
      orgnr: orgnrs[0]!,
      orgType: group.orgType,
      orgCount: group.orgCount,
      orgnrs: orgnrs.join(','),
      typeList: `,${[...new Set(group.orgs.map((org) => org.orgType))].sort().join(',')},`,
      entityKind: primary?.entityKind ?? 'enhet',
      employeeBand: primary?.employeeBand ?? 'unknown',
      naeringskode: naeringskode.length >= 2 ? naeringskode.slice(0, 2) : naeringskode,
    }
    if (group.adresseId) properties.adresseId = group.adresseId

    return {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [group.lng, group.lat] },
      properties,
    }
  })

  return { type: 'FeatureCollection', features }
}

const TRANSPARENT_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': 'rgba(0,0,0,0)' },
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
  /** @deprecated Clustering removed — ignored. */
  dotsClustering?: boolean
  vectorTilesUrl?: string | null
  lodLayers?: VectorTilesLayerSpec[]
  pointsLayer?: VectorTilesLayerSpec | null
  orgTypesForColors?: string[]
  onMarkerClick: (
    orgnrs: string[],
    latlng: L.LatLng,
    hint?: Partial<OrganizationPoint> | null,
  ) => void
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
  /**
   * No-op in vector/unified mode (layers self-gate via minzoom/maxzoom).
   * GeoJSON fallback still uses it to clear markers below detail zoom.
   */
  setVisible(visible: boolean): void
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
  // Leaflet DETAIL → GL DETAIL−1. Address markers must not paint below this.
  const pointsPaintMinZoom = Math.max(0, options.dotsDetailMinZoom - 1)
  const pointsSourceLayer = pointsLayerSpec?.name ?? VECTOR_TILES_LAYER

  let ready = false
  let styleReady = false
  let stale = false
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
      if (isPolygonLodLayer(layer.name)) return [districtFillLayerId(layer.name)]
      if (isDistrictMarkerLayer(layer.name)) return []
      return [aggregateLayerId(layer.name)]
    })
  }

  let clickLayers = vectorMode
    ? [...lodClickLayerIds(), POINT_LAYER_ID]
    : [POINT_LAYER_ID]

  if (vectorMode) ensurePmtilesProtocol()

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
  container.style.opacity = '1'
  container.style.visibility = 'visible'

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
  // Default 16; raise so dense urban viewport tiles arrive in parallel.
  setMaxParallelImageRequests(32)

  function propertyInFilter(
    property: string,
    values: string[],
  ): maplibregl.FilterSpecification | null {
    if (values.length === 0) return null
    return ['in', ['get', property], ['literal', values]]
  }

  function addressFilter(): maplibregl.FilterSpecification {
    const parts: maplibregl.FilterSpecification[] = []
    const typeFilter = propertyInFilter('orgType', dotFilters.orgTypes)
    if (typeFilter) {
      const typeListMatches = dotFilters.orgTypes.map(
        (orgType) => ['in', `,${orgType},`, ['get', 'typeList']] as maplibregl.FilterSpecification,
      )
      parts.push(['any', typeFilter, ...typeListMatches] as maplibregl.FilterSpecification)
    }
    return parts.length > 0 ? (['all', ...parts] as maplibregl.FilterSpecification) : true
  }

  function aggregateLayerFilter(): maplibregl.FilterSpecification {
    return propertyInFilter('dominantOrgType', dotFilters.orgTypes) ?? true
  }

  function applyTypeVisibility() {
    for (const spec of lodLayers) {
      const layerId = isPolygonLodLayer(spec.name)
        ? districtFillLayerId(spec.name)
        : aggregateLayerId(spec.name)
      if (mlMap.getLayer(layerId)) {
        mlMap.setFilter(layerId, aggregateLayerFilter())
      }
    }
    if (mlMap.getLayer(POINT_LAYER_ID)) {
      mlMap.setFilter(POINT_LAYER_ID, addressFilter())
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
    const fillOpacity = stale ? 0.28 : 0.42

    for (const spec of lodLayers) {
      if (isPolygonLodLayer(spec.name)) {
        const fillId = districtFillLayerId(spec.name)
        if (mlMap.getLayer(fillId)) {
          mlMap.setPaintProperty(fillId, 'fill-opacity', fillOpacity)
        }
      }
    }
    if (mlMap.getLayer(POINT_LAYER_ID)) {
      mlMap.setPaintProperty(POINT_LAYER_ID, 'circle-opacity', pointOpacity)
    }
  }

  function removeDataLayers() {
    if (mlMap.getLayer(POINT_LAYER_ID)) mlMap.removeLayer(POINT_LAYER_ID)
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
      const minzoom = spec.minZoom
      // Match tippecanoe band end (MapLibre hides at zoom >= maxzoom).
      const maxzoom = spec.maxZoom

      if (isPolygonLodLayer(spec.name)) {
        mlMap.addLayer({
          id: districtFillLayerId(spec.name),
          type: 'fill',
          source: SOURCE_ID,
          'source-layer': spec.name,
          minzoom,
          maxzoom,
          filter: aggregateLayerFilter(),
          paint: {
            'fill-color': bakedColorExpression(),
            'fill-opacity': 0.42,
            'fill-outline-color': '#0f172a',
          },
        })
        continue
      }

      if (isDistrictMarkerLayer(spec.name)) continue

      mlMap.addLayer({
        id: aggregateLayerId(spec.name),
        type: 'circle',
        source: SOURCE_ID,
        'source-layer': spec.name,
        minzoom,
        maxzoom,
        filter: aggregateLayerFilter(),
        paint: {
          'circle-color': bakedColorExpression(),
          'circle-radius': 4,
          'circle-stroke-width': 0.75,
          'circle-stroke-color': '#0f172a',
          'circle-opacity': 0.72,
        },
      })
    }
  }

  function addAddressLayers() {
    // One circle per address. Multi-org addresses are larger; click lists all orgnrs.
    // No symbol/split-square icons — those required per-frame addImage and dominated cost.
    mlMap.addLayer({
      id: POINT_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      ...(vectorMode ? { 'source-layer': pointsSourceLayer } : {}),
      minzoom: pointsPaintMinZoom,
      maxzoom: 24,
      filter: addressFilter(),
      paint: {
        'circle-color':
          currentTypes.length > 0 ? orgTypeColorExpression(currentTypes) : '#64748b',
        'circle-radius': pointRadiusExpression(options.dotsDetailMinZoom),
        'circle-stroke-width': [
          'case',
          ['>', ['coalesce', ['get', 'orgCount'], 1], 1],
          1.5,
          0.75,
        ],
        'circle-stroke-color': '#0f172a',
        'circle-opacity': 0.88,
      },
    })
  }

  function setupDataLayers() {
    if (!styleReady) return

    removeDataLayers()
    clickLayers = vectorMode
      ? [...lodClickLayerIds(), POINT_LAYER_ID]
      : [POINT_LAYER_ID]

    if (vectorMode && options.vectorTilesUrl) {
      mlMap.addSource(SOURCE_ID, {
        type: 'vector',
        url: options.vectorTilesUrl,
      })
      addAggregateLayers()
      addAddressLayers()
      applyPointColors(currentTypes)
      applyTypeVisibility()
      applyOpacity()
      ready = true
      return
    }

    mlMap.addSource(SOURCE_ID, {
      type: 'geojson',
      data: pointsToGeoJson(currentPoints, currentTypes),
    })
    addAddressLayers()
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
      source.setData(pointsToGeoJson(points, currentTypes))
      applyPointColors(currentTypes)
      applyTypeVisibility()
      applyOpacity()
    }
  }

  function initStyle() {
    if (styleReady) return
    styleReady = true
    setupDataLayers()
    if (pendingPoints) {
      updateSource(pendingPoints)
      pendingPoints = null
    }
  }

  mlMap.on('error', (event) => {
    if (!vectorMode) return
    options.onVectorTilesError?.(event.error?.message ?? 'Vector tile source failed')
  })

  mlMap.on('load', initStyle)
  mlMap.once('styledata', initStyle)

  function orgnrsFromFeature(feature: maplibregl.MapGeoJSONFeature): string[] {
    const orgCount = feature.properties?.orgCount as number | undefined
    const orgnrsProp = feature.properties?.orgnrs as string | undefined
    if (orgCount != null && orgCount > 1 && orgnrsProp) {
      return orgnrsProp.split(',').filter(Boolean)
    }
    const orgnr = feature.properties?.orgnr as string | undefined
    return orgnr ? [orgnr] : []
  }

  function hintFromFeature(
    feature: maplibregl.MapGeoJSONFeature,
  ): Partial<OrganizationPoint> | null {
    const props = feature.properties
    if (!props) return null
    const orgnr = props.orgnr as string | undefined
    if (!orgnr) return null
    return {
      orgnr,
      orgType: (props.orgType as string | undefined) ?? '',
      navn: props.navn as string | undefined,
      orgTypeLabel: props.orgTypeLabel as string | undefined,
      addressText: props.addressText as string | undefined,
      postnummer: props.postnummer as string | undefined,
      orgCount: props.orgCount as number | undefined,
      orgnrs: props.orgnrs as string | undefined,
      adresseId: props.adresseId as string | undefined,
    }
  }

  function featuresAtClick(latlng: L.LatLng): maplibregl.MapGeoJSONFeature[] {
    const point = mlMap.project([latlng.lng, latlng.lat])
    return mlMap.queryRenderedFeatures(
      [
        [point.x - CLICK_TOLERANCE_PX, point.y - CLICK_TOLERANCE_PX],
        [point.x + CLICK_TOLERANCE_PX, point.y + CLICK_TOLERANCE_PX],
      ],
      { layers: clickLayers.filter((id) => mlMap.getLayer(id)) },
    )
  }

  function isAggregateLayerId(layerId: string): boolean {
    return lodLayers.some((spec) => {
      if (isPolygonLodLayer(spec.name)) return layerId === districtFillLayerId(spec.name)
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
      const orgType =
        (aggregateFeature.properties?.dominantOrgType as string | undefined) ??
        (aggregateFeature.properties?.orgType as string | undefined)
      const count =
        (aggregateFeature.properties?.count as number | undefined) ??
        (aggregateFeature.properties?.total as number | undefined)
      if (orgType && count != null) {
        options.onAggregateClick?.({
          orgType,
          count,
          latlng: event.latlng,
          label: aggregateFeature.properties?.label as string | undefined,
          total: aggregateFeature.properties?.total as number | undefined,
          districtLevel: aggregateFeature.properties?.districtLevel as string | undefined,
          orgTypeBreakdown: aggregateFeature.properties?.orgTypeBreakdown as string | undefined,
        })
      }
      return
    }

    const pointFeature = features.find((feature) => feature.layer.id === POINT_LAYER_ID)
    if (!pointFeature) return
    const orgnrs = orgnrsFromFeature(pointFeature)
    if (orgnrs.length === 0) return
    const [lng, lat] = (pointFeature.geometry as Point).coordinates
    options.onMarkerClick(orgnrs, L.latLng(lat, lng), hintFromFeature(pointFeature))
  }

  function handleLeafletMouseMove(event: L.LeafletMouseEvent) {
    if (!ready) {
      map.getContainer().style.cursor = ''
      return
    }
    map.getContainer().style.cursor = featuresAtClick(event.latlng).length > 0 ? 'pointer' : ''
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
    setClustering() {
      // Removed — zoom LOD replaces clustering.
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
    setVisible(visible) {
      // Vector/unified mode: minzoom/maxzoom own visibility — keep GL canvas alive.
      if (vectorMode) {
        container.style.opacity = '1'
        container.style.visibility = 'visible'
        return
      }
      // GeoJSON fallback: hide markers below detail by clearing paint via opacity on layers.
      const value = visible ? 'visible' : 'none'
      if (mlMap.getLayer(POINT_LAYER_ID)) {
        mlMap.setLayoutProperty(POINT_LAYER_ID, 'visibility', value)
      }
      container.style.opacity = '1'
      container.style.visibility = 'visible'
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

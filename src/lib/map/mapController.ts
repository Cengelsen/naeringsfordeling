import L from 'leaflet'
import type { FeatureCollection } from 'geojson'
import type {
  DotsLoadState,
  MapSettings,
  MunicipalityCount,
  OrganizationPoint,
  Organisasjonsform,
  ViewportSummary,
} from '../types'
import {
  buildFylkeGeojson,
  fylkeFromKommune,
  geoBoundsCenter,
  geoBoundsIntersects,
  kommuneBoundsIndex,
  kommuneFeatures,
  type FylkeFeature,
  type GeoBounds,
  type KommuneFeature,
} from '../utils/geo'
import { kommuneScaleMax, roundUpTo10k } from '../utils/colors'
import {
  fetchOrganizationDetail,
  fetchOrganizationLocation,
  lookupOrganizationLocal,
  fetchOrganizationPoints,
  fetchDistrictStats,
  limitForZoom,
} from '../services/api'
import { dotsCache, dotsCacheKey, expandBbox } from './dotsCache'
import { canUseStaticTiles, filterPointsByMapFilters } from './points'
import { snapBboxToTileGrid } from '../../../shared/tiles'
import type { DotFilters } from './maplibreDotsLayer'
import {
  aggregateLayersFromManifest,
  lodTilesAvailable,
  orgDetailTilesCoverLeafletZoom,
  pointsLayerFromManifest,
  prefetchOrganizationTiles,
  probeVectorTiles,
  vectorTilesSourceUrl,
  type VectorTilesManifest,
} from './vectorTiles'
import { createDistrictColorLayer, type DistrictColorController } from './districtColorLayer'
import {
  activeDistrictLayer,
  probeDistrictColors,
  type DistrictColorsManifest,
} from './districtColors'
import { createDotsLayer, type DotsLayerController } from './dotsLayer'
import { forEachPathLayer } from './pathLayers'
import { formatOrgTypeBreakdownFromRecord } from './organizationPopups'
import {
  showOrganizationDetails as showOrganizationDetailsImpl,
  handleMarkerClick as handleMarkerClickImpl,
  handleAggregateClick as handleAggregateClickImpl,
  type PopupContext,
} from './popupController'
import { loadViewportSummary as loadViewportSummaryImpl } from './viewportStats'
import {
  styleKommuneFeature as styleKommuneFeatureImpl,
  styleFylkeFeature as styleFylkeFeatureImpl,
  bindHoverHighlight as bindHoverHighlightImpl,
} from './choroplethRenderer'

export interface LocateRequest {
  orgnr: string
  seq: number
}

export interface MapControllerCallbacks {
  onDotsStateChange: (state: DotsLoadState) => void
  onPointsChange: (points: OrganizationPoint[], allPoints: OrganizationPoint[]) => void
  onLoadingChange: (loading: boolean) => void
  onOrgFocusChange: (active: boolean) => void
  onMapZoomChange: (zoom: number) => void
  onWebglUnavailableChange: (unavailable: boolean) => void
  onVectorTilesManifestChange: (manifest: VectorTilesManifest | null) => void
  onDistrictColorsManifestChange: (manifest: DistrictColorsManifest | null) => void
  onVectorTilesDisabledChange: (disabled: boolean) => void
  getDotsState: () => DotsLoadState
}

const ORG_LOCATE_ZOOM = 18
const PREFETCH_BBOX_EXPANSION = 0.35
const DOTS_MOVE_RELOAD_DELAY_MS = 400
const DOTS_FILTER_RELOAD_DELAY_MS = 300

export class MapController {
  private map: L.Map
  private cb: MapControllerCallbacks

  private geoLayer: L.GeoJSON | null = null
  private dotsController: DotsLayerController | null = null
  private districtColorController: DistrictColorController | null = null
  private orgMarker: L.CircleMarker | null = null

  private loadAbort: AbortController | null = null
  private summaryAbort: AbortController | null = null
  private boundsTimer: ReturnType<typeof setTimeout> | undefined

  private kommuneBoundsByNummer = new Map<string, GeoBounds>()
  private dotsControllerUsesVector = false
  private dotsControllerUsesLod = false
  private lastPrefetchAt = 0

  private points: OrganizationPoint[] = []
  private allPoints: OrganizationPoint[] = []
  private orgFocusActive = false

  private vectorTilesManifest: VectorTilesManifest | null = null
  private districtColorsManifest: DistrictColorsManifest | null = null
  private vectorTilesDisabled = false
  private webglUnavailable = false

  constructor(map: L.Map, callbacks: MapControllerCallbacks) {
    this.map = map
    this.cb = callbacks
  }

  // ── Asset probing ──────────────────────────────────────────────────

  async probeAssets(settings: MapSettings): Promise<void> {
    const [districtResult, vectorResult] = await Promise.all([
      probeDistrictColors(),
      probeVectorTiles(),
    ])

    if (districtResult.available && districtResult.manifest) {
      this.districtColorsManifest = districtResult.manifest
      this.cb.onDistrictColorsManifestChange(districtResult.manifest)
      if (settings.visualization === 'dots') {
        this.scheduleDotsReload(settings, 0)
      }
    }

    if (vectorResult.available && vectorResult.manifest) {
      this.vectorTilesManifest = vectorResult.manifest
      this.cb.onVectorTilesManifestChange(vectorResult.manifest)
      if (settings.visualization === 'dots') {
        this.scheduleDotsReload(settings, 0)
      }
    }
  }

  // ── Derived helpers (mirror $derived logic from MapView) ───────────

  private districtColorsReady(): boolean {
    return this.districtColorsManifest !== null
  }

  private vectorTilesReady(settings: MapSettings): boolean {
    return (
      this.vectorTilesManifest !== null &&
      !this.vectorTilesDisabled &&
      !this.webglUnavailable &&
      canUseStaticTiles(settings)
    )
  }

  private detailOrgTilesReady(settings: MapSettings): boolean {
    return (
      this.vectorTilesReady(settings) &&
      orgDetailTilesCoverLeafletZoom(this.vectorTilesManifest, settings.dotsDetailMinZoom)
    )
  }

  private pmtilesLodReady(settings: MapSettings): boolean {
    return (
      this.vectorTilesReady(settings) &&
      !this.districtColorsReady() &&
      lodTilesAvailable(this.vectorTilesManifest)
    )
  }

  private aggregateZoomActive(settings: MapSettings, zoom: number): boolean {
    return settings.visualization === 'dots' && zoom < settings.dotsDetailMinZoom
  }

  private useVectorDotsController(settings: MapSettings): boolean {
    return (
      this.vectorTilesReady(settings) &&
      (this.pmtilesLodReady(settings) || this.detailOrgTilesReady(settings))
    )
  }

  // ── Kommun bounds index ────────────────────────────────────────────

  updateKommuneBounds(geojson: FeatureCollection | null): void {
    this.kommuneBoundsByNummer = geojson ? kommuneBoundsIndex(geojson) : new Map()
  }

  // ── DotsState ──────────────────────────────────────────────────────

  private updateDotsState(partial: Partial<DotsLoadState>): void {
    const current = this.cb.getDotsState()
    const next = { ...current, ...partial }
    if (JSON.stringify(next) === JSON.stringify(current)) return
    this.cb.onDotsStateChange(next)
  }

  // ── Org locate / focus ─────────────────────────────────────────────

  private clearOrgMarker(): void {
    this.orgMarker?.remove()
    this.orgMarker = null
  }

  private enterOrgFocusMode(): void {
    this.orgFocusActive = true
    this.cb.onOrgFocusChange(true)
    if (this.geoLayer) {
      this.geoLayer.remove()
      this.geoLayer = null
    }
    this.removeDistrictColorLayer()
    this.removeDotsController()
  }

  exitOrgFocusMode(
    settings: MapSettings,
    geojson: FeatureCollection | null,
    counts: MunicipalityCount[],
  ): void {
    if (!this.orgFocusActive) return
    this.orgFocusActive = false
    this.cb.onOrgFocusChange(false)
    this.clearOrgMarker()
    this.updateVisualization(settings, geojson, counts)
  }

  private showOrgMarker(latlng: L.LatLng): void {
    this.clearOrgMarker()
    this.orgMarker = L.circleMarker(latlng, {
      radius: 9,
      color: '#0369a1',
      fillColor: '#38bdf8',
      fillOpacity: 0.95,
      weight: 2,
    }).addTo(this.map)
  }

  async navigateToOrganization(
    orgnr: string,
    settings: MapSettings,
    orgForms: Organisasjonsform[],
  ): Promise<void> {
    this.enterOrgFocusMode()

    const popupCtx = this.makePopupCtx(settings, orgForms)

    try {
      const [location, localOrg] = await Promise.all([
        fetchOrganizationLocation(orgnr),
        lookupOrganizationLocal(orgnr),
      ])
      const org = localOrg ?? (await fetchOrganizationDetail(orgnr))

      if (location.lat != null && location.lng != null) {
        const latlng = L.latLng(location.lat, location.lng)
        this.showOrgMarker(latlng)
        this.map.flyTo(latlng, ORG_LOCATE_ZOOM, { duration: 0.8 })
        showOrganizationDetailsImpl(popupCtx, org, latlng)
        return
      }

      if (location.kommunenummer) {
        const bounds = this.kommuneBoundsByNummer.get(location.kommunenummer)
        if (bounds) {
          const [lat, lng] = geoBoundsCenter(bounds)
          const latlng = L.latLng(lat, lng)
          this.showOrgMarker(latlng)
          this.map.flyTo(latlng, ORG_LOCATE_ZOOM, { duration: 0.8 })
          showOrganizationDetailsImpl(
            popupCtx,
            org,
            latlng,
            'Kunne ikke geokode adressen – omtrentlig posisjon',
          )
          return
        }
      }

      L.popup({ maxWidth: 320 })
        .setLatLng(this.map.getCenter())
        .setContent('Fant organisasjonen, men ingen kartposisjon er tilgjengelig')
        .openOn(this.map)
    } catch (err) {
      L.popup({ maxWidth: 320 })
        .setLatLng(this.map.getCenter())
        .setContent(err instanceof Error ? err.message : 'Kunne ikke finne organisasjon')
        .openOn(this.map)
    }
  }

  locateOrganization(
    request: LocateRequest,
    settings: MapSettings,
    orgForms: Organisasjonsform[],
  ): void {
    void this.navigateToOrganization(request.orgnr, settings, orgForms)
  }

  // ── PopupContext factory ───────────────────────────────────────────

  private makePopupCtx(settings: MapSettings, orgForms: Organisasjonsform[]): PopupContext {
    return {
      getMap: () => this.map,
      getAllPoints: () => this.allPoints,
      getSettings: () => settings,
      getOrgForms: () => orgForms,
      navigateToOrganization: (orgnr) =>
        void this.navigateToOrganization(orgnr, settings, orgForms),
    }
  }

  // ── Template event handlers delegated from MapView ─────────────────

  handleMarkerClick(
    orgnrs: string[],
    latlng: L.LatLng,
    hint: Partial<OrganizationPoint> | null | undefined,
    settings: MapSettings,
    orgForms: Organisasjonsform[],
  ): void {
    handleMarkerClickImpl(this.makePopupCtx(settings, orgForms), orgnrs, latlng, hint)
  }

  handleAggregateClick(
    info: {
      orgType: string
      count: number
      latlng: L.LatLng
      label?: string
      total?: number
      districtLevel?: string
      orgTypeBreakdown?: string
    },
    orgForms: Organisasjonsform[],
  ): void {
    handleAggregateClickImpl(this.map, orgForms, info)
  }

  // ── Layer lifecycle ────────────────────────────────────────────────

  private disableVectorTiles(message: string, settings: MapSettings): void {
    this.vectorTilesDisabled = true
    this.cb.onVectorTilesDisabledChange(true)
    this.removeDotsController()
    this.scheduleDotsReload(settings, 0)
    this.updateDotsState({
      loading: false,
      phase: 'idle',
      message: `Vektorfliser utilgjengelige (${message}) – bruker database`,
    })
  }

  private removeDistrictColorLayer(): void {
    this.districtColorController?.remove()
    this.districtColorController = null
  }

  private hideDistrictColorLayer(): void {
    this.districtColorController?.hide()
  }

  private ensureBaseKommuner(
    geojson: FeatureCollection | null,
    settings: MapSettings,
    counts: MunicipalityCount[],
  ): void {
    if (!geojson) return
    if (this.geoLayer) {
      this.geoLayer.bringToBack()
      return
    }
    this.geoLayer = L.geoJSON(geojson, {
      style: (feature) => this.styleKommuneFeature(feature as KommuneFeature, settings, counts),
    }).addTo(this.map)
  }

  private prefetchDetailTiles(settings: MapSettings): void {
    if (!this.detailOrgTilesReady(settings)) return
    const zoom = this.map.getZoom()
    if (zoom < settings.dotsDetailMinZoom - 2) return
    const bakedMin =
      this.vectorTilesManifest?.layers?.find((l) => l.name === 'organizations')?.minZoom ??
      settings.dotsDetailMinZoom - 2
    void prefetchOrganizationTiles(this.map.getBounds(), {
      leafletZoom: Math.max(zoom, settings.dotsDetailMinZoom),
      bakedMinZoom: bakedMin,
    })
  }

  private kommunerInBounds(geojson: FeatureCollection | null): string[] {
    if (!geojson) return []
    const bounds = this.mapGeoBounds(this.map.getBounds())
    const matches: string[] = []
    for (const feature of kommuneFeatures(geojson)) {
      const kommunenummer = feature.properties.kommunenummer
      const featureBounds = this.kommuneBoundsByNummer.get(kommunenummer)
      if (featureBounds && geoBoundsIntersects(bounds, featureBounds)) {
        matches.push(kommunenummer)
      }
    }
    return matches
  }

  private fylkerInBounds(geojson: FeatureCollection | null): string[] {
    const fylker = new Set<string>()
    for (const kommunenummer of this.kommunerInBounds(geojson)) {
      fylker.add(fylkeFromKommune(kommunenummer))
    }
    return [...fylker].sort()
  }

  private ensureDistrictColorLayer(
    settings: MapSettings,
    orgForms: Organisasjonsform[],
    geojson: FeatureCollection | null,
  ): void {
    if (!this.districtColorsManifest) return

    if (!this.districtColorController) {
      this.districtColorController = createDistrictColorLayer(
        this.map,
        this.districtColorsManifest,
        {
          getViewportFylker: () => this.fylkerInBounds(geojson),
          getViewportBounds: () => this.map?.getBounds() ?? null,
          onFeatureClick: (feature, latlng) => {
            this.handleAggregateClick(
              {
                orgType: feature.properties.dominantOrgType,
                count: feature.properties.count,
                latlng,
                label: feature.properties.label,
                total: feature.properties.total ?? feature.properties.count,
                districtLevel: feature.properties.districtLevel,
                orgTypeBreakdown: feature.properties.orgTypeBreakdown,
              },
              orgForms,
            )
          },
        },
      )
    }

    this.districtColorController.setZoom(this.map.getZoom())
    this.districtColorController.setViewportFylker(this.fylkerInBounds(geojson))
    this.districtColorController.setFilters({
      orgTypes: settings.orgTypes,
      selectedFylke: settings.selectedFylke,
      selectedKommune: settings.selectedKommune,
    })
    this.districtColorController.show()
    this.districtColorController.bringToFront()

    const layer = activeDistrictLayer(this.districtColorsManifest, this.map.getZoom())
    if (layer?.id === 'kommune') {
      this.districtColorController.prefetchUpcoming(this.fylkerInBounds(geojson))
    }
  }

  private dotFiltersFromSettings(settings: MapSettings): DotFilters {
    return {
      orgTypes: settings.orgTypes,
      naeringskodeSections: settings.naeringskodeSections,
      employeeBands: settings.employeeBands,
      entityKinds: settings.entityKinds,
    }
  }

  private applyDotFilters(settings: MapSettings): void {
    this.dotsController?.setDotFilters(this.dotFiltersFromSettings(settings))
  }

  private ensureDotsController(settings: MapSettings, orgForms: Organisasjonsform[]): void {
    const vectorMode = this.useVectorDotsController(settings)
    const lodLayers = this.pmtilesLodReady(settings)
      ? aggregateLayersFromManifest(this.vectorTilesManifest)
      : []
    const useLod = lodLayers.length > 0
    const vectorUrl = vectorMode ? vectorTilesSourceUrl() : null
    const orgTypesForColors =
      this.districtColorsManifest?.orgTypes ??
      this.vectorTilesManifest?.orgTypes ??
      orgForms.map((form) => form.kode)

    if (
      this.dotsController &&
      this.dotsControllerUsesVector === vectorMode &&
      this.dotsControllerUsesLod === useLod
    ) {
      this.applyDotFilters(settings)
      return
    }

    this.dotsController?.remove()

    const { controller, usedWebgl } = createDotsLayer(this.map, {
      dotsDetailMinZoom: settings.dotsDetailMinZoom,
      dotsClustering: false,
      vectorTilesUrl: vectorUrl,
      lodLayers,
      pointsLayer: vectorMode ? pointsLayerFromManifest(this.vectorTilesManifest) : null,
      orgTypesForColors,
      onMarkerClick: (orgnrs, latlng, hint) =>
        this.handleMarkerClick(orgnrs, latlng, hint, settings, orgForms),
      onAggregateClick: (info) => this.handleAggregateClick(info, orgForms),
      onVectorTilesError: (msg) => this.disableVectorTiles(msg, settings),
    })

    this.dotsController = controller
    this.dotsControllerUsesVector = usedWebgl && vectorMode
    this.dotsControllerUsesLod = usedWebgl && useLod

    if (!usedWebgl) {
      this.webglUnavailable = true
      this.cb.onWebglUnavailableChange(true)
      this.updateDotsState({ webglUnavailable: true })
    }
  }

  private removeDotsController(): void {
    this.dotsController?.remove()
    this.dotsController = null
    this.dotsControllerUsesVector = false
    this.dotsControllerUsesLod = false
    this.points = []
    this.allPoints = []
    this.cb.onPointsChange([], [])
    dotsCache.clear()
  }

  // ── Choropleth helpers ─────────────────────────────────────────────

  private isKommuneVisible(kommunenummer: string, settings: MapSettings): boolean {
    if (settings.selectedKommune) return kommunenummer === settings.selectedKommune
    if (settings.selectedFylke) return fylkeFromKommune(kommunenummer) === settings.selectedFylke
    return true
  }

  private isFylkeVisible(fylkesnummer: string, settings: MapSettings): boolean {
    if (settings.selectedFylke) return fylkesnummer === settings.selectedFylke
    return true
  }

  private kommuneCount(kommunenummer: string, counts: MunicipalityCount[]): number {
    return counts.find((c) => c.kommunenummer === kommunenummer)?.count ?? 0
  }

  private fylkeCount(fylkesnummer: string, counts: MunicipalityCount[]): number {
    let total = 0
    for (const { kommunenummer, count } of counts) {
      if (fylkeFromKommune(kommunenummer) === fylkesnummer) total += count
    }
    return total
  }

  private maxCount(settings: MapSettings, counts: MunicipalityCount[]): number {
    const isFylke = settings.visualization === 'choropleth' && settings.districtLevel === 'fylke'
    if (isFylke) {
      const fylkeMap = new Map<string, number>()
      for (const { kommunenummer, count } of counts) {
        const fylke = fylkeFromKommune(kommunenummer)
        fylkeMap.set(fylke, (fylkeMap.get(fylke) ?? 0) + count)
      }
      return roundUpTo10k(Math.max(...fylkeMap.values(), 1))
    }
    return kommuneScaleMax(counts.map((c) => c.count))
  }

  private styleKommuneFeature(
    feature: KommuneFeature | undefined,
    settings: MapSettings,
    counts: MunicipalityCount[],
  ) {
    return styleKommuneFeatureImpl(feature, {
      isVisible: (k) => this.isKommuneVisible(k, settings),
      getCount: (k) => this.kommuneCount(k, counts),
      visualization: settings.visualization,
      maxCount: this.maxCount(settings, counts),
      colorScheme: settings.colorScheme,
    })
  }

  private styleFylkeFeature(
    feature: FylkeFeature | undefined,
    settings: MapSettings,
    counts: MunicipalityCount[],
  ) {
    return styleFylkeFeatureImpl(feature, {
      isVisible: (f) => this.isFylkeVisible(f, settings),
      getCount: (f) => this.fylkeCount(f, counts),
      maxCount: this.maxCount(settings, counts),
      colorScheme: settings.colorScheme,
    })
  }

  private bindHoverHighlight(path: L.Path, featureLayer: L.Layer): void {
    bindHoverHighlightImpl(path, featureLayer, {
      getMap: () => this.map,
      getGeoLayer: () => this.geoLayer,
    })
  }

  private async showDistrictStatsPopup(
    options: {
      level: 'fylke' | 'kommune'
      districtId: string
      label: string
      latlng: L.LatLng
      fallbackTotal: number
    },
    settings: MapSettings,
    orgForms: Organisasjonsform[],
  ): Promise<void> {
    const levelLabel = options.level === 'fylke' ? 'Fylke' : 'Kommune'
    const popup = L.popup({ maxWidth: 320 })
      .setLatLng(options.latlng)
      .setContent(`<strong>${options.label}</strong><br>Laster…`)
      .openOn(this.map)

    try {
      const stats = await fetchDistrictStats(options.level, options.districtId, settings)
      const total = stats.total > 0 ? stats.total : options.fallbackTotal
      const breakdown = formatOrgTypeBreakdownFromRecord(stats.byOrgType, orgForms)
      popup.setContent(
        `<strong>${options.label}</strong><br>
         ${levelLabel} ${options.districtId}<br>
         <strong>${total.toLocaleString('nb-NO')}</strong> organisasjoner${breakdown}`,
      )
    } catch {
      popup.setContent(
        `<strong>${options.label}</strong><br>
         ${levelLabel} ${options.districtId}<br>
         <strong>${options.fallbackTotal.toLocaleString('nb-NO')}</strong> organisasjoner`,
      )
    }
  }

  private bindDistrictLayerEvents(
    layer: L.Layer,
    options: {
      level: 'fylke' | 'kommune'
      districtId: string
      label: string
      fallbackTotal: number
    },
    settings: MapSettings,
    orgForms: Organisasjonsform[],
  ): void {
    forEachPathLayer(layer, (path) => {
      path.on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        void this.showDistrictStatsPopup({ ...options, latlng: event.latlng }, settings, orgForms)
      })
      this.bindHoverHighlight(path, layer)
    })
  }

  private bindKommuneEvents(
    layer: L.Layer,
    feature: KommuneFeature,
    settings: MapSettings,
    orgForms: Organisasjonsform[],
    counts: MunicipalityCount[],
  ): void {
    const props = feature.properties
    this.bindDistrictLayerEvents(
      layer,
      {
        level: 'kommune',
        districtId: props.kommunenummer,
        label: props.kommunenavn ?? props.name ?? props.kommunenummer,
        fallbackTotal: this.kommuneCount(props.kommunenummer, counts),
      },
      settings,
      orgForms,
    )
  }

  private bindFylkeEvents(
    layer: L.Layer,
    feature: FylkeFeature,
    settings: MapSettings,
    orgForms: Organisasjonsform[],
    counts: MunicipalityCount[],
  ): void {
    const props = feature.properties
    this.bindDistrictLayerEvents(
      layer,
      {
        level: 'fylke',
        districtId: props.fylkesnummer,
        label: props.fylkesnavn,
        fallbackTotal: this.fylkeCount(props.fylkesnummer, counts),
      },
      settings,
      orgForms,
    )
  }

  // ── Rendering ──────────────────────────────────────────────────────

  private renderChoropleth(
    geojson: FeatureCollection,
    settings: MapSettings,
    orgForms: Organisasjonsform[],
    counts: MunicipalityCount[],
  ): void {
    this.removeDotsController()

    if (this.geoLayer) this.geoLayer.remove()

    const isFylkeLevel =
      settings.visualization === 'choropleth' && settings.districtLevel === 'fylke'

    if (isFylkeLevel) {
      const fylkeGeojson = buildFylkeGeojson(geojson)
      if (!fylkeGeojson) return
      this.geoLayer = L.geoJSON(fylkeGeojson, {
        style: (feature) => this.styleFylkeFeature(feature as FylkeFeature, settings, counts),
        onEachFeature: (feature, layer) =>
          this.bindFylkeEvents(layer, feature as FylkeFeature, settings, orgForms, counts),
      }).addTo(this.map)
      return
    }

    this.geoLayer = L.geoJSON(geojson, {
      style: (feature) => this.styleKommuneFeature(feature as KommuneFeature, settings, counts),
      onEachFeature: (feature, layer) =>
        this.bindKommuneEvents(layer, feature as KommuneFeature, settings, orgForms, counts),
    }).addTo(this.map)
  }

  private renderBaseKommuner(
    geojson: FeatureCollection,
    settings: MapSettings,
    counts: MunicipalityCount[],
  ): void {
    if (this.geoLayer) this.geoLayer.remove()

    this.geoLayer = L.geoJSON(geojson, {
      style: (feature) => this.styleKommuneFeature(feature as KommuneFeature, settings, counts),
    }).addTo(this.map)
  }

  // ── Viewport stats ────────────────────────────────────────────────

  private updateRenderedFeatureCount(settings: MapSettings): void {
    if (this.map.getZoom() < settings.dotsDetailMinZoom) {
      this.updateDotsState({ renderedFeatureCount: 0 })
      return
    }
    const count = this.dotsController?.countRenderedFeatures?.() ?? 0
    this.updateDotsState({ renderedFeatureCount: count })
  }

  private async loadViewportSummary(
    settings: MapSettings,
    geojson: FeatureCollection | null,
  ): Promise<void> {
    return loadViewportSummaryImpl({
      getMap: () => this.map,
      getSettings: () => settings,
      isOrgFocusActive: () => this.orgFocusActive,
      getKommunerInBounds: () => this.kommunerInBounds(geojson),
      getBbox: (bounds) => this.mapBbox(bounds),
      updateDotsState: (partial) => this.updateDotsState(partial),
      updateRenderedFeatureCount: () => this.updateRenderedFeatureCount(settings),
      abortPrevious: () => {
        this.summaryAbort?.abort()
        this.summaryAbort = new AbortController()
        return this.summaryAbort.signal
      },
    })
  }

  // ── Point application ─────────────────────────────────────────────

  private applyPoints(
    nextPoints: OrganizationPoint[],
    truncated: boolean,
    kommuner: number,
    settings: MapSettings,
  ): void {
    const visiblePoints = filterPointsByMapFilters(nextPoints, settings)
    this.allPoints = nextPoints
    this.points = visiblePoints
    this.cb.onPointsChange(visiblePoints, nextPoints)
    this.dotsController?.setVisible(true)
    this.dotsController?.setPoints(visiblePoints)
    this.applyDotFilters(settings)
    this.dotsController?.setStale(false)
    this.dotsController?.bringToFront()
    const visibleCount = visiblePoints.length
    this.updateDotsState({
      loading: false,
      phase: 'idle',
      organizations: visibleCount,
      geocoded: visibleCount,
      skipped: 0,
      kommuner,
      message: truncated ? 'Viser et utvalg av organisasjoner – zoom inn for flere detaljer' : null,
    })
  }

  private applyBundledSummary(
    summary: ViewportSummary | undefined,
    settings: MapSettings,
    geojson: FeatureCollection | null,
  ): void {
    if (!summary) {
      void this.loadViewportSummary(settings, geojson)
      return
    }
    this.updateDotsState({
      statsLoading: false,
      viewportSummary: summary,
      statsApproximate: false,
      geocoded: summary.geocodedInBbox,
      organizations: summary.geocodedInBbox,
      skipped: summary.ungeocodedInViewport,
      kommuner: summary.kommunerInViewport,
    })
    this.updateRenderedFeatureCount(settings)
  }

  // ── Org type visibility ───────────────────────────────────────────

  applyOrgTypeVisibility(
    settings: MapSettings,
    orgForms: Organisasjonsform[],
    geojson: FeatureCollection | null,
  ): void {
    const zoom = this.map.getZoom()
    const atAggregate = this.aggregateZoomActive(settings, zoom)

    if (atAggregate && this.districtColorsReady()) {
      this.ensureDistrictColorLayer(settings, orgForms, geojson)
      return
    }
    if (atAggregate && this.pmtilesLodReady(settings)) {
      this.applyDotFilters(settings)
      this.updateRenderedFeatureCount(settings)
      return
    }
    this.applyDotFilters(settings)
    if (this.detailOrgTilesReady(settings)) {
      this.updateRenderedFeatureCount(settings)
      return
    }
    const count = filterPointsByMapFilters(this.allPoints, settings).length
    this.updateDotsState({
      organizations: count,
      geocoded: count,
    })
  }

  // ── Utility ────────────────────────────────────────────────────────

  private mapGeoBounds(bounds: L.LatLngBounds): GeoBounds {
    return {
      minLat: bounds.getSouth(),
      maxLat: bounds.getNorth(),
      minLng: bounds.getWest(),
      maxLng: bounds.getEast(),
    }
  }

  private mapBbox(bounds: L.LatLngBounds): [number, number, number, number] {
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
  }

  private dataFiltersKey(settings: MapSettings): string {
    return [
      settings.excludeKonkurs,
      settings.excludeUnderAvvikling,
      settings.vatRegisteredOnly,
      settings.naeringskodeSections.join(','),
      settings.employeeBands.join(','),
      settings.entityKinds.join(','),
      settings.konsernMembersOnly,
    ].join('|')
  }

  // ── Vector tiles state application ────────────────────────────────

  private applyVectorTilesState(
    settings: MapSettings,
    orgForms: Organisasjonsform[],
    options: { includeViewportSummary?: boolean; geojson?: FeatureCollection | null } = {},
  ): void {
    this.hideDistrictColorLayer()
    this.ensureDotsController(settings, orgForms)
    this.dotsController?.setVisible(true)
    this.applyDotFilters(settings)
    this.dotsController?.setStale(false)
    this.dotsController?.bringToFront()
    this.prefetchDetailTiles(settings)
    this.updateDotsState({
      loading: false,
      phase: 'idle',
      message: null,
      organizations: this.vectorTilesManifest?.total ?? 0,
      geocoded: this.vectorTilesManifest?.total ?? 0,
    })
    this.updateRenderedFeatureCount(settings)
    if (options.includeViewportSummary) {
      void this.loadViewportSummary(settings, options.geojson ?? null)
    }
  }

  // ── Prefetch ──────────────────────────────────────────────────────

  private async prefetchExpanded(
    bbox: [number, number, number, number],
    targetKommuner: string[],
    zoom: number,
    settings: MapSettings,
  ): Promise<void> {
    const expanded = snapBboxToTileGrid(expandBbox(bbox, PREFETCH_BBOX_EXPANSION), zoom)
    const key = dotsCacheKey({
      bbox: expanded,
      kommunenumre: targetKommuner,
      filters: this.dataFiltersKey(settings),
      zoom,
      clustering: false,
    })

    if (dotsCache.getMemory(key)) return

    const schedule =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback
        : (cb: () => void) => setTimeout(cb, 300)

    schedule(async () => {
      try {
        const result = await fetchOrganizationPoints(settings, {
          bbox: expanded,
          kommunenumre: targetKommuner,
          zoom,
          limit: limitForZoom(zoom),
        })
        await dotsCache.set(key, {
          points: result.points,
          truncated: result.truncated,
          savedAt: Date.now(),
          summary: result.summary,
        })
      } catch {
        // Prefetch failures are non-critical
      }
    })
  }

  // ── loadDots + scheduling ──────────────────────────────────────────

  async loadDots(
    settings: MapSettings,
    orgForms: Organisasjonsform[],
    geojson: FeatureCollection | null,
    counts: MunicipalityCount[],
  ): Promise<void> {
    if (settings.visualization !== 'dots' || this.orgFocusActive) return

    const zoom = this.map.getZoom()
    const atAggregateZoom = zoom < settings.dotsDetailMinZoom

    if (atAggregateZoom && this.districtColorsReady()) {
      if (this.detailOrgTilesReady(settings)) {
        this.ensureDotsController(settings, orgForms)
        this.dotsController?.setVisible(true)
        this.prefetchDetailTiles(settings)
      } else if (!this.useVectorDotsController(settings)) {
        this.removeDotsController()
      }
      this.ensureBaseKommuner(geojson, settings, counts)
      this.ensureDistrictColorLayer(settings, orgForms, geojson)
      this.updateDotsState({
        loading: false,
        phase: 'idle',
        message: null,
        skipped: 0,
      })
      void this.loadViewportSummary(settings, geojson)
      return
    }

    if (atAggregateZoom && this.pmtilesLodReady(settings)) {
      this.hideDistrictColorLayer()
      this.applyVectorTilesState(settings, orgForms, {
        includeViewportSummary: true,
        geojson,
      })
      return
    }

    if (atAggregateZoom) {
      this.hideDistrictColorLayer()
      this.removeDotsController()
      this.ensureBaseKommuner(geojson, settings, counts)
      this.updateDotsState({
        loading: false,
        phase: 'idle',
        message:
          'Distriktsfliser mangler. Kjør yarn download-grunnkretser && yarn export-district-colors',
      })
      void this.loadViewportSummary(settings, geojson)
      return
    }

    this.hideDistrictColorLayer()
    this.ensureBaseKommuner(geojson, settings, counts)

    if (this.detailOrgTilesReady(settings)) {
      this.applyVectorTilesState(settings, orgForms, {
        includeViewportSummary: true,
        geojson,
      })
      return
    }

    this.ensureDotsController(settings, orgForms)
    this.dotsController?.setVisible(true)

    const targetKommuner = this.kommunerInBounds(geojson)
    const bounds = this.map.getBounds()
    const bbox = snapBboxToTileGrid(this.mapBbox(bounds), zoom)

    if (targetKommuner.length === 0) {
      this.points = []
      this.allPoints = []
      this.cb.onPointsChange([], [])
      this.dotsController?.setPoints([])
      this.updateDotsState({
        loading: false,
        phase: 'idle',
        organizations: 0,
        geocoded: 0,
        skipped: 0,
        kommuner: 0,
        message: null,
      })
      void this.loadViewportSummary(settings, geojson)
      return
    }

    const cacheKey = dotsCacheKey({
      bbox,
      kommunenumre: targetKommuner,
      filters: this.dataFiltersKey(settings),
      zoom,
      clustering: false,
    })

    const cached = await dotsCache.get(cacheKey)
    if (cached) {
      this.applyPoints(cached.points, cached.truncated, targetKommuner.length, settings)
      this.prefetchExpanded(bbox, targetKommuner, zoom, settings)
      this.applyBundledSummary(cached.summary, settings, geojson)
      return
    }

    this.loadAbort?.abort()
    this.loadAbort = new AbortController()
    const signal = this.loadAbort.signal

    this.dotsController?.setStale(true)
    this.updateDotsState({
      loading: true,
      phase: 'fetching',
      message: 'Henter organisasjoner fra database…',
      kommuner: targetKommuner.length,
    })

    try {
      const result = await fetchOrganizationPoints(
        settings,
        {
          bbox,
          kommunenumre: targetKommuner,
          zoom,
          limit: limitForZoom(zoom),
        },
        signal,
      )

      if (signal.aborted) return

      await dotsCache.set(cacheKey, {
        points: result.points,
        truncated: result.truncated,
        savedAt: Date.now(),
        summary: result.summary,
      })

      this.applyPoints(result.points, result.truncated, targetKommuner.length, settings)
      this.prefetchExpanded(bbox, targetKommuner, zoom, settings)
      this.applyBundledSummary(result.summary, settings, geojson)
    } catch (err) {
      if (signal.aborted) return
      this.dotsController?.setStale(false)
      this.updateDotsState({
        loading: false,
        phase: 'idle',
        organizations: this.points.length,
        geocoded: this.points.length,
        skipped: 0,
        kommuner: targetKommuner.length,
        message: err instanceof Error ? err.message : 'Kunne ikke laste organisasjoner',
      })
    }
  }

  scheduleDotsReload(settings: MapSettings, delay = DOTS_FILTER_RELOAD_DELAY_MS): void {
    if (settings.visualization !== 'dots' || this.orgFocusActive) return
    clearTimeout(this.boundsTimer)
    this.boundsTimer = window.setTimeout(() => {
      this._pendingLoadSettings = null
      void this.loadDots(
        this._cachedSettings!,
        this._cachedOrgForms!,
        this._cachedGeojson,
        this._cachedCounts!,
      )
    }, delay)
  }

  /**
   * Cached references so that scheduled timer callbacks can access the latest
   * settings/geojson/counts without closures over stale Svelte state.
   */
  private _cachedSettings: MapSettings | null = null
  private _cachedOrgForms: Organisasjonsform[] | null = null
  private _cachedGeojson: FeatureCollection | null = null
  private _cachedCounts: MunicipalityCount[] | null = null
  private _pendingLoadSettings: MapSettings | null = null

  /**
   * Keep cached references in sync so timer-based reloads use current data.
   */
  updateCachedState(
    settings: MapSettings,
    orgForms: Organisasjonsform[],
    geojson: FeatureCollection | null,
    counts: MunicipalityCount[],
  ): void {
    this._cachedSettings = settings
    this._cachedOrgForms = orgForms
    this._cachedGeojson = geojson
    this._cachedCounts = counts
  }

  scheduleDotsReloadOnMove(settings: MapSettings): void {
    if (this.detailOrgTilesReady(settings)) {
      this.prefetchDetailTiles(settings)
    }
    this.scheduleDotsReload(settings, DOTS_MOVE_RELOAD_DELAY_MS)
  }

  schedulePrefetchDuringMove(settings: MapSettings): void {
    if (!this.detailOrgTilesReady(settings)) return
    const zoom = this.map.getZoom()
    if (zoom < settings.dotsDetailMinZoom - 2) return
    const now = performance.now()
    if (now - this.lastPrefetchAt < 120) return
    this.lastPrefetchAt = now
    this.prefetchDetailTiles(settings)
  }

  scheduleDotsReloadOnZoom(settings: MapSettings): void {
    if (this.detailOrgTilesReady(settings)) {
      this.prefetchDetailTiles(settings)
    }
    this.scheduleDotsReload(settings, 0)
  }

  handleMapZoomEnd(settings: MapSettings): number {
    const zoom = this.map.getZoom()
    this.cb.onMapZoomChange(zoom)
    this.scheduleDotsReloadOnZoom(settings)
    return zoom
  }

  // ── Data filter change ─────────────────────────────────────────────

  handleDataFilterChange(settings: MapSettings): void {
    dotsCache.clear()
    if (
      this.dotsController &&
      this.dotsControllerUsesVector !== this.useVectorDotsController(settings)
    ) {
      this.removeDotsController()
    }
    this.scheduleDotsReload(settings)
  }

  // ── Main visualization update ──────────────────────────────────────

  updateVisualization(
    settings: MapSettings,
    geojson: FeatureCollection | null,
    counts: MunicipalityCount[],
    orgForms?: Organisasjonsform[],
  ): void {
    if (this.orgFocusActive) {
      if (this.geoLayer) {
        this.geoLayer.remove()
        this.geoLayer = null
      }
      this.removeDotsController()
      return
    }

    if (settings.visualization === 'choropleth') {
      this.removeDistrictColorLayer()
      this.removeDotsController()
      if (geojson) this.renderChoropleth(geojson, settings, orgForms ?? [], counts)
      return
    }

    if (geojson) this.renderBaseKommuner(geojson, settings, counts)
    if (this.geoLayer) this.geoLayer.bringToBack()
    this.ensureDotsController(settings, orgForms ?? [])
    this.dotsController?.bringToFront()
    this.scheduleDotsReload(settings, 0)
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  destroy(): void {
    clearTimeout(this.boundsTimer)
    this.loadAbort?.abort()
    this.summaryAbort?.abort()
    this.removeDistrictColorLayer()
    this.removeDotsController()
    this.clearOrgMarker()
  }
}

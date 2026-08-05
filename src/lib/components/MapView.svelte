<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import L from 'leaflet'
  import type { FeatureCollection } from 'geojson'
  import type {
    DotsLoadState,
    MapSettings,
    MunicipalityCount,
    Organization,
    OrganizationPoint,
    Organisasjonsform,
  } from '../types'
  import { kommuneScaleMax, roundUpTo10k } from '../utils/colors'
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
  import { colorForOrgType } from '../utils/orgTypeColors'
  import {
    fetchOrganizationDetail,
    fetchOrganizationLocation,
    fetchKonsernstruktur,
    lookupOrganizationLocal,
    fetchOrganizationPoints,
    fetchDistrictStats,
    limitForZoom,
  } from '../services/api'
  import { dotsCache, dotsCacheKey, expandBbox } from '../map/dotsCache'
  import {
    canUseStaticTiles,
    filterPointsByMapFilters,
    normalizeOrgnr,
    organizationFromPoint,
  } from '../map/points'
  import type { DotFilters } from '../map/maplibreDotsLayer'
  import {
    aggregateLayersFromManifest,
    lodTilesAvailable,
    orgDetailTilesCoverLeafletZoom,
    pointsLayerFromManifest,
    prefetchOrganizationTiles,
    probeVectorTiles,
    vectorTilesSourceUrl,
    type VectorTilesManifest,
  } from '../map/vectorTiles'
  import {
    createDistrictColorLayer,
    type DistrictColorController,
  } from '../map/districtColorLayer'
  import {
    activeDistrictLayer,
    detailLevelLabel,
    probeDistrictColors,
    type DistrictColorsManifest,
  } from '../map/districtColors'
  import { createDotsLayer, type DotsLayerController } from '../map/dotsLayer'
  import { forEachPathLayer } from '../map/pathLayers'
  import {
    orgPopupHtml,
    flattenKonsernOrgnrs,
    konsernTreeHtml,
    addressPopupHtml,
    formatOrgTypeBreakdownHtml,
    formatOrgTypeBreakdownFromRecord,
    wireKonsernPopupLinks,
    resolveOrganization,
    resolveOrganizations,
    seedHint,
  } from '../map/organizationPopups'
  import {
    loadViewportSummary as loadViewportSummaryImpl,
  } from '../map/viewportStats'
  import {
    styleKommuneFeature as styleKommuneFeatureImpl,
    styleFylkeFeature as styleFylkeFeatureImpl,
    bindHoverHighlight as bindHoverHighlightImpl,
  } from '../map/choroplethRenderer'
  import Legend from './Legend.svelte'
  import OrgTypeLegend from './OrgTypeLegend.svelte'

  interface LocateRequest {
    orgnr: string
    seq: number
  }

  interface Props {
    geojson: FeatureCollection | null
    counts: MunicipalityCount[]
    settings: MapSettings
    orgForms: Organisasjonsform[]
    locateRequest?: LocateRequest | null
    onDotsStateChange?: (state: DotsLoadState) => void
  }

  let { geojson, counts, settings, orgForms, locateRequest = null, onDotsStateChange }: Props = $props()

  let mapContainer: HTMLDivElement
  let map: L.Map | null = null
  let mapZoom = $state(5)
  let geoLayer: L.GeoJSON | null = null
  let dotsController: DotsLayerController | null = null
  let points = $state<OrganizationPoint[]>([])
  let allPoints = $state<OrganizationPoint[]>([])
  let dotsState = $state<DotsLoadState>({
    loading: false,
    phase: 'idle',
    organizations: 0,
    geocoded: 0,
    skipped: 0,
    kommuner: 0,
    message: null,
  })

  let loadAbort: AbortController | null = null
  let summaryAbort: AbortController | null = null
  let boundsTimer: ReturnType<typeof setTimeout> | undefined
  let kommuneBoundsByNummer = new Map<string, GeoBounds>()
  let vectorTilesManifest = $state<VectorTilesManifest | null>(null)
  let districtColorsManifest = $state<DistrictColorsManifest | null>(null)
  let districtColorController: DistrictColorController | null = null
  let vectorTilesDisabled = $state(false)
  let webglUnavailable = $state(false)
  let webglBannerDismissed = $state(false)
  let orgFocusActive = $state(false)
  let orgMarker: L.CircleMarker | null = null
  let konsernOverlay: L.LayerGroup | null = null

  const ORG_LOCATE_ZOOM = 18
  const PREFETCH_BBOX_EXPANSION = 0.35

  /** Pre-rendered district/grunnkrets GeoJSON (preferred aggregate path). */
  const districtColorsReady = $derived(districtColorsManifest !== null)

  /** Individual address PMTiles at detail zoom (requires default bake-in filters). */
  const vectorTilesReady = $derived(
    vectorTilesManifest !== null &&
      !vectorTilesDisabled &&
      !webglUnavailable &&
      canUseStaticTiles(settings),
  )

  /**
   * Org PMTiles cover Leaflet detail only when baked from GL zoom (Leaflet−1).
   * Older archives (organizations minZoom 15) miss Leaflet z15 and were also
   * tippecanoe densest-dropped — fall back to the live API for those.
   */
  const detailOrgTilesReady = $derived(
    vectorTilesReady &&
      orgDetailTilesCoverLeafletZoom(vectorTilesManifest, settings.dotsDetailMinZoom),
  )

  /**
   * PMTiles aggregate fill layers — only when district GeoJSON is unavailable.
   * Leaflet district GeoJSON is the reliable primary path for grunnkretser.
   */
  const pmtilesLodReady = $derived(
    vectorTilesReady && !districtColorsReady && lodTilesAvailable(vectorTilesManifest),
  )

  const aggregateZoomActive = $derived(
    settings.visualization === 'dots' && mapZoom < settings.dotsDetailMinZoom,
  )

  /**
   * MapLibre vector overlay only when it can actually render something useful:
   * - address tiles at detail, and/or
   * - PMTiles LOD fills (no district GeoJSON).
   * Do NOT mount a vector overlay merely because aggregateZoomActive — that
   * created a useless GL context and forced mode flips on z15 without tiles.
   */
  const useVectorDotsController = $derived(
    vectorTilesReady && (pmtilesLodReady || detailOrgTilesReady),
  )

  const currentDetailLevel = $derived(
    detailLevelLabel(mapZoom, {
      visualization: settings.visualization,
      districtLevel: settings.districtLevel,
      dotsDetailMinZoom: settings.dotsDetailMinZoom,
      manifest: districtColorsManifest,
    }),
  )

  const dotsSourceLabel = $derived.by(() => {
    if (districtColorsReady && aggregateZoomActive) return 'distriktsfliser'
    if (pmtilesLodReady && aggregateZoomActive) return 'vektorfliser (LOD)'
    if (detailOrgTilesReady) return 'vektorfliser'
    if (webglUnavailable) return 'Leaflet-fallback'
    return 'SQLite-database'
  })

  const countMap = $derived(new Map(counts.map((c) => [c.kommunenummer, c.count])))

  const fylkeCountMap = $derived.by(() => {
    const map = new Map<string, number>()
    for (const { kommunenummer, count } of counts) {
      const fylke = fylkeFromKommune(kommunenummer)
      map.set(fylke, (map.get(fylke) ?? 0) + count)
    }
    return map
  })

  const isFylkeLevel = $derived(
    settings.visualization === 'choropleth' && settings.districtLevel === 'fylke',
  )

  const maxCount = $derived.by(() => {
    if (isFylkeLevel) {
      return roundUpTo10k(Math.max(...fylkeCountMap.values(), 1))
    }

    return kommuneScaleMax(counts.map((c) => c.count))
  })

  const totalVisible = $derived(
    settings.visualization === 'dots'
      ? (dotsState.statsLoading ? null : (dotsState.viewportSummary?.addressesInBbox ?? null))
      : counts.reduce((sum, c) => sum + c.count, 0),
  )

  const fylkeGeojson = $derived(geojson ? buildFylkeGeojson(geojson) : null)

  function kommuneCount(kommunenummer: string): number {
    return countMap.get(kommunenummer) ?? 0
  }

  function fylkeCount(fylkesnummer: string): number {
    return fylkeCountMap.get(fylkesnummer) ?? 0
  }

  const orgTypeLegendItems = $derived.by(() => {
    const manifestTypes =
      districtColorsManifest?.orgTypes ?? vectorTilesManifest?.orgTypes ?? null
    if (manifestTypes) {
      return manifestTypes.map((kode) => {
        const meta = orgForms.find((f) => f.kode === kode)
        return {
          kode,
          label: meta?.beskrivelse ?? kode,
          color: colorForOrgType(kode, manifestTypes),
        }
      })
    }

    const types = [...new Set(allPoints.map((point) => point.orgType))].sort()
    return types.map((kode) => {
      const meta = orgForms.find((f) => f.kode === kode)
      return {
        kode,
        label: meta?.beskrivelse ?? kode,
        color: colorForOrgType(kode, types),
      }
    })
  })

  function isKommuneVisible(kommunenummer: string): boolean {
    if (settings.selectedKommune) {
      return kommunenummer === settings.selectedKommune
    }
    if (settings.selectedFylke) {
      return fylkeFromKommune(kommunenummer) === settings.selectedFylke
    }
    return true
  }

  function isFylkeVisible(fylkesnummer: string): boolean {
    if (settings.selectedFylke) {
      return fylkesnummer === settings.selectedFylke
    }
    return true
  }

  function mapGeoBounds(bounds: L.LatLngBounds): GeoBounds {
    return {
      minLat: bounds.getSouth(),
      maxLat: bounds.getNorth(),
      minLng: bounds.getWest(),
      maxLng: bounds.getEast(),
    }
  }

  function mapBbox(bounds: L.LatLngBounds): [number, number, number, number] {
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
  }

  function dotFiltersFromSettings(): DotFilters {
    return {
      orgTypes: settings.orgTypes,
      naeringskodeSections: settings.naeringskodeSections,
      employeeBands: settings.employeeBands,
      entityKinds: settings.entityKinds,
    }
  }

  function applyDotFilters() {
    dotsController?.setDotFilters(dotFiltersFromSettings())
  }

  function dataFiltersKey(): string {
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

  function clearKonsernOverlay() {
    konsernOverlay?.remove()
    konsernOverlay = null
  }

  function showKonsernOverlay(rootOrgnr: string, memberOrgnrs: string[]) {
    if (!map) return
    clearKonsernOverlay()

    const rootPoint = allPoints.find(
      (point) => normalizeOrgnr(point.orgnr) === normalizeOrgnr(rootOrgnr),
    )
    if (!rootPoint) return

    konsernOverlay = L.layerGroup().addTo(map)
    const rootLatLng = L.latLng(rootPoint.lat, rootPoint.lng)

    for (const orgnr of memberOrgnrs) {
      if (normalizeOrgnr(orgnr) === normalizeOrgnr(rootOrgnr)) continue
      const member = allPoints.find(
        (point) => normalizeOrgnr(point.orgnr) === normalizeOrgnr(orgnr),
      )
      if (!member) continue

      L.polyline([rootLatLng, L.latLng(member.lat, member.lng)], {
        color: '#64748b',
        weight: 1.5,
        opacity: 0.55,
        dashArray: '6 6',
      }).addTo(konsernOverlay)
    }
  }


  function showOrganizationDetails(org: Organization, latlng: L.LatLng, note?: string) {
    if (!map) return
    const extra = note ? `<br/><em>${note}</em>` : ''
    L.popup({ maxWidth: 320 })
      .setLatLng(latlng)
      .setContent(`${orgPopupHtml(org)}${extra}`)
      .openOn(map)
  }

  async function showOrganizationPopup(
    orgnr: string,
    latlng: L.LatLng,
    note?: string,
    hint?: Partial<OrganizationPoint> | null,
  ) {
    if (!map) return

    seedHint(hint)
    const popup = L.popup({ maxWidth: 360, className: 'org-popup' })
      .setLatLng(latlng)
      .setContent('Laster organisasjon…')
      .openOn(map)

    const hinted =
      hint?.orgnr && hint.navn
        ? organizationFromPoint({
            orgnr: hint.orgnr,
            orgType: hint.orgType ?? '',
            lat: latlng.lat,
            lng: latlng.lng,
            navn: hint.navn,
            orgTypeLabel: hint.orgTypeLabel,
            addressText: hint.addressText,
            postnummer: hint.postnummer,
            kommunenummer: hint.kommunenummer,
          })
        : null
    if (hinted) {
      const extra = note ? `<br/><em>${note}</em>` : ''
      popup.setContent(`${orgPopupHtml(hinted)}${extra}`)
    }

    map.once('popupclose', clearKonsernOverlay)

    try {
      const org = await resolveOrganization(orgnr, allPoints)
      const extra = note ? `<br/><em>${note}</em>` : ''
      popup.setContent(`${orgPopupHtml(org)}${extra}`)

      if (settings.konsernMode && org.erIKonsern) {
        const konsern = await fetchKonsernstruktur(orgnr)
        if (konsern) {
          const tree = konsernTreeHtml(konsern as import('../types').KonsernNode)
          popup.setContent(
            `${orgPopupHtml(org, `<hr/><p><strong>Konsern</strong></p><div class="konsern-tree">${tree}</div>`)}${extra}`,
          )
          wireKonsernPopupLinks(popup, (nav) => void navigateToOrganization(nav))
          const members = flattenKonsernOrgnrs(konsern as import('../types').KonsernNode)
          showKonsernOverlay(orgnr, members)
        }
      }
    } catch (err) {
      popup.setContent(err instanceof Error ? err.message : 'Kunne ikke vise organisasjon')
    }
  }

  async function showAddressPopup(
    orgnrs: string[],
    latlng: L.LatLng,
    hint?: Partial<OrganizationPoint> | null,
  ) {
    if (!map) return

    seedHint(hint)
    const popup = L.popup({ maxWidth: 360, className: 'address-popup' })
      .setLatLng(latlng)
      .setContent('Laster organisasjoner…')
      .openOn(map)

    if (hint?.addressText && hint?.postnummer) {
      popup.setContent(
        `<p class="address-popup-header"><strong>${hint.addressText}, ${hint.postnummer}</strong></p><p class="address-popup-summary">Laster ${orgnrs.length} organisasjoner…</p>`,
      )
    }

    try {
      const orgs = await resolveOrganizations(orgnrs, allPoints)
      orgs.sort((a, b) => a.navn.localeCompare(b.navn, 'nb'))
      popup.setContent(addressPopupHtml(orgs, [...new Set(allPoints.map((p) => p.orgType))].sort()))
    } catch (err) {
      popup.setContent(err instanceof Error ? err.message : 'Kunne ikke vise organisasjoner')
    }
  }

  function handleAggregateClick(info: {
    orgType: string
    count: number
    latlng: L.LatLng
    label?: string
    total?: number
    districtLevel?: string
    orgTypeBreakdown?: string
  }) {
    if (!map) return
    const typeLabel = orgForms.find((form) => form.kode === info.orgType)?.beskrivelse ?? info.orgType
    const place =
      info.label ??
      (info.districtLevel === 'fylke'
        ? 'Fylke'
        : info.districtLevel === 'grunnkrets'
          ? 'Grunnkrets'
          : 'Kommune')
    const totalLine =
      info.total != null
        ? `<br>${info.total.toLocaleString('nb-NO')} organisasjoner totalt i ${place}`
        : ''
    const breakdownLine = formatOrgTypeBreakdownHtml(info.orgTypeBreakdown, orgForms)
    L.popup({ maxWidth: 320 })
      .setLatLng(info.latlng)
      .setContent(
        `<strong>${place}</strong>${totalLine}${breakdownLine}<br><em>Zoom inn for enkeltadresser</em>`,
      )
      .openOn(map)
  }

  function handleMarkerClick(
    orgnrs: string[],
    latlng: L.LatLng,
    hint?: Partial<OrganizationPoint> | null,
  ) {
    if (orgnrs.length === 1) {
      void showOrganizationPopup(orgnrs[0]!, latlng, undefined, hint)
    } else {
      void showAddressPopup(orgnrs, latlng, hint)
    }
  }

  function clearOrgMarker() {
    orgMarker?.remove()
    orgMarker = null
  }

  function enterOrgFocusMode() {
    orgFocusActive = true
    if (geoLayer) {
      geoLayer.remove()
      geoLayer = null
    }
    removeDistrictColorLayer()
    removeDotsController()
  }

  function exitOrgFocusMode() {
    if (!orgFocusActive) return
    orgFocusActive = false
    clearOrgMarker()
    updateVisualization()
  }

  function showOrgMarker(latlng: L.LatLng) {
    clearOrgMarker()
    orgMarker = L.circleMarker(latlng, {
      radius: 9,
      color: '#0369a1',
      fillColor: '#38bdf8',
      fillOpacity: 0.95,
      weight: 2,
    }).addTo(map!)
  }

  async function navigateToOrganization(orgnr: string) {
    if (!map) return

    enterOrgFocusMode()

    try {
      const [location, localOrg] = await Promise.all([
        fetchOrganizationLocation(orgnr),
        lookupOrganizationLocal(orgnr),
      ])
      const org = localOrg ?? (await fetchOrganizationDetail(orgnr))

      if (location.lat != null && location.lng != null) {
        const latlng = L.latLng(location.lat, location.lng)
        showOrgMarker(latlng)
        map.flyTo(latlng, ORG_LOCATE_ZOOM, { duration: 0.8 })
        showOrganizationDetails(org, latlng)
        return
      }

      if (location.kommunenummer) {
        const bounds = kommuneBoundsByNummer.get(location.kommunenummer)
        if (bounds) {
          const [lat, lng] = geoBoundsCenter(bounds)
          const latlng = L.latLng(lat, lng)
          showOrgMarker(latlng)
          map.flyTo(latlng, ORG_LOCATE_ZOOM, { duration: 0.8 })
          showOrganizationDetails(
            org,
            latlng,
            'Kunne ikke geokode adressen – omtrentlig posisjon',
          )
          return
        }
      }

      L.popup({ maxWidth: 320 })
        .setLatLng(map.getCenter())
        .setContent('Fant organisasjonen, men ingen kartposisjon er tilgjengelig')
        .openOn(map)
    } catch (err) {
      if (!map) return
      L.popup({ maxWidth: 320 })
        .setLatLng(map.getCenter())
        .setContent(err instanceof Error ? err.message : 'Kunne ikke finne organisasjon')
        .openOn(map)
    }
  }

  function disableVectorTiles(message: string) {
    vectorTilesDisabled = true
    removeDotsController()
    scheduleDotsReload(0)
    updateDotsState({
      loading: false,
      phase: 'idle',
      message: `Vektorfliser utilgjengelige (${message}) – bruker database`,
    })
  }

  function removeDistrictColorLayer() {
    districtColorController?.remove()
    districtColorController = null
  }

  function hideDistrictColorLayer() {
    districtColorController?.hide()
  }

  function ensureBaseKommuner() {
    if (!map || !geojson) return
    if (geoLayer) {
      geoLayer.bringToBack()
      return
    }
    geoLayer = L.geoJSON(geojson, {
      style: (feature) => styleKommuneFeature(feature as KommuneFeature),
    }).addTo(map)
  }

  function prefetchDetailTiles() {
    if (!map || !detailOrgTilesReady) return
    const zoom = map.getZoom()
    // Warm org tiles one Leaflet zoom before detail (and at detail).
    if (zoom < settings.dotsDetailMinZoom - 2) return
    const bakedMin =
      vectorTilesManifest?.layers?.find((layer) => layer.name === 'organizations')?.minZoom ??
      settings.dotsDetailMinZoom - 2
    void prefetchOrganizationTiles(map.getBounds(), {
      leafletZoom: Math.max(zoom, settings.dotsDetailMinZoom),
      bakedMinZoom: bakedMin,
    })
  }

  function fylkerInBounds(): string[] {
    const fylker = new Set<string>()
    for (const kommunenummer of kommunerInBounds()) {
      fylker.add(fylkeFromKommune(kommunenummer))
    }
    return [...fylker].sort()
  }

  function ensureDistrictColorLayer() {
    if (!map || !districtColorsManifest) return

    if (!districtColorController) {
      districtColorController = createDistrictColorLayer(map, districtColorsManifest, {
        getViewportFylker: fylkerInBounds,
        getViewportBounds: () => map?.getBounds() ?? null,
        onFeatureClick: (feature, latlng) => {
          handleAggregateClick({
            orgType: feature.properties.dominantOrgType,
            count: feature.properties.count,
            latlng,
            label: feature.properties.label,
            total: feature.properties.total ?? feature.properties.count,
            districtLevel: feature.properties.districtLevel,
            orgTypeBreakdown: feature.properties.orgTypeBreakdown,
          })
        },
      })
    }

    districtColorController.setZoom(map.getZoom())
    districtColorController.setViewportFylker(fylkerInBounds())
    districtColorController.setFilters({
      orgTypes: settings.orgTypes,
      selectedFylke: settings.selectedFylke,
      selectedKommune: settings.selectedKommune,
    })
    districtColorController.show()
    districtColorController.bringToFront()

    // Prefetch grunnkretser for the visible fylker while still on kommune zoom.
    const layer = activeDistrictLayer(districtColorsManifest, map.getZoom())
    if (layer?.id === 'kommune') {
      districtColorController.prefetchUpcoming(fylkerInBounds())
    }
  }

  function ensureDotsController() {
    if (!map) return

    const vectorMode = useVectorDotsController
    // Keep MapLibre mounted under aggregate zoom with *empty* LOD so address
    // tiles warm. Grunnkretser stay on Leaflet district GeoJSON (reliable).
    const lodLayers = pmtilesLodReady ? aggregateLayersFromManifest(vectorTilesManifest) : []
    const useLod = lodLayers.length > 0
    const vectorUrl = vectorMode ? vectorTilesSourceUrl() : null
    const orgTypesForColors =
      districtColorsManifest?.orgTypes ??
      vectorTilesManifest?.orgTypes ??
      orgForms.map((form) => form.kode)

    if (
      dotsController &&
      dotsControllerUsesVector === vectorMode &&
      dotsControllerUsesLod === useLod
    ) {
      applyDotFilters()
      return
    }

    dotsController?.remove()

    const { controller, usedWebgl } = createDotsLayer(map, {
      dotsDetailMinZoom: settings.dotsDetailMinZoom,
      dotsClustering: false,
      vectorTilesUrl: vectorUrl,
      lodLayers,
      pointsLayer: vectorMode ? pointsLayerFromManifest(vectorTilesManifest) : null,
      orgTypesForColors,
      onMarkerClick: handleMarkerClick,
      onAggregateClick: handleAggregateClick,
      onVectorTilesError: disableVectorTiles,
    })

    dotsController = controller
    dotsControllerUsesVector = usedWebgl && vectorMode
    dotsControllerUsesLod = usedWebgl && useLod

    if (!usedWebgl) {
      webglUnavailable = true
      updateDotsState({ webglUnavailable: true })
    }
  }

  let dotsControllerUsesVector = false
  let dotsControllerUsesLod = false

  function removeDotsController() {
    dotsController?.remove()
    dotsController = null
    dotsControllerUsesVector = false
    dotsControllerUsesLod = false
    points = []
    allPoints = []
    dotsCache.clear()
  }

  function kommunerInBounds(): string[] {
    if (!map || !geojson) return []

    const bounds = mapGeoBounds(map.getBounds())
    const matches: string[] = []
    for (const feature of kommuneFeatures(geojson)) {
      const kommunenummer = feature.properties.kommunenummer
      const featureBounds = kommuneBoundsByNummer.get(kommunenummer)
      if (featureBounds && geoBoundsIntersects(bounds, featureBounds)) {
        matches.push(kommunenummer)
      }
    }

    return matches
  }

  function updateDotsState(partial: Partial<DotsLoadState>) {
    const current = untrack(() => dotsState)
    const next = { ...current, ...partial }
    if (
      next.loading === current.loading &&
      next.phase === current.phase &&
      next.organizations === current.organizations &&
      next.geocoded === current.geocoded &&
      next.skipped === current.skipped &&
      next.kommuner === current.kommuner &&
      next.message === current.message &&
      next.webglUnavailable === current.webglUnavailable &&
      next.renderedFeatureCount === current.renderedFeatureCount &&
      next.statsApproximate === current.statsApproximate &&
      next.statsLoading === current.statsLoading &&
      next.viewportSummary?.geocodedInBbox === current.viewportSummary?.geocodedInBbox &&
      next.viewportSummary?.addressesInBbox === current.viewportSummary?.addressesInBbox &&
      next.viewportSummary?.ungeocodedInViewport === current.viewportSummary?.ungeocodedInViewport &&
      next.viewportSummary?.renderMode === current.viewportSummary?.renderMode
    ) {
      return
    }
    dotsState = next
    onDotsStateChange?.(next)
  }

  function updateRenderedFeatureCount() {
    // Only meaningful for address circles at detail zoom — LOD fills are not "prikker".
    if (map && map.getZoom() < settings.dotsDetailMinZoom) {
      updateDotsState({ renderedFeatureCount: 0 })
      return
    }
    const count = dotsController?.countRenderedFeatures?.() ?? 0
    updateDotsState({ renderedFeatureCount: count })
  }

  async function loadViewportSummary() {
    return loadViewportSummaryImpl({
      getMap: () => map,
      getSettings: () => settings,
      isOrgFocusActive: () => orgFocusActive,
      getKommunerInBounds: kommunerInBounds,
      getBbox: (bounds) => mapBbox(bounds),
      updateDotsState,
      updateRenderedFeatureCount,
      abortPrevious() {
        summaryAbort?.abort()
        summaryAbort = new AbortController()
        return summaryAbort.signal
      },
    })
  }

  function applyPoints(nextPoints: OrganizationPoint[], truncated: boolean, kommuner: number) {
    const visiblePoints = filterPointsByMapFilters(nextPoints, settings)
    allPoints = nextPoints
    points = visiblePoints
    dotsController?.setVisible(true)
    dotsController?.setPoints(visiblePoints)
    applyDotFilters()
    dotsController?.setStale(false)
    dotsController?.bringToFront()
    const visibleCount = visiblePoints.length
    updateDotsState({
      loading: false,
      phase: 'idle',
      organizations: visibleCount,
      geocoded: visibleCount,
      skipped: 0,
      kommuner,
      message: truncated
        ? 'Viser et utvalg av organisasjoner – zoom inn for flere detaljer'
        : null,
    })
  }

  function applyOrgTypeVisibility() {
    if (aggregateZoomActive && districtColorsReady) {
      ensureDistrictColorLayer()
      return
    }
    if (aggregateZoomActive && pmtilesLodReady) {
      applyDotFilters()
      updateRenderedFeatureCount()
      return
    }
    applyDotFilters()
    if (untrack(() => detailOrgTilesReady)) {
      updateRenderedFeatureCount()
      return
    }
    const count = filterPointsByMapFilters(allPoints, settings).length
    updateDotsState({
      organizations: count,
      geocoded: count,
    })
  }

  async function prefetchExpanded(
    bbox: [number, number, number, number],
    targetKommuner: string[],
    zoom: number,
  ) {
    const expanded = expandBbox(bbox, PREFETCH_BBOX_EXPANSION)
    const key = dotsCacheKey({
      bbox: expanded,
      kommunenumre: targetKommuner,
      filters: dataFiltersKey(),
      zoom,
      clustering: false,
    })

    if (dotsCache.getMemory(key)) return

    const schedule = typeof requestIdleCallback === 'function'
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
        })
      } catch {
        // Prefetch failures are non-critical
      }
    })
  }

  function applyVectorTilesState(options: { includeViewportSummary?: boolean } = {}) {
    hideDistrictColorLayer()
    ensureDotsController()
    dotsController?.setVisible(true)
    applyDotFilters()
    dotsController?.setStale(false)
    dotsController?.bringToFront()
    prefetchDetailTiles()
    updateDotsState({
      loading: false,
      phase: 'idle',
      message: null,
      organizations: vectorTilesManifest?.total ?? 0,
      geocoded: vectorTilesManifest?.total ?? 0,
    })
    updateRenderedFeatureCount()
    if (options.includeViewportSummary) {
      void loadViewportSummary()
    }
  }

  async function loadDots() {
    if (!map || settings.visualization !== 'dots' || orgFocusActive) return

    const zoom = map.getZoom()
    const atAggregateZoom = zoom < settings.dotsDetailMinZoom

    // Primary aggregate: Leaflet district GeoJSON + warm MapLibre only when
    // address PMTiles can paint at z15 (otherwise skip the GL overlay).
    if (atAggregateZoom && districtColorsReady) {
      if (detailOrgTilesReady) {
        ensureDotsController()
        // Address circles self-gate via minzoom (Leaflet z15 → GL z14).
        dotsController?.setVisible(true)
        prefetchDetailTiles()
      } else if (!useVectorDotsController) {
        // No usable vector overlay for this filter/tile set — free GL if leftover.
        removeDotsController()
      }
      ensureBaseKommuner()
      ensureDistrictColorLayer()
      updateDotsState({
        loading: false,
        phase: 'idle',
        message: null,
        skipped: 0,
      })
      void loadViewportSummary()
      return
    }

    // Fallback aggregate: PMTiles LOD fills when district GeoJSON is missing.
    if (atAggregateZoom && pmtilesLodReady) {
      hideDistrictColorLayer()
      applyVectorTilesState({ includeViewportSummary: true })
      return
    }

    if (atAggregateZoom) {
      hideDistrictColorLayer()
      removeDotsController()
      ensureBaseKommuner()
      updateDotsState({
        loading: false,
        phase: 'idle',
        message:
          'Distriktsfliser mangler. Kjør yarn download-grunnkretser && yarn export-district-colors',
      })
      void loadViewportSummary()
      return
    }

    // Detail zoom: hide districts (keep in memory), show address circles.
    hideDistrictColorLayer()
    ensureBaseKommuner()

    if (detailOrgTilesReady) {
      applyVectorTilesState({ includeViewportSummary: true })
      return
    }

    ensureDotsController()
    dotsController?.setVisible(true)

    const targetKommuner = kommunerInBounds()
    const bounds = map.getBounds()
    const bbox = mapBbox(bounds)

    if (targetKommuner.length === 0) {
      points = []
      allPoints = []
      dotsController?.setPoints([])
      updateDotsState({
        loading: false,
        phase: 'idle',
        organizations: 0,
        geocoded: 0,
        skipped: 0,
        kommuner: 0,
        message: null,
      })
      void loadViewportSummary()
      return
    }

    const cacheKey = dotsCacheKey({
      bbox,
      kommunenumre: targetKommuner,
      filters: dataFiltersKey(),
      zoom,
      clustering: false,
    })

    const cached = await dotsCache.get(cacheKey)
    if (cached) {
      applyPoints(cached.points, cached.truncated, targetKommuner.length)
      prefetchExpanded(bbox, targetKommuner, zoom)
      void loadViewportSummary()
      return
    }

    loadAbort?.abort()
    loadAbort = new AbortController()
    const signal = loadAbort.signal

    dotsController?.setStale(true)
    updateDotsState({
      loading: true,
      phase: 'fetching',
      message: 'Henter organisasjoner fra database…',
      kommuner: targetKommuner.length,
    })

    try {
      const result = await fetchOrganizationPoints(settings, {
        bbox,
        kommunenumre: targetKommuner,
        zoom,
        limit: limitForZoom(zoom),
      }, signal)

      if (signal.aborted) return

      await dotsCache.set(cacheKey, {
        points: result.points,
        truncated: result.truncated,
        savedAt: Date.now(),
      })

      applyPoints(result.points, result.truncated, targetKommuner.length)
      prefetchExpanded(bbox, targetKommuner, zoom)
      void loadViewportSummary()
    } catch (err) {
      if (signal.aborted) return
      dotsController?.setStale(false)
      updateDotsState({
        loading: false,
        phase: 'idle',
        organizations: points.length,
        geocoded: points.length,
        skipped: 0,
        kommuner: targetKommuner.length,
        message: err instanceof Error ? err.message : 'Kunne ikke laste organisasjoner',
      })
    }
  }

  const DOTS_MOVE_RELOAD_DELAY_MS = 400
  const DOTS_FILTER_RELOAD_DELAY_MS = 300
  let lastPrefetchAt = 0

  function scheduleDotsReload(delay = DOTS_FILTER_RELOAD_DELAY_MS) {
    if (settings.visualization !== 'dots' || orgFocusActive) return
    clearTimeout(boundsTimer)
    boundsTimer = window.setTimeout(() => {
      void loadDots()
    }, delay)
  }

  function scheduleDotsReloadOnMove() {
    // Warm address tiles immediately; do not wait for the debounced loadDots.
    if (untrack(() => detailOrgTilesReady)) {
      prefetchDetailTiles()
    }
    scheduleDotsReload(DOTS_MOVE_RELOAD_DELAY_MS)
  }

  function schedulePrefetchDuringMove() {
    if (!untrack(() => detailOrgTilesReady) || !map) return
    const zoom = map.getZoom()
    if (zoom < settings.dotsDetailMinZoom - 2) return
    const now = performance.now()
    if (now - lastPrefetchAt < 120) return
    lastPrefetchAt = now
    prefetchDetailTiles()
  }

  function scheduleDotsReloadOnZoom() {
    if (untrack(() => detailOrgTilesReady)) {
      prefetchDetailTiles()
    }
    scheduleDotsReload(0)
  }

  function styleKommuneFeature(feature?: KommuneFeature) {
    return styleKommuneFeatureImpl(feature, {
      isVisible: isKommuneVisible,
      getCount: kommuneCount,
      visualization: settings.visualization,
      maxCount,
      colorScheme: settings.colorScheme,
    })
  }

  function styleFylkeFeature(feature?: FylkeFeature) {
    return styleFylkeFeatureImpl(feature, {
      isVisible: isFylkeVisible,
      getCount: fylkeCount,
      maxCount,
      colorScheme: settings.colorScheme,
    })
  }

  async function showDistrictStatsPopup(options: {
    level: 'fylke' | 'kommune'
    districtId: string
    label: string
    latlng: L.LatLng
    fallbackTotal: number
  }) {
    if (!map) return

    const levelLabel = options.level === 'fylke' ? 'Fylke' : 'Kommune'
    const popup = L.popup({ maxWidth: 320 })
      .setLatLng(options.latlng)
      .setContent(`<strong>${options.label}</strong><br>Laster…`)
      .openOn(map)

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

  function bindHoverHighlight(path: L.Path, featureLayer: L.Layer) {
    bindHoverHighlightImpl(path, featureLayer, {
      getMap: () => map,
      getGeoLayer: () => geoLayer,
    })
  }

  function bindDistrictLayerEvents(
    layer: L.Layer,
    options: {
      level: 'fylke' | 'kommune'
      districtId: string
      label: string
      fallbackTotal: number
    },
  ) {
    forEachPathLayer(layer, (path) => {
      path.on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        void showDistrictStatsPopup({
          ...options,
          latlng: event.latlng,
        })
      })
      bindHoverHighlight(path, layer)
    })
  }

  function bindKommuneEvents(layer: L.Layer, feature: KommuneFeature) {
    const props = feature.properties
    bindDistrictLayerEvents(layer, {
      level: 'kommune',
      districtId: props.kommunenummer,
      label: props.kommunenavn ?? props.name ?? props.kommunenummer,
      fallbackTotal: kommuneCount(props.kommunenummer),
    })
  }

  function bindFylkeEvents(layer: L.Layer, feature: FylkeFeature) {
    const props = feature.properties
    bindDistrictLayerEvents(layer, {
      level: 'fylke',
      districtId: props.fylkesnummer,
      label: props.fylkesnavn,
      fallbackTotal: fylkeCount(props.fylkesnummer),
    })
  }

  function renderChoropleth() {
    if (!map || !geojson) return
    removeDotsController()

    if (geoLayer) geoLayer.remove()

    if (isFylkeLevel) {
      if (!fylkeGeojson) return
      geoLayer = L.geoJSON(fylkeGeojson, {
        style: (feature) => styleFylkeFeature(feature as FylkeFeature),
        onEachFeature: (feature, layer) => bindFylkeEvents(layer, feature as FylkeFeature),
      }).addTo(map)
      return
    }

    geoLayer = L.geoJSON(geojson, {
      style: (feature) => styleKommuneFeature(feature as KommuneFeature),
      onEachFeature: (feature, layer) => bindKommuneEvents(layer, feature as KommuneFeature),
    }).addTo(map)
  }

  function renderBaseKommuner() {
    if (!map || !geojson) return

    if (geoLayer) geoLayer.remove()

    geoLayer = L.geoJSON(geojson, {
      style: (feature) => styleKommuneFeature(feature as KommuneFeature),
    }).addTo(map)
  }

  function updateVisualization() {
    if (!map) return

    if (orgFocusActive) {
      if (geoLayer) {
        geoLayer.remove()
        geoLayer = null
      }
      removeDotsController()
      return
    }

    if (settings.visualization === 'choropleth') {
      removeDistrictColorLayer()
      removeDotsController()
      renderChoropleth()
      return
    }

    renderBaseKommuner()
    if (geoLayer) geoLayer.bringToBack()
    ensureDotsController()
    dotsController?.bringToFront()
    scheduleDotsReload(0)
  }

  function handleMapZoomEnd() {
    mapZoom = map?.getZoom() ?? mapZoom
    scheduleDotsReloadOnZoom()
  }

  onMount(() => {
    void probeDistrictColors().then(({ available, manifest }) => {
      if (!available || !manifest) return
      districtColorsManifest = manifest
      if (settings.visualization === 'dots') {
        scheduleDotsReload(0)
      }
    })

    void probeVectorTiles().then(({ available, manifest }) => {
      if (!available || !manifest) return
      vectorTilesManifest = manifest
      if (settings.visualization === 'dots') {
        scheduleDotsReload(0)
      }
    })

    map = L.map(mapContainer, {
      zoomControl: false,
      preferCanvas: true,
      minZoom: 4,
      maxZoom: 18,
      maxBounds: [
        [90, -Infinity],
        [-90, Infinity],
      ],
      maxBoundsViscosity: 1,
    }).setView([65.0, 12.0], 5)
    mapZoom = 5

    L.control.zoom({ position: 'topright' }).addTo(map)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · BRREG · Kartverket',
      maxZoom: 19,
    }).addTo(map)

    map.on('moveend', scheduleDotsReloadOnMove)
    map.on('move', schedulePrefetchDuringMove)
    map.on('zoomend', handleMapZoomEnd)

    const resizeObserver = new ResizeObserver(() => {
      map?.invalidateSize({ animate: false })
    })
    resizeObserver.observe(mapContainer)

    updateVisualization()

    return () => {
      clearTimeout(boundsTimer)
      resizeObserver.disconnect()
      map?.off('moveend', scheduleDotsReloadOnMove)
      map?.off('move', schedulePrefetchDuringMove)
      map?.off('zoomend', handleMapZoomEnd)
      removeDistrictColorLayer()
      removeDotsController()
      clearOrgMarker()
      map?.remove()
      map = null
    }
  })

  $effect(() => {
    geojson
    kommuneBoundsByNummer = geojson ? kommuneBoundsIndex(geojson) : new Map()
  })

  $effect(() => {
    settings.visualization
    settings.districtLevel
    settings.colorScheme
    settings.selectedFylke
    settings.selectedKommune
    counts
    geojson
    updateVisualization()
  })

  $effect(() => {
    if (settings.visualization !== 'dots') return

    settings.excludeKonkurs
    settings.excludeUnderAvvikling
    settings.vatRegisteredOnly
    settings.naeringskodeSections
    settings.employeeBands
    settings.entityKinds
    settings.konsernMembersOnly
    settings.selectedFylke
    settings.selectedKommune

    dotsCache.clear()
    if (
      dotsController &&
      dotsControllerUsesVector !== useVectorDotsController
    ) {
      removeDotsController()
    }
    scheduleDotsReload()
  })

  $effect(() => {
    if (settings.visualization !== 'dots') return
    settings.orgTypes
    settings.naeringskodeSections
    settings.employeeBands
    settings.entityKinds
    untrack(() => applyOrgTypeVisibility())
  })

  $effect(() => {
    settings.visualization
    settings.districtLevel
    settings.selectedFylke
    settings.selectedKommune
    untrack(() => {
      if (orgFocusActive) exitOrgFocusMode()
    })
  })

  $effect(() => {
    const request = locateRequest
    if (!request || !map) return
    untrack(() => {
      void navigateToOrganization(request.orgnr)
    })
  })
</script>

<div class="map-shell">
  <div class="map" bind:this={mapContainer} role="application" aria-label="Organisasjonskart" id="map"></div>

  {#if !orgFocusActive && settings.visualization === 'dots' && orgTypeLegendItems.length > 0}
    <div class="legend-wrap">
      <OrgTypeLegend items={orgTypeLegendItems} />
    </div>
  {:else if !orgFocusActive && settings.showLegend && settings.visualization !== 'dots'}
    <div class="legend-wrap">
      <Legend scheme={settings.colorScheme} max={maxCount} />
    </div>
  {/if}

  {#if !orgFocusActive && settings.visualization === 'dots' && dotsState.loading}
    <div class="dots-status loading">
      <strong>
        {dotsState.phase === 'fetching' ? 'Henter organisasjoner…' : 'Oppdaterer kart…'}
      </strong>
      <span>{dotsState.message ?? ''}</span>
    </div>
  {:else if !orgFocusActive && settings.visualization === 'dots' && dotsState.message}
    <div class="dots-status">
      <span>{dotsState.message}</span>
    </div>
  {:else if !orgFocusActive && settings.visualization === 'dots' && webglUnavailable && !webglBannerDismissed}
    <div class="dots-status webgl-banner">
      <strong>WebGL er deaktivert</strong>
      <span>
        Adressevisning kjører i forenklet modus. Aktiver WebGL i nettleseren for full ytelse
        (LibreWolf/Firefox: <code>about:config</code> → <code>webgl.disabled</code> = false),
        og last siden på nytt.
      </span>
      <button type="button" class="banner-dismiss" onclick={() => (webglBannerDismissed = true)}>
        Skjul
      </button>
    </div>
  {/if}

  <div class="zoom-level-tag" aria-live="polite">
    z{mapZoom} · {currentDetailLevel}
  </div>

  <div class="attribution">
    {#if orgFocusActive}
      Organisasjon · OpenStreetMap
    {:else if settings.visualization === 'dots'}
      {#if dotsState.statsLoading || totalVisible == null}
        Beregner adresser…
      {:else}
        {totalVisible.toLocaleString('nb-NO')} adresser i utsnittet
        {#if dotsState.viewportSummary && dotsState.viewportSummary.geocodedInBbox !== totalVisible}
          · {dotsState.viewportSummary.geocodedInBbox.toLocaleString('nb-NO')} org.
        {/if}
        {#if dotsState.viewportSummary && dotsState.viewportSummary.ungeocodedInViewport > 0}
          · {dotsState.viewportSummary.ungeocodedInViewport.toLocaleString('nb-NO')} uten kartkoordinat
        {/if}
      {/if}
      · {dotsSourceLabel}
    {:else}
      {typeof totalVisible === 'number' ? totalVisible.toLocaleString('nb-NO') : '—'} organisasjoner i
      visningen
    {/if}
  </div>
</div>

<style>
  .map-shell {
    position: relative;
    width: 100%;
    height: 100%;
    background: #cbd5e1;
  }

  .map {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    height: 100%;
  }

  .legend-wrap {
    position: absolute;
    left: 1rem;
    bottom: 2.5rem;
    z-index: 1000;
    pointer-events: auto;
  }

  .dots-status {
    position: absolute;
    top: 1rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    background: rgba(15, 23, 42, 0.94);
    color: #e2e8f0;
    padding: 0.65rem 1rem;
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.82rem;
    max-width: min(90vw, 420px);
    text-align: center;
    pointer-events: none;
  }

  .dots-status.loading {
    background: rgba(15, 23, 42, 0.78);
  }

  .dots-status.webgl-banner {
    pointer-events: auto;
    gap: 0.45rem;
    text-align: left;
    border: 1px solid #334155;
  }

  .dots-status strong {
    color: #7dd3fc;
  }

  .dots-status code {
    font-family: ui-monospace, monospace;
    font-size: 0.78em;
    color: #fde68a;
  }

  .banner-dismiss {
    align-self: flex-end;
    margin-top: 0.15rem;
    padding: 0.25rem 0.55rem;
    border: 1px solid #334155;
    border-radius: 0.35rem;
    background: #1e293b;
    color: #e2e8f0;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .banner-dismiss:hover {
    background: #334155;
  }

  .zoom-level-tag {
    position: absolute;
    left: 1rem;
    bottom: 0.75rem;
    z-index: 1000;
    background: rgba(15, 23, 42, 0.88);
    color: #e2e8f0;
    padding: 0.4rem 0.65rem;
    border-radius: 0.35rem;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  }

  .attribution {
    position: absolute;
    right: 1rem;
    bottom: 0.75rem;
    z-index: 1000;
    background: rgba(15, 23, 42, 0.88);
    color: #e2e8f0;
    padding: 0.4rem 0.65rem;
    border-radius: 0.35rem;
    font-size: 0.78rem;
  }

  :global(.konsern-tree) {
    margin-top: 0.35rem;
    max-height: 180px;
    overflow: auto;
    text-align: left;
  }

  :global(.konsern-link) {
    display: block;
    width: 100%;
    margin: 0.15rem 0;
    padding: 0;
    border: none;
    background: none;
    color: #0369a1;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  :global(.konsern-link:hover) {
    text-decoration: underline;
  }

  :global(.leaflet-container) {
    font-family: inherit;
  }

  :global(.maplibregl-canvas) {
    outline: none;
  }

  :global(.leaflet-marker-pane .leaflet-gl-layer),
  :global(.leaflet-marker-pane .leaflet-gl-layer .maplibregl-map),
  :global(.leaflet-marker-pane .leaflet-gl-layer .maplibregl-canvas-container),
  :global(.leaflet-marker-pane .leaflet-gl-layer canvas) {
    z-index: 650 !important;
    pointer-events: none !important;
  }
</style>

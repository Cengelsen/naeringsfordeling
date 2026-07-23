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
  import { colorForValue, kommuneScaleMax, roundUpTo10k } from '../utils/colors'
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
    fetchViewportSummary,
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
  import { naeringskodeSectionLabel } from '../utils/naeringskode'
  import {
    aggregateLayersFromManifest,
    lodTilesAvailable,
    pointsLayerFromManifest,
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

  let loadToken = 0
  let summaryToken = 0
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

  /** Pre-rendered district/grunnkrets GeoJSON (preferred aggregate path). */
  const districtColorsReady = $derived(districtColorsManifest !== null)

  /** Individual address PMTiles at detail zoom (requires default bake-in filters). */
  const vectorTilesReady = $derived(
    vectorTilesManifest !== null &&
      !vectorTilesDisabled &&
      !webglUnavailable &&
      canUseStaticTiles(settings),
  )

  /** PMTiles aggregate layers — used only when district GeoJSON is unavailable. */
  const pmtilesLodReady = $derived(
    vectorTilesReady && !districtColorsReady && lodTilesAvailable(vectorTilesManifest),
  )

  const aggregateZoomActive = $derived(
    settings.visualization === 'dots' && mapZoom < settings.dotsDetailMinZoom,
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
    if (vectorTilesReady) return 'vektorfliser'
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
      ? (dotsState.viewportSummary?.geocodedInBbox ??
        (!aggregateZoomActive && vectorTilesReady
          ? (dotsState.renderedFeatureCount ?? 0)
          : filterPointsByMapFilters(allPoints, settings).length))
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

  function formatEmployeeCount(org: Organization): string {
    if (org.antallAnsatte == null) return 'Antall ansatte: ukjent'
    return `Antall ansatte: ${org.antallAnsatte.toLocaleString('nb-NO')}`
  }

  function orgPopupHtml(org: Organization, konsernHtml = ''): string {
    const naering = org.naeringskode
      ? `Næring: ${naeringskodeSectionLabel(org.naeringskode.slice(0, 2), org.naeringskodeLabel)}<br/>`
      : ''
    const entityKind =
      org.entityKind === 'underenhet' && org.overordnetEnhet
        ? `Underenhet · mor ${org.overordnetEnhet}<br/>`
        : org.entityKind === 'underenhet'
          ? 'Underenhet<br/>'
          : ''
    const geocode =
      org.geocodeQuality === 'mismatch'
        ? '<br/><em>Adressekommune avviker fra BRREG</em>'
        : ''

    return `<strong>${org.navn}</strong><br/>
         ${org.orgTypeLabel} (${org.orgType})<br/>
         Org.nr ${org.orgnr}<br/>
         ${naering}${formatEmployeeCount(org)}<br/>
         ${entityKind}${org.addressText}, ${org.postnummer}${geocode}${konsernHtml}`
  }

  function flattenKonsernOrgnrs(node: import('../types').KonsernNode): string[] {
    const orgnrs = [node.organisasjonsnummer]
    for (const child of node.underenheter ?? []) {
      orgnrs.push(...flattenKonsernOrgnrs(child))
    }
    return orgnrs
  }

  function konsernTreeHtml(node: import('../types').KonsernNode, depth = 0): string {
    const indent = '&nbsp;'.repeat(depth * 2)
    const label = node.navn ?? node.organisasjonsnummer
    const line = `<button type="button" class="konsern-link" data-orgnr="${node.organisasjonsnummer}">${indent}${label} (${node.organisasjonsnummer})</button>`
    const children = (node.underenheter ?? [])
      .map((child) => konsernTreeHtml(child, depth + 1))
      .join('')
    return `${line}${children}`
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

  function wireKonsernPopupLinks(popup: L.Popup) {
    const element = popup.getElement()
    if (!element) return

    element.querySelectorAll<HTMLButtonElement>('.konsern-link').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault()
        const orgnr = button.dataset.orgnr
        if (orgnr) void navigateToOrganization(orgnr)
      })
    })
  }

  function addressPopupHtml(orgs: Organization[]): string {
    const colorTypes = [...new Set(allPoints.map((point) => point.orgType))].sort()
    const addressLine =
      orgs[0]?.addressText && orgs[0]?.postnummer
        ? `<p class="address-popup-header"><strong>${orgs[0].addressText}, ${orgs[0].postnummer}</strong></p>`
        : ''
    const items = orgs
      .map((org) => {
        const color = colorForOrgType(org.orgType, colorTypes)
        return `<div class="address-popup-item">
            <span class="address-popup-swatch" style="background:${color}"></span>
            <div>
              <strong>${org.navn}</strong><br/>
              ${org.orgTypeLabel} (${org.orgType})<br/>
              Org.nr ${org.orgnr}
            </div>
          </div>`
      })
      .join('')

    return `${addressLine}<p class="address-popup-summary">${orgs.length} organisasjoner på denne adressen</p><div class="address-popup-list">${items}</div>`
  }

  function resolveOrganizationFromPoints(orgnr: string): Organization | null {
    const point = allPoints.find((entry) => normalizeOrgnr(entry.orgnr) === normalizeOrgnr(orgnr))
    return point ? organizationFromPoint(point) : null
  }

  async function resolveOrganization(orgnr: string): Promise<Organization> {
    const fromPoints = resolveOrganizationFromPoints(orgnr)
    if (fromPoints) return fromPoints

    const local = await lookupOrganizationLocal(orgnr)
    if (local) return local

    return fetchOrganizationDetail(orgnr)
  }

  async function resolveOrganizations(orgnrs: string[]): Promise<Organization[]> {
    return Promise.all(orgnrs.map((orgnr) => resolveOrganization(orgnr)))
  }

  function showOrganizationDetails(org: Organization, latlng: L.LatLng, note?: string) {
    if (!map) return
    const extra = note ? `<br/><em>${note}</em>` : ''
    L.popup({ maxWidth: 320 })
      .setLatLng(latlng)
      .setContent(`${orgPopupHtml(org)}${extra}`)
      .openOn(map)
  }

  async function showOrganizationPopup(orgnr: string, latlng: L.LatLng, note?: string) {
    if (!map) return

    const popup = L.popup({ maxWidth: 360, className: 'org-popup' })
      .setLatLng(latlng)
      .setContent('Laster organisasjon…')
      .openOn(map)

    map.once('popupclose', clearKonsernOverlay)

    try {
      const org = await resolveOrganization(orgnr)
      const extra = note ? `<br/><em>${note}</em>` : ''
      popup.setContent(`${orgPopupHtml(org)}${extra}`)

      if (settings.konsernMode && org.erIKonsern) {
        const konsern = await fetchKonsernstruktur(orgnr)
        if (konsern) {
          const tree = konsernTreeHtml(konsern as import('../types').KonsernNode)
          popup.setContent(
            `${orgPopupHtml(org, `<hr/><p><strong>Konsern</strong></p><div class="konsern-tree">${tree}</div>`)}${extra}`,
          )
          wireKonsernPopupLinks(popup)
          const members = flattenKonsernOrgnrs(konsern as import('../types').KonsernNode)
          showKonsernOverlay(orgnr, members)
        }
      }
    } catch (err) {
      popup.setContent(err instanceof Error ? err.message : 'Kunne ikke vise organisasjon')
    }
  }

  async function showAddressPopup(orgnrs: string[], latlng: L.LatLng) {
    if (!map) return

    const popup = L.popup({ maxWidth: 360, className: 'address-popup' })
      .setLatLng(latlng)
      .setContent('Laster organisasjoner…')
      .openOn(map)

    try {
      const orgs = await resolveOrganizations(orgnrs)
      orgs.sort((a, b) => a.navn.localeCompare(b.navn, 'nb'))
      popup.setContent(addressPopupHtml(orgs))
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
    const breakdownLine = formatOrgTypeBreakdownHtml(info.orgTypeBreakdown)
    L.popup({ maxWidth: 320 })
      .setLatLng(info.latlng)
      .setContent(
        `<strong>${place}</strong>${totalLine}${breakdownLine}<br><em>Zoom inn for enkeltadresser</em>`,
      )
      .openOn(map)
  }

  function formatOrgTypeBreakdownHtml(breakdownJson?: string): string {
    if (!breakdownJson) return ''
    try {
      const breakdown = JSON.parse(breakdownJson) as Record<string, number>
      const lines = Object.entries(breakdown)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 6)
        .map(([kode, count]) => {
          const label = orgForms.find((form) => form.kode === kode)?.beskrivelse ?? kode
          return `${label}: ${count.toLocaleString('nb-NO')}`
        })
      if (lines.length === 0) return ''
      return `<br><br>${lines.join('<br>')}`
    } catch {
      return ''
    }
  }

  function handleMarkerClick(orgnrs: string[], latlng: L.LatLng) {
    if (orgnrs.length === 1) {
      void showOrganizationPopup(orgnrs[0]!, latlng)
    } else {
      void showAddressPopup(orgnrs, latlng)
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

    // Prefetch grunnkretser for the visible fylker while still on kommune zoom.
    const layer = activeDistrictLayer(districtColorsManifest, map.getZoom())
    if (layer?.id === 'kommune') {
      districtColorController.prefetchUpcoming(fylkerInBounds())
    }
  }

  function ensureDotsController() {
    if (!map) return

    const vectorMode = vectorTilesReady
    // Keep MapLibre mounted during aggregate zoom (empty LOD) so z15 dots appear
    // instantly. Grunnkretser use Leaflet district GeoJSON — more reliable than
    // mixing PMTiles fill zoom bands with maplibre-gl-leaflet.
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
      next.viewportSummary?.geocodedInBbox === current.viewportSummary?.geocodedInBbox &&
      next.viewportSummary?.ungeocodedInViewport === current.viewportSummary?.ungeocodedInViewport &&
      next.viewportSummary?.renderMode === current.viewportSummary?.renderMode
    ) {
      return
    }
    dotsState = next
    onDotsStateChange?.(next)
  }

  function updateRenderedFeatureCount() {
    const count = dotsController?.countRenderedFeatures?.() ?? 0
    updateDotsState({ renderedFeatureCount: count })
  }

  async function loadViewportSummary() {
    if (!map || settings.visualization !== 'dots' || orgFocusActive) return

    const targetKommuner = kommunerInBounds()
    const zoom = map.getZoom()
    const bbox = mapBbox(map.getBounds())
    const token = ++summaryToken

    try {
      const { summary, approximate } = await fetchViewportSummary(settings, {
        bbox,
        zoom,
        kommunenumre: targetKommuner,
      })
      if (token !== summaryToken) return

      updateDotsState({
        viewportSummary: summary,
        statsApproximate: approximate,
        geocoded: summary.geocodedInBbox,
        organizations: summary.geocodedInBbox,
        skipped: summary.ungeocodedInViewport,
        kommuner: summary.kommunerInViewport,
      })
      updateRenderedFeatureCount()
    } catch (err) {
      if (token !== summaryToken) return
      updateDotsState({
        message: err instanceof Error ? err.message : 'Kunne ikke hente statistikk for utsnittet',
      })
    }
  }

  function applyPoints(nextPoints: OrganizationPoint[], truncated: boolean, kommuner: number) {
    const visiblePoints = filterPointsByMapFilters(nextPoints, settings)
    allPoints = nextPoints
    points = visiblePoints
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
    if (untrack(() => vectorTilesReady)) {
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
    const expanded = expandBbox(bbox, 0.35)
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
    ensureDotsController()
    dotsController?.setVisible(true)
    applyDotFilters()
    dotsController?.setStale(false)
    dotsController?.bringToFront()
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

    if (atAggregateZoom && districtColorsReady) {
      // Keep MapLibre warm (hidden) so z15 address dots appear immediately.
      if (vectorTilesReady) {
        ensureDotsController()
        dotsController?.setVisible(false)
      } else {
        removeDotsController()
      }
      if (geoLayer) {
        geoLayer.remove()
        geoLayer = null
      }
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

    if (atAggregateZoom && pmtilesLodReady) {
      removeDistrictColorLayer()
      if (geoLayer) {
        geoLayer.remove()
        geoLayer = null
      }
      applyVectorTilesState({ includeViewportSummary: true })
      return
    }

    if (atAggregateZoom) {
      removeDistrictColorLayer()
      removeDotsController()
      renderBaseKommuner()
      if (geoLayer) geoLayer.bringToBack()
      updateDotsState({
        loading: false,
        phase: 'idle',
        message:
          'Distriktsfliser mangler. Kjør yarn download-grunnkretser && yarn export-district-colors',
      })
      void loadViewportSummary()
      return
    }

    // Detail zoom: individual addresses
    removeDistrictColorLayer()
    renderBaseKommuner()
    if (geoLayer) geoLayer.bringToBack()

    if (vectorTilesReady) {
      applyVectorTilesState({ includeViewportSummary: true })
      return
    }

    ensureDotsController()

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

    const token = ++loadToken
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
      })

      if (token !== loadToken) return

      await dotsCache.set(cacheKey, {
        points: result.points,
        truncated: result.truncated,
        savedAt: Date.now(),
      })

      applyPoints(result.points, result.truncated, targetKommuner.length)
      prefetchExpanded(bbox, targetKommuner, zoom)
      void loadViewportSummary()
    } catch (err) {
      if (token !== loadToken) return
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

  function scheduleDotsReload(delay = DOTS_FILTER_RELOAD_DELAY_MS) {
    if (settings.visualization !== 'dots' || orgFocusActive) return
    clearTimeout(boundsTimer)
    boundsTimer = window.setTimeout(() => {
      void loadDots()
    }, delay)
  }

  function scheduleDotsReloadOnMove() {
    scheduleDotsReload(DOTS_MOVE_RELOAD_DELAY_MS)
  }

  function scheduleDotsReloadOnZoom() {
    scheduleDotsReload(0)
  }

  function styleKommuneFeature(feature?: KommuneFeature) {
    const kommunenummer = feature?.properties.kommunenummer ?? ''
    const visible = isKommuneVisible(kommunenummer)
    const count = visible ? kommuneCount(kommunenummer) : 0

    if (settings.visualization === 'dots') {
      return {
        fillColor: '#64748b',
        weight: visible ? 1 : 0.3,
        opacity: visible ? 0.55 : 0.2,
        color: '#475569',
        fillOpacity: visible ? 0.08 : 0.03,
      }
    }

    return {
      fillColor: colorForValue(count, maxCount, settings.colorScheme),
      weight: visible ? 1 : 0.3,
      opacity: visible ? 1 : 0.35,
      color: '#475569',
      fillOpacity: visible ? 0.78 : 0.15,
    }
  }

  function styleFylkeFeature(feature?: FylkeFeature) {
    const fylkesnummer = feature?.properties.fylkesnummer ?? ''
    const visible = isFylkeVisible(fylkesnummer)
    const count = visible ? fylkeCount(fylkesnummer) : 0

    return {
      fillColor: colorForValue(count, maxCount, settings.colorScheme),
      weight: visible ? 1 : 0.3,
      opacity: visible ? 1 : 0.35,
      color: '#475569',
      fillOpacity: visible ? 0.78 : 0.15,
    }
  }

  function bindHoverHighlight(layer: L.Layer) {
    layer.on({
      mouseover: (e) => {
        const target = e.target as L.Path
        target.setStyle({ weight: 2.5, color: '#0ea5e9', opacity: 1 })
        target.bringToFront()
      },
      mouseout: (e) => {
        geoLayer?.resetStyle(e.target as L.Layer)
      },
    })
  }

  function bindKommuneEvents(layer: L.Layer, feature: KommuneFeature) {
    const props = feature.properties
    const count = kommuneCount(props.kommunenummer)
    layer.bindPopup(
      `<strong>${props.kommunenavn ?? props.name}</strong><br/>
       Kommune ${props.kommunenummer}<br/>
       <strong>${count.toLocaleString('nb-NO')}</strong> organisasjoner`,
    )
    bindHoverHighlight(layer)
  }

  function bindFylkeEvents(layer: L.Layer, feature: FylkeFeature) {
    const props = feature.properties
    const count = fylkeCount(props.fylkesnummer)
    layer.bindPopup(
      `<strong>${props.fylkesnavn}</strong><br/>
       Fylke ${props.fylkesnummer}<br/>
       <strong>${count.toLocaleString('nb-NO')}</strong> organisasjoner`,
    )
    bindHoverHighlight(layer)
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
      dotsControllerUsesVector !== vectorTilesReady
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
  <div class="map" bind:this={mapContainer}></div>

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
      {totalVisible.toLocaleString('nb-NO')} geokodede i utsnittet
      {#if dotsState.viewportSummary && dotsState.viewportSummary.ungeocodedInViewport > 0}
        · {dotsState.viewportSummary.ungeocodedInViewport.toLocaleString('nb-NO')} uten kartkoordinat
      {/if}
      · {dotsSourceLabel}
    {:else}
      {totalVisible.toLocaleString('nb-NO')} organisasjoner i visningen
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

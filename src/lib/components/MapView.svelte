<script lang="ts">
  import { onMount } from 'svelte'
  import L from 'leaflet'
  import type { FeatureCollection } from 'geojson'
  import type {
    DotsLoadState,
    MapSettings,
    MunicipalityCount,
    Organization,
    Organisasjonsform,
  } from '../types'
  import { colorForValue } from '../utils/colors'
  import { centroid, fylkeFromKommune, kommuneFeatures, type KommuneFeature } from '../utils/geo'
  import { colorForOrgType } from '../utils/orgTypeColors'
  import { fetchOrganizations, MIN_DOTS_ZOOM } from '../services/api'
  import Legend from './Legend.svelte'
  import OrgTypeLegend from './OrgTypeLegend.svelte'

  interface Props {
    geojson: FeatureCollection | null
    counts: MunicipalityCount[]
    settings: MapSettings
    orgForms: Organisasjonsform[]
    onDotsStateChange?: (state: DotsLoadState) => void
  }

  let { geojson, counts, settings, orgForms, onDotsStateChange }: Props = $props()

  let mapContainer: HTMLDivElement
  let map: L.Map | null = null
  let geoLayer: L.GeoJSON | null = null
  let bubbleLayer: L.LayerGroup | null = null
  let dotsLayer: L.LayerGroup | null = null
  let organizations = $state<Organization[]>([])
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
  let boundsTimer: ReturnType<typeof setTimeout> | undefined

  const countMap = $derived(new Map(counts.map((c) => [c.kommunenummer, c.count])))
  const maxCount = $derived(Math.max(...counts.map((c) => c.count), 1))
  const totalVisible = $derived(
    settings.visualization === 'dots'
      ? organizations.length
      : counts.reduce((sum, c) => sum + c.count, 0),
  )

  const orgTypeLegendItems = $derived.by(() => {
    const types = [...new Set(organizations.map((org) => org.orgType))].sort()
    return types.map((kode) => {
      const meta = orgForms.find((f) => f.kode === kode)
      return {
        kode,
        label: meta?.beskrivelse ?? kode,
        color: colorForOrgType(kode, types),
      }
    })
  })

  function isVisible(kommunenummer: string): boolean {
    if (settings.selectedKommune) {
      return kommunenummer === settings.selectedKommune
    }
    if (settings.selectedFylke) {
      return fylkeFromKommune(kommunenummer) === settings.selectedFylke
    }
    return true
  }

  function kommunerInBounds(): string[] {
    if (!map || !geojson) return []
    const bounds = map.getBounds()
    const zoom = map.getZoom()

    if (settings.selectedKommune) return [settings.selectedKommune]

    const matches: string[] = []
    for (const feature of kommuneFeatures(geojson)) {
      const kommunenummer = feature.properties.kommunenummer
      if (!isVisible(kommunenummer)) continue

      const layer = L.geoJSON(feature)
      if (bounds.intersects(layer.getBounds())) {
        matches.push(kommunenummer)
      }
      layer.remove()
    }

    if (settings.selectedFylke && matches.length === 0) {
      return kommuneFeatures(geojson)
        .map((f) => f.properties.kommunenummer)
        .filter((n) => fylkeFromKommune(n) === settings.selectedFylke)
    }

    if (zoom < MIN_DOTS_ZOOM && !settings.selectedFylke) {
      return []
    }

    return matches
  }

  function updateDotsState(partial: Partial<DotsLoadState>) {
    dotsState = { ...dotsState, ...partial }
    onDotsStateChange?.(dotsState)
  }

  async function loadDots() {
    if (!map || settings.visualization !== 'dots') return

    const targetKommuner = kommunerInBounds()

    if (
      targetKommuner.length === 0 &&
      !settings.selectedKommune &&
      !settings.selectedFylke
    ) {
      organizations = []
      updateDotsState({
        loading: false,
        phase: 'idle',
        organizations: 0,
        geocoded: 0,
        skipped: 0,
        kommuner: 0,
        message: `Zoom inn (nivå ${MIN_DOTS_ZOOM}+) for adressevisning`,
      })
      renderDots()
      return
    }

    const token = ++loadToken
    updateDotsState({
      loading: true,
      phase: 'fetching',
      message: 'Henter organisasjoner fra database…',
      kommuner: targetKommuner.length,
    })

    try {
      const result = await fetchOrganizations(
        targetKommuner,
        settings,
        settings.selectedFylke,
      )

      if (token !== loadToken) return

      organizations = result.organizations
      updateDotsState({
        loading: false,
        phase: 'idle',
        organizations: result.organizations.length,
        geocoded: result.organizations.length,
        skipped: 0,
        kommuner: targetKommuner.length,
        message: result.truncated
          ? 'Viser maks antall organisasjoner for utsnittet – zoom inn eller velg kommune'
          : null,
      })
      renderDots()
    } catch (err) {
      if (token !== loadToken) return
      organizations = []
      updateDotsState({
        loading: false,
        phase: 'idle',
        organizations: 0,
        geocoded: 0,
        skipped: 0,
        kommuner: targetKommuner.length,
        message: err instanceof Error ? err.message : 'Kunne ikke laste organisasjoner',
      })
      renderDots()
    }
  }

  function scheduleDotsReload() {
    if (settings.visualization !== 'dots') return
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      loadDots()
    }, 400)
  }

  function styleFeature(feature?: KommuneFeature) {
    const kommunenummer = feature?.properties.kommunenummer ?? ''
    const visible = isVisible(kommunenummer)
    const count = visible ? (countMap.get(kommunenummer) ?? 0) : 0

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

  function bindFeatureEvents(layer: L.Layer, feature: KommuneFeature) {
    const props = feature.properties
    const count = countMap.get(props.kommunenummer) ?? 0
    layer.bindPopup(
      `<strong>${props.kommunenavn ?? props.name}</strong><br/>
       Kommune ${props.kommunenummer}<br/>
       <strong>${count.toLocaleString('nb-NO')}</strong> organisasjoner`,
    )
    layer.on({
      mouseover: (e) => {
        const target = e.target as L.Path
        target.setStyle({ weight: 2, color: '#0ea5e9' })
        target.bringToFront()
      },
      mouseout: (e) => {
        geoLayer?.resetStyle(e.target as L.Layer)
      },
    })
  }

  function clearAggregateLayers() {
    bubbleLayer?.remove()
    bubbleLayer = null
    dotsLayer?.remove()
    dotsLayer = null
  }

  function renderChoropleth() {
    if (!map || !geojson) return
    clearAggregateLayers()

    if (geoLayer) geoLayer.remove()

    geoLayer = L.geoJSON(geojson, {
      style: (feature) => styleFeature(feature as KommuneFeature),
      onEachFeature: (feature, layer) => bindFeatureEvents(layer, feature as KommuneFeature),
    }).addTo(map)
  }

  function bubbleRadius(count: number): number {
    if (count <= 0) return 0
    return Math.max(4, Math.min(28, Math.sqrt(count / maxCount) * 28))
  }

  function renderBubbles() {
    if (!map || !geojson) return
    geoLayer?.remove()
    geoLayer = null
    dotsLayer?.remove()
    dotsLayer = null

    if (bubbleLayer) bubbleLayer.remove()

    bubbleLayer = L.layerGroup().addTo(map)

    for (const feature of kommuneFeatures(geojson)) {
      const kommunenummer = feature.properties.kommunenummer
      if (!isVisible(kommunenummer)) continue

      const count = countMap.get(kommunenummer) ?? 0
      if (count <= 0) continue

      const [lat, lng] = centroid(feature)
      const circle = L.circleMarker([lat, lng], {
        radius: bubbleRadius(count),
        fillColor: colorForValue(count, maxCount, settings.colorScheme),
        color: '#1e293b',
        weight: 1,
        fillOpacity: 0.75,
      })

      circle.bindPopup(
        `<strong>${feature.properties.kommunenavn ?? feature.properties.name}</strong><br/>
         ${count.toLocaleString('nb-NO')} organisasjoner`,
      )
      circle.addTo(bubbleLayer)
    }
  }

  function renderDots() {
    if (!map) return
    bubbleLayer?.remove()
    bubbleLayer = null

    if (dotsLayer) dotsLayer.remove()
    dotsLayer = L.layerGroup().addTo(map)

    const types = [...new Set(organizations.map((org) => org.orgType))]

    for (const org of organizations) {
      const marker = L.circleMarker([org.lat, org.lng], {
        radius: 4,
        fillColor: colorForOrgType(org.orgType, types),
        color: '#0f172a',
        weight: 0.5,
        fillOpacity: 0.85,
      })

      marker.bindPopup(
        `<strong>${org.navn}</strong><br/>
         ${org.orgTypeLabel} (${org.orgType})<br/>
         Org.nr ${org.orgnr}<br/>
         ${org.addressText}, ${org.postnummer}`,
      )
      marker.addTo(dotsLayer)
    }
  }

  function renderBaseKommuner() {
    if (!map || !geojson) return

    if (geoLayer) geoLayer.remove()

    geoLayer = L.geoJSON(geojson, {
      style: (feature) => styleFeature(feature as KommuneFeature),
      onEachFeature: (feature, layer) => {
        if (settings.visualization !== 'dots') {
          bindFeatureEvents(layer, feature as KommuneFeature)
        }
      },
    }).addTo(map)
  }

  function updateVisualization() {
    if (!map) return

    if (settings.visualization === 'choropleth') {
      organizations = []
      renderChoropleth()
      return
    }

    if (settings.visualization === 'bubbles') {
      organizations = []
      renderBubbles()
      return
    }

    renderBaseKommuner()
    if (geoLayer) geoLayer.bringToBack()
    scheduleDotsReload()
  }

  onMount(() => {
    map = L.map(mapContainer, {
      zoomControl: false,
      preferCanvas: true,
      minZoom: 4,
      maxZoom: 18,
    }).setView([65.0, 12.0], 5)

    L.control.zoom({ position: 'topright' }).addTo(map)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · BRREG · Kartverket',
      maxZoom: 19,
    }).addTo(map)

    map.on('moveend', scheduleDotsReload)
    map.on('zoomend', scheduleDotsReload)

    updateVisualization()

    return () => {
      clearTimeout(boundsTimer)
      map?.off('moveend', scheduleDotsReload)
      map?.off('zoomend', scheduleDotsReload)
      map?.remove()
      map = null
    }
  })

  $effect(() => {
    settings.visualization
    settings.colorScheme
    settings.selectedFylke
    settings.selectedKommune
    settings.orgTypes
    settings.excludeKonkurs
    settings.excludeUnderAvvikling
    settings.vatRegisteredOnly
    counts
    geojson
    updateVisualization()
  })
</script>

<div class="map-shell">
  <div class="map" bind:this={mapContainer}></div>

  {#if settings.visualization === 'dots' && settings.showLegend && orgTypeLegendItems.length > 0}
    <div class="legend-wrap">
      <OrgTypeLegend items={orgTypeLegendItems} />
    </div>
  {:else if settings.showLegend && settings.visualization !== 'dots'}
    <div class="legend-wrap">
      <Legend scheme={settings.colorScheme} max={maxCount} />
    </div>
  {/if}

  {#if settings.visualization === 'dots' && (dotsState.loading || dotsState.message)}
    <div class="dots-status">
      {#if dotsState.loading}
        <strong>
          {dotsState.phase === 'fetching' ? 'Henter fra BRREG…' : 'Geokoder adresser…'}
        </strong>
        <span>{dotsState.message ?? ''}</span>
      {:else if dotsState.message}
        <span>{dotsState.message}</span>
      {/if}
    </div>
  {/if}

  <div class="attribution">
    {#if settings.visualization === 'dots'}
      {totalVisible.toLocaleString('nb-NO')} prikk{totalVisible === 1 ? '' : 'er'} ·
      {dotsState.skipped > 0 ? `${dotsState.skipped.toLocaleString('nb-NO')} uten adresse · ` : ''}
      SQLite-database
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
    width: 100%;
    height: 100%;
  }

  .legend-wrap {
    position: absolute;
    left: 1rem;
    bottom: 2.5rem;
    z-index: 1000;
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
  }

  .dots-status strong {
    color: #7dd3fc;
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

  :global(.leaflet-container) {
    font-family: inherit;
  }
</style>

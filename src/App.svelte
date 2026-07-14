<script lang="ts">
  import type { FeatureCollection } from 'geojson'
  import ControlPanel from './lib/components/ControlPanel.svelte'
  import MapView from './lib/components/MapView.svelte'
  import { mapSettings } from './lib/stores/settings.svelte'
  import {
    checkApiHealth,
    fetchKommuner,
    fetchMunicipalityCounts,
    fetchOrganisasjonsformer,
  } from './lib/services/api'
  import type { Kommune, DotsLoadState, LoadingState, MunicipalityCount, Organisasjonsform } from './lib/types'
  import { fylkeFromKommune } from './lib/utils/geo'

  let orgForms = $state<Organisasjonsform[]>([])
  let kommuner = $state<Kommune[]>([])
  let geojson = $state<FeatureCollection | null>(null)
  let counts = $state<MunicipalityCount[]>([])
  let dotsState = $state<DotsLoadState>({
    loading: false,
    phase: 'idle',
    organizations: 0,
    geocoded: 0,
    skipped: 0,
    kommuner: 0,
    message: null,
  })
  let loading = $state<LoadingState>({
    loading: true,
    progress: 0,
    total: 0,
    error: null,
  })

  const visibleKommuner = $derived.by(() => {
    if (!mapSettings.selectedFylke) return kommuner
    return kommuner.filter(
      (k) => fylkeFromKommune(k.nummer) === mapSettings.selectedFylke,
    )
  })

  const visibleCounts = $derived.by(() => {
    const visible = new Set(visibleKommuner.map((k) => k.nummer))
    return counts.filter((c) => visible.has(c.kommunenummer))
  })

  const totalCount = $derived(
    mapSettings.visualization === 'dots'
      ? dotsState.organizations
      : visibleCounts.reduce((sum, c) => sum + c.count, 0),
  )

  async function loadCounts() {
    loading = {
      loading: true,
      progress: 0,
      total: 1,
      error: null,
    }

    try {
      counts = await fetchMunicipalityCounts(mapSettings)
      loading = { loading: false, progress: 1, total: 1, error: null }
    } catch (err) {
      loading = {
        loading: false,
        progress: 0,
        total: 0,
        error: err instanceof Error ? err.message : 'Kunne ikke hente data',
      }
    }
  }

  let filterKey = $state('')

  function currentFilterKey() {
    return JSON.stringify({
      orgTypes: [...mapSettings.orgTypes].sort(),
      excludeKonkurs: mapSettings.excludeKonkurs,
      excludeUnderAvvikling: mapSettings.excludeUnderAvvikling,
      vatRegisteredOnly: mapSettings.vatRegisteredOnly,
    })
  }

  async function init() {
    loading = { loading: true, progress: 0, total: 3, error: null }
    try {
      await checkApiHealth()

      const geoResponse = await fetch('/data/kommuner.geojson').then((r) => {
        if (!r.ok) throw new Error('Kunne ikke laste kartdata')
        return r.json() as Promise<FeatureCollection>
      })

      geojson = geoResponse

      const [forms, kommuneList] = await Promise.all([
        fetchOrganisasjonsformer(),
        fetchKommuner(geoResponse),
      ])

      orgForms = forms
      kommuner = kommuneList
      filterKey = currentFilterKey()
      await loadCounts()
    } catch (err) {
      loading = {
        loading: false,
        progress: 0,
        total: 0,
        error: err instanceof Error ? err.message : 'Opplasting feilet',
      }
    }
  }

  $effect(() => {
    const key = currentFilterKey()
    if (kommuner.length === 0) return
    if (key === filterKey) return

    filterKey = key
    loadCounts()
  })

  init()
</script>

<main class="layout">
  <ControlPanel
    {orgForms}
    {kommuner}
    {loading}
    {dotsState}
    {totalCount}
    onRefresh={loadCounts}
  />
  <div class="map-area">
    {#if geojson}
      <MapView
        {geojson}
        counts={visibleCounts}
        settings={mapSettings}
        {orgForms}
        onDotsStateChange={(state) => {
          dotsState = state
        }}
      />
    {:else if loading.error}
      <div class="map-placeholder">
        <p>{loading.error}</p>
      </div>
    {:else}
      <div class="map-placeholder">
        <p>Laster kart…</p>
      </div>
    {/if}
  </div>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family:
      'Inter',
      system-ui,
      -apple-system,
      sans-serif;
    background: #0f172a;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(320px, 380px) 1fr;
    height: 100vh;
    overflow: hidden;
  }

  .map-area {
    min-width: 0;
    height: 100%;
  }

  .map-placeholder {
    display: grid;
    place-items: center;
    height: 100%;
    background: #1e293b;
    color: #94a3b8;
    padding: 1rem;
    text-align: center;
  }

  @media (max-width: 900px) {
    .layout {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }
  }
</style>

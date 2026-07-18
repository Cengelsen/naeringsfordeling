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
  import { assetUrl } from './lib/utils/assets'

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
  let panelCollapsed = $state(false)
  let locateSeq = $state(0)
  let locateRequest = $state<{ orgnr: string; seq: number } | null>(null)

  function locateOrganization(orgnr: string) {
    locateSeq += 1
    locateRequest = { orgnr, seq: locateSeq }
  }

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

      const geoResponse = await fetch(assetUrl('data/kommuner.geojson')).then((r) => {
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

<main class="layout" class:panel-collapsed={panelCollapsed}>
  <div class="panel-slot">
    <ControlPanel
      {orgForms}
      {kommuner}
      {loading}
      {dotsState}
      {totalCount}
      onLocateOrganization={locateOrganization}
    />
  </div>
  <div class="map-area">
    <button
      type="button"
      class="panel-toggle"
      onclick={() => (panelCollapsed = !panelCollapsed)}
      aria-expanded={!panelCollapsed}
      aria-label={panelCollapsed ? 'Utvid panel' : 'Minimer panel'}
      title={panelCollapsed ? 'Utvid panel' : 'Minimer panel'}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        {#if panelCollapsed}
          <path
            fill="currentColor"
            d="M9.29 6.71a1 1 0 0 0 0 1.41L13.17 12l-3.88 3.88a1 1 0 1 0 1.41 1.41l4.59-4.59a1 1 0 0 0 0-1.41L10.7 6.7a1 1 0 0 0-1.41.01z"
          />
        {:else}
          <path
            fill="currentColor"
            d="M14.71 6.71a1 1 0 0 0-1.41 0L8.71 11.3a1 1 0 0 0 0 1.41l4.59 4.59a1 1 0 0 0 1.41-1.41L11.83 12l3.88-3.88a1 1 0 0 0 0-1.41z"
          />
        {/if}
      </svg>
    </button>
    {#if geojson}
      <MapView
        {geojson}
        counts={visibleCounts}
        settings={mapSettings}
        {orgForms}
        {locateRequest}
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
    transition: grid-template-columns 0.2s ease;
  }

  .panel-slot {
    min-width: 0;
    overflow: hidden;
  }

  .layout.panel-collapsed {
    grid-template-columns: 0fr 1fr;
  }

  .map-area {
    position: relative;
    min-width: 0;
    height: 100%;
  }

  .panel-toggle {
    position: absolute;
    top: 0.75rem;
    left: 0.75rem;
    z-index: 1000;
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    margin: 0;
    padding: 0;
    border: 1px solid #334155;
    border-radius: 0.45rem;
    background: #0f172a;
    color: #e2e8f0;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }

  .panel-toggle:hover {
    background: #1e293b;
    color: #f8fafc;
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

    .layout.panel-collapsed {
      grid-template-columns: 1fr;
      grid-template-rows: 0 1fr;
    }
  }
</style>

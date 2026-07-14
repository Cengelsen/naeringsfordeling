<script lang="ts">
  import type { Kommune, DotsLoadState, LoadingState, Organisasjonsform } from '../types'
  import {
    mapSettings,
    resetSettings,
    setColorScheme,
    setVisualization,
    toggleOrgType,
  } from '../stores/settings.svelte'
  import { MIN_DOTS_ZOOM } from '../services/api'
  import { fylkeFromKommune, fylkeName } from '../utils/geo'

  import type { ColorScheme, VisualizationMode } from '../types'

  interface Props {
    orgForms: Organisasjonsform[]
    kommuner: Kommune[]
    loading: LoadingState
    dotsState: DotsLoadState
    totalCount: number
    onRefresh: () => void
  }

  let { orgForms, kommuner, loading, dotsState, totalCount, onRefresh }: Props = $props()

  let orgSearch = $state('')
  let showAllOrgForms = $state(false)

  const fylker = $derived.by(() => {
    const codes = new Set(kommuner.map((k) => fylkeFromKommune(k.nummer)))
    return [...codes]
      .sort((a, b) => fylkeName(a).localeCompare(fylkeName(b), 'nb'))
      .map((kode) => ({ kode, navn: fylkeName(kode) }))
  })

  const filteredOrgForms = $derived.by(() => {
    const query = orgSearch.trim().toLowerCase()
    const list = query
      ? orgForms.filter(
          (f) =>
            f.kode.toLowerCase().includes(query) ||
            f.beskrivelse.toLowerCase().includes(query),
        )
      : orgForms
    return showAllOrgForms ? list : list.slice(0, 12)
  })

  const selectedOrgCount = $derived(mapSettings.orgTypes.length)
  const isDotsView = $derived(mapSettings.visualization === 'dots')

  const filteredKommuner = $derived.by(() => {
    if (!mapSettings.selectedFylke) return kommuner
    return kommuner.filter(
      (k) => fylkeFromKommune(k.nummer) === mapSettings.selectedFylke,
    )
  })
</script>

<aside class="panel">
  <header class="panel-header">
    <h1>Næringsfordeling</h1>
    <p class="subtitle">Organisasjoner i Norge · SQLite + OpenStreetMap</p>
  </header>

  <section class="section stats">
    <div class="stat">
      <span class="stat-value">{totalCount.toLocaleString('nb-NO')}</span>
      <span class="stat-label">{isDotsView ? 'Prikker' : 'Organisasjoner'}</span>
    </div>
    <div class="stat">
      <span class="stat-value">{kommuner.length}</span>
      <span class="stat-label">Kommuner</span>
    </div>
  </section>

  {#if loading.loading}
    <div class="loading">
      <div class="loading-bar">
        <div
          class="loading-fill"
          style:width="{loading.total ? (loading.progress / loading.total) * 100 : 0}%"
        ></div>
      </div>
      <p>Henter data fra database…</p>
    </div>
  {:else if loading.error}
    <div class="error">{loading.error}</div>
  {/if}

  <section class="section">
    <h2>Visualisering</h2>
    <div class="segmented three">
      {#each [['choropleth', 'Kart'], ['bubbles', 'Bobler'], ['dots', 'Adresser']] as const as [mode, label] (mode)}
        <button
          type="button"
          class:active={mapSettings.visualization === mode}
          onclick={() => setVisualization(mode as VisualizationMode)}
        >
          {label}
        </button>
      {/each}
    </div>

    {#if isDotsView}
      <p class="hint">
        Zoom inn (nivå {MIN_DOTS_ZOOM}+) eller velg fylke/kommune. Hver prikk er én geokodet
        organisasjon fra SQLite-databasen.
      </p>
      {#if dotsState.loading}
        <p class="hint loading-hint">
          {dotsState.phase === 'fetching' ? 'Henter organisasjoner…' : 'Geokoder adresser…'}
          {dotsState.message ?? ''}
        </p>
      {:else if dotsState.organizations > 0}
        <p class="hint">
          {dotsState.organizations.toLocaleString('nb-NO')} prikker i kartet
          {#if dotsState.skipped > 0}
            · {dotsState.skipped.toLocaleString('nb-NO')} uten adressetreff
          {/if}
        </p>
      {/if}
    {/if}

    <label class="field">
      <span>Fargepalett</span>
      <select
        value={mapSettings.colorScheme}
        onchange={(e) => setColorScheme(e.currentTarget.value as ColorScheme)}
        disabled={isDotsView}
      >
        <option value="blues">Blå</option>
        <option value="oranges">Oransje</option>
        <option value="greens">Grønn</option>
        <option value="purples">Lilla</option>
      </select>
    </label>

    <label class="checkbox">
      <input type="checkbox" bind:checked={mapSettings.showLegend} />
      Vis forklaring
    </label>
  </section>

  <section class="section">
    <h2>Kommune</h2>
    <select bind:value={mapSettings.selectedKommune}>
      <option value="">Alle / kartutsnitt</option>
      {#each filteredKommuner as kommune (kommune.nummer)}
        <option value={kommune.nummer}>{kommune.navn}</option>
      {/each}
    </select>
  </section>

  <section class="section">
    <h2>Fylke</h2>
    <select bind:value={mapSettings.selectedFylke}>
      <option value="">Hele Norge</option>
      {#each fylker as fylke (fylke.kode)}
        <option value={fylke.kode}>{fylke.navn}</option>
      {/each}
    </select>
  </section>

  <section class="section">
    <h2>Organisasjonstype</h2>
    <p class="hint">
      {selectedOrgCount === 0
        ? 'Alle typer vises'
        : `${selectedOrgCount} type${selectedOrgCount === 1 ? '' : 'r'} valgt`}
    </p>
    <input
      type="search"
      placeholder="Søk organisasjonsform…"
      bind:value={orgSearch}
    />
    <div class="org-list">
      {#each filteredOrgForms as form (form.kode)}
        <label class="checkbox org-item">
          <input
            type="checkbox"
            checked={mapSettings.orgTypes.includes(form.kode)}
            onchange={() => toggleOrgType(form.kode)}
          />
          <span class="org-code">{form.kode}</span>
          <span class="org-label">{form.beskrivelse}</span>
        </label>
      {/each}
    </div>
    {#if orgForms.length > 12}
      <button type="button" class="link-btn" onclick={() => (showAllOrgForms = !showAllOrgForms)}>
        {showAllOrgForms ? 'Vis færre' : `Vis alle (${orgForms.length})`}
      </button>
    {/if}
    {#if selectedOrgCount > 0}
      <button type="button" class="link-btn" onclick={() => (mapSettings.orgTypes = [])}>
        Nullstill valg
      </button>
    {/if}
  </section>

  <section class="section">
    <h2>Filtrering</h2>
    <label class="checkbox">
      <input type="checkbox" bind:checked={mapSettings.excludeKonkurs} />
      Ekskluder konkurs
    </label>
    <label class="checkbox">
      <input type="checkbox" bind:checked={mapSettings.excludeUnderAvvikling} />
      Ekskluder under avvikling
    </label>
    <label class="checkbox">
      <input type="checkbox" bind:checked={mapSettings.vatRegisteredOnly} />
      Kun MVA-registrerte
    </label>
  </section>

  <footer class="panel-footer">
    <button type="button" class="primary" onclick={onRefresh} disabled={loading.loading}>
      Oppdater data
    </button>
    <button type="button" class="secondary" onclick={resetSettings}>Tilbakestill</button>
  </footer>
</aside>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0;
    height: 100%;
    overflow: auto;
    background: #0f172a;
    color: #e2e8f0;
    border-right: 1px solid #1e293b;
  }

  .panel-header {
    padding: 1.25rem 1.25rem 0.75rem;
    border-bottom: 1px solid #1e293b;
  }

  h1 {
    margin: 0;
    font-size: 1.35rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .subtitle {
    margin: 0.35rem 0 0;
    font-size: 0.82rem;
    color: #94a3b8;
  }

  .section {
    padding: 1rem 1.25rem;
    border-bottom: 1px solid #1e293b;
  }

  h2 {
    margin: 0 0 0.75rem;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #94a3b8;
  }

  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .stat {
    background: #1e293b;
    border-radius: 0.5rem;
    padding: 0.75rem;
  }

  .stat-value {
    display: block;
    font-size: 1.25rem;
    font-weight: 700;
    color: #f8fafc;
  }

  .stat-label {
    font-size: 0.75rem;
    color: #94a3b8;
  }

  .loading,
  .error {
    margin: 0 1.25rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.85rem;
  }

  .loading {
    background: #1e293b;
    color: #cbd5e1;
  }

  .loading-bar {
    height: 4px;
    background: #334155;
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 0.5rem;
  }

  .loading-fill {
    height: 100%;
    background: #38bdf8;
    transition: width 0.2s ease;
  }

  .error {
    background: #450a0a;
    color: #fecaca;
  }

  .segmented {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .segmented.three {
    grid-template-columns: repeat(3, 1fr);
  }

  .loading-hint {
    color: #7dd3fc;
  }

  .segmented button,
  .primary,
  .secondary {
    border: 1px solid #334155;
    background: #1e293b;
    color: #e2e8f0;
    border-radius: 0.45rem;
    padding: 0.55rem 0.75rem;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .segmented button:hover,
  .primary:hover:not(:disabled),
  .secondary:hover {
    background: #334155;
  }

  .segmented button.active {
    background: #0369a1;
    border-color: #0284c7;
    color: #f0f9ff;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-bottom: 0.75rem;
    font-size: 0.85rem;
  }

  select,
  input[type='search'] {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #334155;
    background: #1e293b;
    color: #e2e8f0;
    border-radius: 0.45rem;
    padding: 0.55rem 0.65rem;
    font-size: 0.85rem;
  }

  .checkbox {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 0.85rem;
    margin-bottom: 0.45rem;
    cursor: pointer;
  }

  .checkbox input {
    margin-top: 0.15rem;
  }

  .hint {
    margin: -0.35rem 0 0.65rem;
    font-size: 0.8rem;
    color: #94a3b8;
  }

  .org-list {
    max-height: 220px;
    overflow: auto;
    margin-top: 0.5rem;
    padding-right: 0.25rem;
  }

  .org-item {
    align-items: center;
    padding: 0.35rem 0;
    border-bottom: 1px solid #1e293b;
  }

  .org-code {
    flex-shrink: 0;
    width: 2.75rem;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: #7dd3fc;
  }

  .org-label {
    font-size: 0.8rem;
    line-height: 1.3;
  }

  .link-btn {
    margin-top: 0.5rem;
    padding: 0;
    border: none;
    background: none;
    color: #7dd3fc;
    font-size: 0.8rem;
    cursor: pointer;
    display: block;
  }

  .panel-footer {
    margin-top: auto;
    padding: 1rem 1.25rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .primary {
    background: #0284c7;
    border-color: #0369a1;
  }

  .primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>

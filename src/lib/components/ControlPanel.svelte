<script lang="ts">
  import type { Kommune, DotsLoadState, LoadingState, Organisasjonsform } from '../types'
  import {
    mapSettings,
    toggleEmployeeBand,
    toggleEntityKind,
    toggleNaeringskodeSection,
    toggleOrgType,
  } from '../stores/settings.svelte'
  import { fetchNaeringskoder } from '../services/api'
  import { EMPLOYEE_BANDS, EMPLOYEE_BAND_LABELS } from '../utils/employeeBands'
  import { naeringskodeSectionLabel } from '../utils/naeringskode'

  import type { NaeringskodeOption } from '../services/api'

  import OrgLookupCombobox from './OrgLookupCombobox.svelte'
  import VisualizationControls from './VisualizationControls.svelte'

  interface Props {
    orgForms: Organisasjonsform[]
    kommuner: Kommune[]
    loading: LoadingState
    dotsState: DotsLoadState
    totalCount: number | null
    onLocateOrganization: (orgnr: string) => void
  }

  let { orgForms, kommuner, loading, dotsState, totalCount, onLocateOrganization }: Props = $props()

  let orgSearch = $state('')
  let showAllOrgForms = $state(false)
  let naeringskoder = $state<NaeringskodeOption[]>([])
  let showAllNaering = $state(false)

  void fetchNaeringskoder()
    .then((rows) => {
      naeringskoder = rows
    })
    .catch(() => {
      naeringskoder = []
    })

  const fylkerCount = $derived.by(() => {
    const codes = new Set(kommuner.map((k) => k.nummer.slice(0, 2)))
    return codes.size
  })

  const filteredOrgForms = $derived.by(() => {
    const query = orgSearch.trim().toLowerCase()
    const list = query
      ? orgForms.filter(
          (f) =>
            f.kode.toLowerCase().includes(query) || f.beskrivelse.toLowerCase().includes(query),
        )
      : orgForms
    return showAllOrgForms ? list : list.slice(0, 12)
  })

  const filteredNaeringskoder = $derived.by(() => {
    return showAllNaering ? naeringskoder : naeringskoder.slice(0, 12)
  })

  const selectedOrgCount = $derived(mapSettings.orgTypes.length)
  const isDotsView = $derived(mapSettings.visualization === 'dots')
  const isFylkeLevel = $derived(!isDotsView && mapSettings.districtLevel === 'fylke')
</script>

<aside class="panel" aria-label="Kontrollpanel">
  <header class="panel-header">
    <h1>Næringsfordeling</h1>
    <p class="subtitle">Organisasjoner i Norge · SQLite + OpenStreetMap</p>
  </header>

  <OrgLookupCombobox {onLocateOrganization} />

  <section class="section stats">
    {#if isDotsView && dotsState.statsLoading}
      <div class="stat">
        <span class="stat-value">…</span>
        <span class="stat-label">Beregner adresser…</span>
      </div>
    {:else if isDotsView && dotsState.viewportSummary}
      <div class="stat">
        <span class="stat-value">
          {dotsState.viewportSummary.addressesInBbox.toLocaleString('nb-NO')}
        </span>
        <span class="stat-label">Adresser i utsnittet</span>
      </div>
      {#if dotsState.viewportSummary.geocodedInBbox !== dotsState.viewportSummary.addressesInBbox}
        <div class="stat">
          <span class="stat-value">
            {dotsState.viewportSummary.geocodedInBbox.toLocaleString('nb-NO')}
          </span>
          <span class="stat-label">Organisasjoner</span>
        </div>
      {/if}
      {#if dotsState.viewportSummary.ungeocodedInViewport > 0}
        <div class="stat">
          <span class="stat-value">
            {dotsState.viewportSummary.ungeocodedInViewport.toLocaleString('nb-NO')}
          </span>
          <span class="stat-label">Uten kartkoordinat</span>
        </div>
      {/if}
      {#if dotsState.viewportSummary.renderMode === 'individual' && dotsState.renderedFeatureCount != null && dotsState.renderedFeatureCount > 0}
        <div class="stat">
          <span class="stat-value">
            {dotsState.renderedFeatureCount.toLocaleString('nb-NO')}
          </span>
          <span class="stat-label">Prikker vist</span>
        </div>
      {/if}
    {:else if !isDotsView}
      <div class="stat">
        <span class="stat-value">{(totalCount ?? 0).toLocaleString('nb-NO')}</span>
        <span class="stat-label">Organisasjoner</span>
      </div>
    {:else}
      <div class="stat">
        <span class="stat-value">—</span>
        <span class="stat-label">Adresser i utsnittet</span>
      </div>
    {/if}
    {#if !isDotsView}
      <div class="stat">
        <span class="stat-value">{isFylkeLevel ? fylkerCount : kommuner.length}</span>
        <span class="stat-label">{isFylkeLevel ? 'Fylker' : 'Kommuner'}</span>
      </div>
    {/if}
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

  <VisualizationControls {kommuner} {dotsState} />

  <section class="section">
    <h2>Organisasjonstype</h2>
    <p class="hint">
      {selectedOrgCount === 0
        ? 'Alle typer vises'
        : `${selectedOrgCount} type${selectedOrgCount === 1 ? '' : 'r'} valgt`}
    </p>
    <input type="search" placeholder="Søk organisasjonsform…" bind:value={orgSearch} />
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
    <h2>Næring</h2>
    <p class="hint">
      {mapSettings.naeringskodeSections.length === 0
        ? 'Alle næringer vises'
        : `${mapSettings.naeringskodeSections.length} seksjon${mapSettings.naeringskodeSections.length === 1 ? '' : 'er'} valgt`}
    </p>
    <div class="org-list">
      {#each filteredNaeringskoder as item (item.section)}
        <label class="checkbox org-item">
          <input
            type="checkbox"
            checked={mapSettings.naeringskodeSections.includes(item.section)}
            onchange={() => toggleNaeringskodeSection(item.section)}
          />
          <span class="org-code">{item.section}</span>
          <span class="org-label">
            {naeringskodeSectionLabel(item.section, item.label)}
          </span>
        </label>
      {/each}
    </div>
    {#if naeringskoder.length > 12}
      <button type="button" class="link-btn" onclick={() => (showAllNaering = !showAllNaering)}>
        {showAllNaering ? 'Vis færre' : `Vis alle (${naeringskoder.length})`}
      </button>
    {/if}
    {#if mapSettings.naeringskodeSections.length > 0}
      <button
        type="button"
        class="link-btn"
        onclick={() => (mapSettings.naeringskodeSections = [])}
      >
        Nullstill valg
      </button>
    {/if}
  </section>

  <section class="section">
    <h2>Antall ansatte</h2>
    {#each EMPLOYEE_BANDS as band (band)}
      <label class="checkbox">
        <input
          type="checkbox"
          checked={mapSettings.employeeBands.includes(band)}
          onchange={() => toggleEmployeeBand(band)}
        />
        {EMPLOYEE_BAND_LABELS[band]}
      </label>
    {/each}
    {#if mapSettings.employeeBands.length > 0}
      <button type="button" class="link-btn" onclick={() => (mapSettings.employeeBands = [])}>
        Nullstill valg
      </button>
    {/if}
  </section>

  <section class="section">
    <h2>Enhetstype</h2>
    <label class="checkbox">
      <input
        type="checkbox"
        checked={mapSettings.entityKinds.includes('enhet')}
        onchange={() => toggleEntityKind('enhet')}
      />
      Hovedenheter
    </label>
    <label class="checkbox">
      <input
        type="checkbox"
        checked={mapSettings.entityKinds.includes('underenhet')}
        onchange={() => toggleEntityKind('underenhet')}
      />
      Underenheter
    </label>
  </section>

  <section class="section">
    <h2>Konsern</h2>
    <label class="checkbox">
      <input type="checkbox" bind:checked={mapSettings.konsernMode} />
      Konsern-modus (vis tre i popup)
    </label>
    <label class="checkbox">
      <input type="checkbox" bind:checked={mapSettings.konsernMembersOnly} />
      Kun konsernmedlemmer
    </label>
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

  :global(.section) {
    padding: 1rem 1.25rem;
    border-bottom: 1px solid #1e293b;
  }

  :global(h2) {
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

  :global(.segmented) {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  :global(.segmented.nested) {
    margin-bottom: 0.85rem;
  }

  :global(.segmented.nested button) {
    font-size: 0.8rem;
    padding: 0.45rem 0.65rem;
  }

  :global(.loading-hint) {
    color: #7dd3fc;
  }

  :global(.segmented button) {
    border: 1px solid #334155;
    background: #1e293b;
    color: #e2e8f0;
    border-radius: 0.45rem;
    padding: 0.55rem 0.75rem;
    font-size: 0.85rem;
    cursor: pointer;
    transition:
      background 0.15s,
      border-color 0.15s;
  }

  :global(.segmented button:hover) {
    background: #334155;
  }

  :global(.segmented button.active) {
    background: #0369a1;
    border-color: #0284c7;
    color: #f0f9ff;
  }

  :global(.field) {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-bottom: 0.75rem;
    font-size: 0.85rem;
  }

  :global(select),
  :global(input[type='search']) {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #334155;
    background: #1e293b;
    color: #e2e8f0;
    border-radius: 0.45rem;
    padding: 0.55rem 0.65rem;
    font-size: 0.85rem;
  }

  :global(.checkbox) {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 0.85rem;
    margin-bottom: 0.45rem;
    cursor: pointer;
  }

  :global(.checkbox input) {
    margin-top: 0.15rem;
  }

  :global(.hint) {
    margin: -0.35rem 0 0.65rem;
    font-size: 0.8rem;
    color: #94a3b8;
  }

  :global(.webgl-notice) {
    margin: 0 0 0.85rem;
    padding: 0.75rem;
    border: 1px solid #334155;
    border-radius: 0.5rem;
    background: #1e293b;
    font-size: 0.8rem;
    color: #cbd5e1;
    line-height: 1.4;
  }

  :global(.webgl-notice p) {
    margin: 0 0 0.5rem;
  }

  :global(.webgl-notice p:last-child) {
    margin-bottom: 0;
  }

  :global(.webgl-notice strong) {
    color: #fde68a;
  }

  :global(.webgl-notice ol) {
    margin: 0.35rem 0 0;
    padding-left: 1.2rem;
  }

  :global(.webgl-notice li) {
    margin-bottom: 0.25rem;
  }

  :global(.webgl-notice code) {
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
    color: #7dd3fc;
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
</style>

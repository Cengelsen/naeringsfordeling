<script lang="ts">
  import type { Kommune, DotsLoadState, LoadingState, Organisasjonsform } from '../types'
  import {
    mapSettings,
    setColorScheme,
    setDistrictLevel,
    setVisualization,
    toggleEmployeeBand,
    toggleEntityKind,
    toggleNaeringskodeSection,
    toggleOrgType,
  } from '../stores/settings.svelte'
  import { fetchNaeringskoder, searchOrganizations } from '../services/api'
  import { fylkeFromKommune, fylkeName } from '../utils/geo'
  import { EMPLOYEE_BANDS, EMPLOYEE_BAND_LABELS } from '../utils/employeeBands'
  import { naeringskodeSectionLabel } from '../utils/naeringskode'

  import type {
    ColorScheme,
    DistrictLevel,
    OrganizationSearchHit,
    VisualizationMode,
  } from '../types'
  import type { NaeringskodeOption } from '../services/api'

  interface Props {
    orgForms: Organisasjonsform[]
    kommuner: Kommune[]
    loading: LoadingState
    dotsState: DotsLoadState
    totalCount: number
    onLocateOrganization: (orgnr: string) => void
  }

  let { orgForms, kommuner, loading, dotsState, totalCount, onLocateOrganization }: Props = $props()

  let orgSearch = $state('')
  let showAllOrgForms = $state(false)
  let orgLookupQuery = $state('')
  let orgLookupLoading = $state(false)
  let orgLookupError = $state<string | null>(null)
  let orgLookupResults = $state<OrganizationSearchHit[]>([])
  let orgLookupOpen = $state(false)
  let orgLookupActiveIndex = $state(-1)
  let naeringskoder = $state<NaeringskodeOption[]>([])
  let showAllNaering = $state(false)

  void fetchNaeringskoder()
    .then((rows) => {
      naeringskoder = rows
    })
    .catch(() => {
      naeringskoder = []
    })

  const ORG_LOOKUP_DEBOUNCE_MS = 450
  let orgLookupTimer: ReturnType<typeof setTimeout> | undefined
  let orgLookupSeq = 0

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

  const filteredNaeringskoder = $derived.by(() => {
    return showAllNaering ? naeringskoder : naeringskoder.slice(0, 12)
  })

  const selectedOrgCount = $derived(mapSettings.orgTypes.length)
  const isDotsView = $derived(mapSettings.visualization === 'dots')
  const isFylkeLevel = $derived(
    !isDotsView && mapSettings.districtLevel === 'fylke',
  )

  const filteredKommuner = $derived.by(() => {
    if (!mapSettings.selectedFylke) return kommuner
    return kommuner.filter(
      (k) => fylkeFromKommune(k.nummer) === mapSettings.selectedFylke,
    )
  })

  function clearOrgLookupResults() {
    orgLookupResults = []
    orgLookupOpen = false
    orgLookupError = null
    orgLookupLoading = false
    orgLookupActiveIndex = -1
  }

  function scheduleOrgLookupSearch() {
    if (orgLookupTimer) clearTimeout(orgLookupTimer)

    const query = orgLookupQuery.trim()
    if (query.length < 2) {
      clearOrgLookupResults()
      return
    }

    orgLookupTimer = setTimeout(() => {
      orgLookupTimer = undefined
      void runOrgLookupSearch(query)
    }, ORG_LOOKUP_DEBOUNCE_MS)
  }

  async function runOrgLookupSearch(query: string) {
    const seq = ++orgLookupSeq
    orgLookupLoading = true
    orgLookupError = null

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    if (seq !== orgLookupSeq || orgLookupQuery.trim() !== query) return

    try {
      const results = await searchOrganizations(query)
      if (seq !== orgLookupSeq || orgLookupQuery.trim() !== query) return

      orgLookupResults = results
      orgLookupOpen = results.length > 0
      orgLookupActiveIndex = -1
      orgLookupError = results.length === 0 ? 'Ingen treff' : null
    } catch (err) {
      if (seq !== orgLookupSeq) return
      orgLookupError = err instanceof Error ? err.message : 'Søk feilet'
      orgLookupResults = []
      orgLookupOpen = false
      orgLookupActiveIndex = -1
    } finally {
      if (seq === orgLookupSeq) orgLookupLoading = false
    }
  }

  function onOrgLookupInput() {
    scheduleOrgLookupSearch()
  }

  function selectOrgLookupResult(hit: OrganizationSearchHit) {
    orgLookupQuery = hit.navn
    orgLookupOpen = false
    orgLookupResults = []
    orgLookupError = null
    orgLookupActiveIndex = -1
    onLocateOrganization(hit.orgnr)
  }

  function onOrgLookupFocus() {
    if (orgLookupResults.length > 0) orgLookupOpen = true
  }

  function onOrgLookupBlur() {
    setTimeout(() => {
      orgLookupOpen = false
      orgLookupActiveIndex = -1
    }, 150)
  }

  function onOrgLookupKeydown(event: KeyboardEvent) {
    if (!orgLookupOpen || orgLookupResults.length === 0) {
      if (event.key === 'Enter') event.preventDefault()
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      orgLookupActiveIndex = Math.min(orgLookupActiveIndex + 1, orgLookupResults.length - 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      orgLookupActiveIndex = Math.max(orgLookupActiveIndex - 1, 0)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const index = orgLookupActiveIndex >= 0 ? orgLookupActiveIndex : 0
      selectOrgLookupResult(orgLookupResults[index])
    } else if (event.key === 'Escape') {
      orgLookupOpen = false
      orgLookupActiveIndex = -1
    }
  }
</script>

<aside class="panel" aria-label="Kontrollpanel">
  <header class="panel-header">
    <h1>Næringsfordeling</h1>
    <p class="subtitle">Organisasjoner i Norge · SQLite + OpenStreetMap</p>
  </header>

  <section class="section">
    <h2>Søk organisasjon</h2>
    <div class="lookup-combobox">
      <input
        type="search"
        placeholder="Org.nr eller navn…"
        bind:value={orgLookupQuery}
        oninput={onOrgLookupInput}
        autocomplete="off"
        role="combobox"
        aria-expanded={orgLookupOpen}
        aria-controls="org-lookup-list"
        aria-autocomplete="list"
        aria-label="Søk etter organisasjonsnummer eller navn"
        onfocus={onOrgLookupFocus}
        onblur={onOrgLookupBlur}
        onkeydown={onOrgLookupKeydown}
      />
      {#if orgLookupLoading}
        <span class="lookup-status" aria-hidden="true">Søker…</span>
      {/if}
      {#if orgLookupOpen && orgLookupResults.length > 0}
        <ul id="org-lookup-list" class="lookup-dropdown" role="listbox">
          {#each orgLookupResults as hit, index (hit.orgnr)}
            <li role="presentation">
              <button
                type="button"
                class="lookup-result"
                class:active={index === orgLookupActiveIndex}
                role="option"
                aria-selected={index === orgLookupActiveIndex}
                onmousedown={(event) => event.preventDefault()}
                onclick={() => selectOrgLookupResult(hit)}
              >
                <span class="lookup-name">{hit.navn}</span>
                <span class="lookup-meta">{hit.orgnr} · {hit.orgType}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    {#if orgLookupError && !orgLookupOpen}
      <p class="hint lookup-error">{orgLookupError}</p>
    {/if}
  </section>

  <section class="section stats">
    {#if isDotsView && dotsState.viewportSummary}
      <div class="stat">
        <span class="stat-value">
          {dotsState.viewportSummary.geocodedInBbox.toLocaleString('nb-NO')}
        </span>
        <span class="stat-label">I kartutsnittet</span>
      </div>
      {#if dotsState.viewportSummary.ungeocodedInViewport > 0}
        <div class="stat">
          <span class="stat-value">
            {dotsState.viewportSummary.ungeocodedInViewport.toLocaleString('nb-NO')}
          </span>
          <span class="stat-label">Uten kartkoordinat</span>
        </div>
      {/if}
      {#if dotsState.renderedFeatureCount != null && dotsState.renderedFeatureCount > 0}
        <div class="stat">
          <span class="stat-value">
            {dotsState.renderedFeatureCount.toLocaleString('nb-NO')}
          </span>
          <span class="stat-label">Prikker vist</span>
        </div>
      {/if}
    {:else}
      <div class="stat">
        <span class="stat-value">{totalCount.toLocaleString('nb-NO')}</span>
        <span class="stat-label">{isDotsView ? 'Prikker' : 'Organisasjoner'}</span>
      </div>
    {/if}
    <div class="stat">
      <span class="stat-value">{isFylkeLevel ? fylker.length : kommuner.length}</span>
      <span class="stat-label">{isFylkeLevel ? 'Fylker' : 'Kommuner'}</span>
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
    <div class="segmented">
      {#each [['choropleth', 'Distrikter'], ['dots', 'Adresser']] as const as [mode, label] (mode)}
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
        Statistikken gjelder hele kartutsnittet. Ved lav zoom vises forhåndsaggregerte celleprikker; zoom inn for enkeltadresser.
      </p>
    {:else}
      <div class="segmented nested">
        {#each [['fylke', 'Fylker'], ['kommune', 'Kommuner']] as const as [level, label] (level)}
          <button
            type="button"
            class:active={mapSettings.districtLevel === level}
            onclick={() => setDistrictLevel(level as DistrictLevel)}
          >
            {label}
          </button>
        {/each}
      </div>

      <label class="field">
        <span>Fargepalett</span>
        <select
          value={mapSettings.colorScheme}
          onchange={(e) => setColorScheme(e.currentTarget.value as ColorScheme)}
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
    {/if}
  </section>

  {#if isDotsView}
    <section class="section">
      <h2>Adresser</h2>
      {#if dotsState.webglUnavailable}
        <div class="webgl-notice">
          <p>
            <strong>WebGL er deaktivert</strong> i nettleseren. Kartprikker vises i forenklet
            modus (uten vektorfliser).
          </p>
          <p>For full adressevisning i LibreWolf/Firefox:</p>
          <ol>
            <li>Åpne <code>about:config</code></li>
            <li>Søk etter <code>webgl.disabled</code></li>
            <li>Sett verdien til <code>false</code></li>
            <li>Last siden på nytt</li>
          </ol>
        </div>
      {/if}
      {#if dotsState.loading}
        <p class="hint loading-hint">
          {dotsState.phase === 'fetching' ? 'Henter organisasjoner…' : 'Oppdaterer kart…'}
          {dotsState.message ?? ''}
        </p>
      {:else if dotsState.viewportSummary}
        <p class="hint">
          {dotsState.viewportSummary.geocodedInBbox.toLocaleString('nb-NO')} geokodede i kartutsnittet
          {#if dotsState.viewportSummary.ungeocodedInViewport > 0}
            · {dotsState.viewportSummary.ungeocodedInViewport.toLocaleString('nb-NO')} uten kartkoordinat
          {/if}
          {#if dotsState.renderedFeatureCount != null && dotsState.renderedFeatureCount > 0}
            · {dotsState.renderedFeatureCount.toLocaleString('nb-NO')} prikker vist
          {/if}
          {#if dotsState.statsApproximate}
            · omtrentlige tall (statisk modus)
          {/if}
        </p>
      {:else if dotsState.organizations > 0}
        <p class="hint">
          {dotsState.organizations.toLocaleString('nb-NO')} prikker i kartet
          {#if dotsState.skipped > 0}
            · {dotsState.skipped.toLocaleString('nb-NO')} uten adressetreff
          {/if}
        </p>
      {/if}
    </section>
  {:else}
    {#if !isFylkeLevel}
      <section class="section">
        <h2>Kommune</h2>
        <select bind:value={mapSettings.selectedKommune}>
          <option value="">Alle / kartutsnitt</option>
          {#each filteredKommuner as kommune (kommune.nummer)}
            <option value={kommune.nummer}>{kommune.navn}</option>
          {/each}
        </select>
      </section>
    {/if}

    <section class="section">
      <h2>Fylke</h2>
      <select bind:value={mapSettings.selectedFylke}>
        <option value="">Hele Norge</option>
        {#each fylker as fylke (fylke.kode)}
          <option value={fylke.kode}>{fylke.navn}</option>
        {/each}
      </select>
    </section>
  {/if}

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

  .segmented.nested {
    margin-bottom: 0.85rem;
  }

  .segmented.nested button {
    font-size: 0.8rem;
    padding: 0.45rem 0.65rem;
  }

  .loading-hint {
    color: #7dd3fc;
  }

  .segmented button {
    border: 1px solid #334155;
    background: #1e293b;
    color: #e2e8f0;
    border-radius: 0.45rem;
    padding: 0.55rem 0.75rem;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .segmented button:hover {
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

  .webgl-notice {
    margin: 0 0 0.85rem;
    padding: 0.75rem;
    border: 1px solid #334155;
    border-radius: 0.5rem;
    background: #1e293b;
    font-size: 0.8rem;
    color: #cbd5e1;
    line-height: 1.4;
  }

  .webgl-notice p {
    margin: 0 0 0.5rem;
  }

  .webgl-notice p:last-child {
    margin-bottom: 0;
  }

  .webgl-notice strong {
    color: #fde68a;
  }

  .webgl-notice ol {
    margin: 0.35rem 0 0;
    padding-left: 1.2rem;
  }

  .webgl-notice li {
    margin-bottom: 0.25rem;
  }

  .webgl-notice code {
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

  .lookup-combobox {
    position: relative;
  }

  .lookup-combobox input[type='search'] {
    width: 100%;
  }

  .lookup-status {
    position: absolute;
    top: 0.65rem;
    right: 0.65rem;
    font-size: 0.72rem;
    color: #64748b;
    pointer-events: none;
  }

  .lookup-error {
    color: #fecaca;
  }

  .lookup-dropdown {
    position: absolute;
    top: calc(100% + 0.25rem);
    left: 0;
    right: 0;
    z-index: 30;
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
    max-height: 240px;
    overflow: auto;
    border: 1px solid #334155;
    border-radius: 0.45rem;
    background: #0f172a;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
  }

  .lookup-result {
    width: 100%;
    margin: 0;
    padding: 0.55rem 0.75rem;
    border: none;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .lookup-result:hover,
  .lookup-result.active {
    background: #1e293b;
    color: #7dd3fc;
  }

  .lookup-name {
    display: block;
    font-size: 0.85rem;
    line-height: 1.3;
  }

  .lookup-meta {
    display: block;
    margin-top: 0.15rem;
    font-size: 0.75rem;
    color: #94a3b8;
  }
</style>

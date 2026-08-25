<script lang="ts">
  import type { Kommune, DotsLoadState } from '../types'
  import type { ColorScheme, DistrictLevel, VisualizationMode } from '../types'
  import {
    mapSettings,
    setColorScheme,
    setDistrictLevel,
    setVisualization,
  } from '../stores/settings.svelte'
  import { fylkeFromKommune, fylkeName } from '../utils/geo'

  interface Props {
    kommuner: Kommune[]
    dotsState: DotsLoadState
  }

  let { kommuner, dotsState }: Props = $props()

  const isDotsView = $derived(mapSettings.visualization === 'dots')
  const isFylkeLevel = $derived(!isDotsView && mapSettings.districtLevel === 'fylke')

  const fylker = $derived.by(() => {
    const codes = new Set(kommuner.map((k) => fylkeFromKommune(k.nummer)))
    return [...codes]
      .sort((a, b) => fylkeName(a).localeCompare(fylkeName(b), 'nb'))
      .map((kode) => ({ kode, navn: fylkeName(kode) }))
  })

  const filteredKommuner = $derived.by(() => {
    if (!mapSettings.selectedFylke) return kommuner
    return kommuner.filter((k) => fylkeFromKommune(k.nummer) === mapSettings.selectedFylke)
  })
</script>

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
      Statistikken gjelder hele kartutsnittet. Ved lav zoom vises fylke/kommune/grunnkretser med
      org.type-fordeling (som Distrikter); enkeltadresser fra zoom 15.
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
          <strong>WebGL er deaktivert</strong> i nettleseren. Kartprikker vises i forenklet modus (uten
          vektorfliser).
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
    {:else if dotsState.statsLoading}
      <p class="hint loading-hint">Beregner adresser i utsnittet…</p>
    {:else if dotsState.viewportSummary}
      <p class="hint">
        {dotsState.viewportSummary.addressesInBbox.toLocaleString('nb-NO')} adresser i kartutsnittet
        {#if dotsState.viewportSummary.geocodedInBbox !== dotsState.viewportSummary.addressesInBbox}
          · {dotsState.viewportSummary.geocodedInBbox.toLocaleString('nb-NO')} organisasjoner
        {/if}
        {#if dotsState.viewportSummary.ungeocodedInViewport > 0}
          · {dotsState.viewportSummary.ungeocodedInViewport.toLocaleString('nb-NO')} uten kartkoordinat
        {/if}
        {#if dotsState.viewportSummary.renderMode === 'individual' && dotsState.renderedFeatureCount != null && dotsState.renderedFeatureCount > 0}
          · {dotsState.renderedFeatureCount.toLocaleString('nb-NO')} prikker vist
        {/if}
        {#if dotsState.statsApproximate}
          · omtrentlige tall (statisk modus)
        {/if}
      </p>
    {:else if dotsState.message}
      <p class="hint">{dotsState.message}</p>
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

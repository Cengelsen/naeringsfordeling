<script lang="ts">
  import type { DotsLoadState } from '../types'

  interface Props {
    orgFocusActive: boolean
    visualization: string
    dotsState: DotsLoadState
    webglUnavailable: boolean
    webglBannerDismissed: boolean
    mapZoom: number
    currentDetailLevel: string
    totalVisible: number | null
    dotsSourceLabel: string
    onDismissWebglBanner: () => void
  }

  let {
    orgFocusActive,
    visualization,
    dotsState,
    webglUnavailable,
    webglBannerDismissed,
    mapZoom,
    currentDetailLevel,
    totalVisible,
    dotsSourceLabel,
    onDismissWebglBanner,
  }: Props = $props()
</script>

{#if !orgFocusActive && visualization === 'dots' && dotsState.loading}
  <div class="dots-status loading">
    <strong>
      {dotsState.phase === 'fetching' ? 'Henter organisasjoner…' : 'Oppdaterer kart…'}
    </strong>
    <span>{dotsState.message ?? ''}</span>
  </div>
{:else if !orgFocusActive && visualization === 'dots' && dotsState.message}
  <div class="dots-status">
    <span>{dotsState.message}</span>
  </div>
{:else if !orgFocusActive && visualization === 'dots' && webglUnavailable && !webglBannerDismissed}
  <div class="dots-status webgl-banner">
    <strong>WebGL er deaktivert</strong>
    <span>
      Adressevisning kjører i forenklet modus. Aktiver WebGL i nettleseren for full ytelse
      (LibreWolf/Firefox: <code>about:config</code> → <code>webgl.disabled</code> = false), og last siden
      på nytt.
    </span>
    <button type="button" class="banner-dismiss" onclick={onDismissWebglBanner}> Skjul </button>
  </div>
{/if}

<div class="zoom-level-tag" aria-live="polite">
  z{mapZoom} · {currentDetailLevel}
</div>

<div class="attribution">
  {#if orgFocusActive}
    Organisasjon · OpenStreetMap
  {:else if visualization === 'dots'}
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
    {typeof totalVisible === 'number' ? totalVisible.toLocaleString('nb-NO') : '—'} organisasjoner i visningen
  {/if}
</div>

<style>
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
</style>

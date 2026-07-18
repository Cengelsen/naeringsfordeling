<script lang="ts">
  import { onMount } from 'svelte'
  import { orgTypeLabels } from '../utils/orgTypeColors'

  interface Props {
    items: Array<{ kode: string; label: string; color: string }>
  }

  let { items }: Props = $props()

  let open = $state(false)
  let root: HTMLDivElement | undefined

  const sorted = $derived(orgTypeLabels([...items]))

  function closeLegend() {
    open = false
  }

  function toggleLegend() {
    open = !open
  }

  function stopMapEvent(event: Event) {
    event.stopPropagation()
  }

  onMount(() => {
    function onPointerDown(event: PointerEvent) {
      if (!open || !root) return
      const target = event.target
      if (target instanceof Node && !root.contains(target)) {
        closeLegend()
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && open) {
        closeLegend()
      }
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="legend"
  bind:this={root}
  onpointerdown={stopMapEvent}
  onwheel={stopMapEvent}
  ondblclick={stopMapEvent}
>
  {#if open}
    <div class="legend-panel">
      <div class="legend-header">
        <span>Organisasjonstyper</span>
        <button
          type="button"
          class="close-btn"
          aria-label="Skjul fargeforklaring"
          onclick={closeLegend}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <ul>
        {#each sorted as item (item.kode)}
          <li>
            <span class="swatch" style:background={item.color}></span>
            <span class="code">{item.kode}</span>
            <span class="label">{item.label}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <button
    type="button"
    class="legend-toggle"
    aria-label={open ? 'Skjul fargeforklaring' : 'Vis fargeforklaring for organisasjonstyper'}
    aria-expanded={open}
    onclick={toggleLegend}
  >
    {#if open}
      <svg viewBox="0 0 24 24" aria-hidden="true" class="legend-icon" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
      </svg>
    {:else}
      <svg viewBox="0 0 24 24" aria-hidden="true" class="legend-icon" fill="none" stroke="currentColor" stroke-width="1.75">
        <circle cx="7" cy="8" r="2.25" fill="#38bdf8" stroke="none" />
        <circle cx="14" cy="7" r="2.25" fill="#f59e0b" stroke="none" />
        <circle cx="10.5" cy="14.5" r="2.25" fill="#34d399" stroke="none" />
        <circle cx="17" cy="13.5" r="2.25" fill="#a78bfa" stroke="none" />
      </svg>
    {/if}
  </button>
</div>

<style>
  .legend {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
    pointer-events: auto;
  }

  .legend-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 1px solid #1e293b;
    border-radius: 0.45rem;
    background: #0f172a;
    color: #94a3b8;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }

  .legend-toggle:hover,
  .legend-toggle:focus-visible {
    border-color: #334155;
    color: #e2e8f0;
    outline: none;
  }

  .legend-toggle[aria-expanded='true'] {
    border-color: #0369a1;
    color: #7dd3fc;
  }

  .legend-icon {
    width: 1.05rem;
    height: 1.05rem;
  }

  .legend-panel {
    background: #0f172a;
    color: #e2e8f0;
    border: 1px solid #1e293b;
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    min-width: 220px;
    max-width: min(80vw, 280px);
  }

  .legend-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.55rem 0.65rem 0.55rem 0.75rem;
    border-bottom: 1px solid #1e293b;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #94a3b8;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    border: none;
    border-radius: 0.3rem;
    background: transparent;
    color: #94a3b8;
    cursor: pointer;
  }

  .close-btn svg {
    width: 0.9rem;
    height: 0.9rem;
  }

  .close-btn:hover,
  .close-btn:focus-visible {
    color: #e2e8f0;
    background: #1e293b;
    outline: none;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0.5rem 0.75rem;
    max-height: 240px;
    overflow: auto;
  }

  li {
    display: grid;
    grid-template-columns: 12px 2.5rem 1fr;
    gap: 0.45rem;
    align-items: center;
    font-size: 0.78rem;
    padding: 0.2rem 0;
  }

  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .code {
    font-family: ui-monospace, monospace;
    color: #7dd3fc;
  }

  .label {
    color: #cbd5e1;
    line-height: 1.25;
  }
</style>

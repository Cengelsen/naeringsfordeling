<script lang="ts">
  import { orgTypeLabels } from '../utils/orgTypeColors'

  interface Props {
    items: Array<{ kode: string; label: string; color: string }>
  }

  let { items }: Props = $props()

  const sorted = $derived(orgTypeLabels(items))
</script>

<div class="legend">
  <span class="legend-title">Organisasjonstype</span>
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

<style>
  .legend {
    background: rgba(15, 23, 42, 0.92);
    color: #e2e8f0;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    max-height: 280px;
    overflow: auto;
    min-width: 220px;
  }

  .legend-title {
    display: block;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #94a3b8;
    margin-bottom: 0.5rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
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
    border: 1px solid rgba(255, 255, 255, 0.25);
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

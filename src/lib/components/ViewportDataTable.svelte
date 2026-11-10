<script lang="ts">
  import type { ViewportSummary } from '../types'

  interface Props {
    summary: ViewportSummary | null
    visible: boolean
    onToggle: () => void
  }

  let { summary, visible, onToggle }: Props = $props()

  const sortedOrgTypes = $derived(() => {
    if (!summary?.byOrgType) return []
    return Object.entries(summary.byOrgType)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
  })
</script>

<div class="data-table-container">
  <button
    type="button"
    class="toggle-btn"
    aria-expanded={visible}
    aria-controls="viewport-data-table"
    onclick={onToggle}
  >
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      class="table-icon"
    >
      <path d="M3 3h18v18H3z" stroke-linecap="round" />
      <path d="M3 9h18M3 15h18M9 3v18" stroke-linecap="round" />
    </svg>
    <span class="sr-only"
      >{visible ? 'Skjul datatabell' : 'Vis datatabell for synlige organisasjoner'}</span
    >
  </button>

  {#if visible && summary}
    <div
      id="viewport-data-table"
      class="data-panel"
      role="region"
      aria-label="Organisasjoner i synlig kartutsnitt"
    >
      <div class="panel-header">
        <h3>Synlig kartutsnitt</h3>
        <span class="count"
          >{summary.geocodedInBbox?.toLocaleString('nb-NO') ?? 0} organisasjoner</span
        >
      </div>
      <div class="table-wrapper" tabindex="0">
        <table>
          <thead>
            <tr>
              <th scope="col">Organisasjonstype</th>
              <th scope="col" class="num">Antall</th>
            </tr>
          </thead>
          <tbody>
            {#each sortedOrgTypes() as [orgType, count] (orgType)}
              <tr>
                <td>{orgType}</td>
                <td class="num">{count.toLocaleString('nb-NO')}</td>
              </tr>
            {/each}
            {#if sortedOrgTypes().length === 0}
              <tr>
                <td colspan="2" class="empty">Ingen organisasjoner i synlig område</td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

<style>
  .data-table-container {
    pointer-events: auto;
  }

  .toggle-btn {
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

  .toggle-btn:hover,
  .toggle-btn:focus-visible {
    border-color: #334155;
    color: #e2e8f0;
    outline: none;
  }

  .toggle-btn[aria-expanded='true'] {
    border-color: #0369a1;
    color: #7dd3fc;
  }

  .table-icon {
    width: 1.05rem;
    height: 1.05rem;
  }

  .data-panel {
    background: #0f172a;
    color: #e2e8f0;
    border: 1px solid #1e293b;
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    min-width: 240px;
    max-width: min(85vw, 320px);
    margin-top: 0.4rem;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.55rem 0.75rem;
    border-bottom: 1px solid #1e293b;
  }

  .panel-header h3 {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #94a3b8;
  }

  .count {
    font-size: 0.72rem;
    color: #7dd3fc;
    font-weight: 500;
  }

  .table-wrapper {
    max-height: 200px;
    overflow: auto;
  }

  .table-wrapper:focus-visible {
    outline: 2px solid #0369a1;
    outline-offset: -2px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
  }

  thead {
    position: sticky;
    top: 0;
    background: #0f172a;
  }

  th {
    padding: 0.35rem 0.75rem;
    text-align: left;
    font-weight: 600;
    font-size: 0.7rem;
    color: #94a3b8;
    border-bottom: 1px solid #1e293b;
  }

  td {
    padding: 0.25rem 0.75rem;
    border-bottom: 1px solid #0f172a66;
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .empty {
    text-align: center;
    color: #475569;
    font-style: italic;
    padding: 1rem 0.75rem;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>

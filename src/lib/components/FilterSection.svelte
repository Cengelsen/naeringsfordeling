<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    label: string
    items: Array<{ value: string; label: string }>
    selected: string[]
    onToggle: (value: string) => void
    collapsed?: boolean
    children?: Snippet
  }

  let { label, items, selected, onToggle, collapsed, children }: Props = $props()

  const collapsible = collapsed !== undefined
  let isCollapsed = $state(collapsed ?? false)
</script>

<section class="section">
  {#if collapsible}
    <button
      type="button"
      class="section-toggle"
      class:collapsed={isCollapsed}
      onclick={() => (isCollapsed = !isCollapsed)}
    >
      <h2>{label}</h2>
      <span class="toggle-icon">{isCollapsed ? '▸' : '▾'}</span>
    </button>
  {:else}
    <h2>{label}</h2>
  {/if}
  {#if !isCollapsed}
    {#each items as item (item.value)}
      <label class="checkbox">
        <input
          type="checkbox"
          checked={selected.includes(item.value)}
          onchange={() => onToggle(item.value)}
        />
        {item.label}
      </label>
    {/each}
    {#if children}
      {@render children()}
    {/if}
  {/if}
</section>

<style>
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

  .section-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0;
    margin-bottom: 0.75rem;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
  }

  .section-toggle h2 {
    margin: 0;
  }

  .section-toggle.collapsed {
    margin-bottom: 0;
  }

  .toggle-icon {
    font-size: 0.75rem;
    color: #94a3b8;
  }
</style>

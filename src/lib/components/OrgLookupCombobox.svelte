<script lang="ts">
  import type { OrganizationSearchHit } from '../types'
  import { searchOrganizations } from '../services/api'

  interface Props {
    onLocateOrganization: (orgnr: string) => void
  }

  let { onLocateOrganization }: Props = $props()

  let orgLookupQuery = $state('')
  let orgLookupLoading = $state(false)
  let orgLookupError = $state<string | null>(null)
  let orgLookupResults = $state<OrganizationSearchHit[]>([])
  let orgLookupOpen = $state(false)
  let orgLookupActiveIndex = $state(-1)

  const ORG_LOOKUP_DEBOUNCE_MS = 450
  let orgLookupTimer: ReturnType<typeof setTimeout> | undefined
  let orgLookupSeq = 0

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
      aria-activedescendant={orgLookupActiveIndex >= 0
        ? `org-option-${orgLookupActiveIndex}`
        : undefined}
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
              id={`org-option-${index}`}
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

  .hint {
    margin: -0.35rem 0 0.65rem;
    font-size: 0.8rem;
    color: #94a3b8;
  }

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

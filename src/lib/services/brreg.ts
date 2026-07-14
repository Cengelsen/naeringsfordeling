import type { Kommune, MapFilters, MunicipalityCount, Organisasjonsform } from '../types'

const API_BASE = 'https://data.brreg.no/enhetsregisteret/api'
const BATCH_SIZE = 8
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

interface BrregPage {
  totalElements: number
}

interface CacheEntry {
  timestamp: number
  counts: Record<string, number>
}

const memoryCache = new Map<string, CacheEntry>()

function cacheKey(filters: MapFilters): string {
  return JSON.stringify({
    orgTypes: [...filters.orgTypes].sort(),
    excludeKonkurs: filters.excludeKonkurs,
    excludeUnderAvvikling: filters.excludeUnderAvvikling,
    vatRegisteredOnly: filters.vatRegisteredOnly,
  })
}

function loadCache(key: string): Record<string, number> | null {
  const memory = memoryCache.get(key)
  if (memory && Date.now() - memory.timestamp < CACHE_TTL_MS) {
    return memory.counts
  }

  try {
    const raw = localStorage.getItem(`brreg-counts:${key}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheEntry
    if (Date.now() - parsed.timestamp >= CACHE_TTL_MS) return null
    memoryCache.set(key, parsed)
    return parsed.counts
  } catch {
    return null
  }
}

function saveCache(key: string, counts: Record<string, number>) {
  const entry: CacheEntry = { timestamp: Date.now(), counts }
  memoryCache.set(key, entry)
  try {
    localStorage.setItem(`brreg-counts:${key}`, JSON.stringify(entry))
  } catch {
    // Storage full or unavailable — memory cache still works.
  }
}

async function brregFetch<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`BRREG API feilet (${response.status})`)
  }
  return response.json() as Promise<T>
}

export async function fetchOrganisasjonsformer(): Promise<Organisasjonsform[]> {
  const data = await brregFetch<{
    _embedded: { organisasjonsformer: Organisasjonsform[] }
  }>('/organisasjonsformer/enheter')
  return data._embedded.organisasjonsformer.sort((a, b) =>
    a.beskrivelse.localeCompare(b.beskrivelse, 'nb'),
  )
}

export async function fetchKommuner(): Promise<Kommune[]> {
  const kommuner: Kommune[] = []
  let page = 0
  let totalPages = 1

  while (page < totalPages) {
    const data = await brregFetch<{
      _embedded: { kommuner: Kommune[] }
      page: { totalPages: number }
    }>(`/kommuner?size=100&page=${page}`)
    kommuner.push(...data._embedded.kommuner)
    totalPages = data.page.totalPages
    page += 1
  }

  return kommuner
    .filter((k) => k.nummer !== '0999')
    .sort((a, b) => a.navn.localeCompare(b.navn, 'nb'))
}

function buildQuery(kommunenummer: string, filters: MapFilters): string {
  const params = new URLSearchParams({
    kommunenummer,
    size: '1',
  })

  if (filters.orgTypes.length > 0) {
    params.set('organisasjonsform', filters.orgTypes.join(','))
  }
  if (filters.excludeKonkurs) params.set('konkurs', 'false')
  if (filters.excludeUnderAvvikling) params.set('underAvvikling', 'false')
  if (filters.vatRegisteredOnly) params.set('registrertIMvaregisteret', 'true')

  return `/enheter?${params.toString()}`
}

async function fetchMunicipalityCount(
  kommunenummer: string,
  filters: MapFilters,
): Promise<number> {
  const data = await brregFetch<{ page: BrregPage }>(buildQuery(kommunenummer, filters))
  return data.page.totalElements
}

async function runBatched<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
    onProgress?.(Math.min(i + batchSize, items.length), items.length)
  }
  return results
}

export async function fetchMunicipalityCounts(
  kommunenumre: string[],
  filters: MapFilters,
  onProgress?: (done: number, total: number) => void,
  forceRefresh = false,
): Promise<MunicipalityCount[]> {
  const key = cacheKey(filters)
  if (!forceRefresh) {
    const cached = loadCache(key)
    if (cached) {
      onProgress?.(kommunenumre.length, kommunenumre.length)
      return kommunenumre.map((kommunenummer) => ({
        kommunenummer,
        count: cached[kommunenummer] ?? 0,
      }))
    }
  }

  const counts: Record<string, number> = {}
  await runBatched(
    kommunenumre,
    BATCH_SIZE,
    async (kommunenummer) => {
      counts[kommunenummer] = await fetchMunicipalityCount(kommunenummer, filters)
    },
    onProgress,
  )

  saveCache(key, counts)

  return kommunenumre.map((kommunenummer) => ({
    kommunenummer,
    count: counts[kommunenummer] ?? 0,
  }))
}

export function filtersSummary(filters: MapFilters, orgFormLabels: Map<string, string>): string {
  const parts: string[] = []
  if (filters.orgTypes.length === 0) {
    parts.push('Alle organisasjonsformer')
  } else {
    parts.push(
      filters.orgTypes.map((k) => orgFormLabels.get(k) ?? k).join(', '),
    )
  }
  if (filters.excludeKonkurs) parts.push('ekskl. konkurs')
  if (filters.excludeUnderAvvikling) parts.push('ekskl. under avvikling')
  if (filters.vatRegisteredOnly) parts.push('kun MVA-registrerte')
  return parts.join(' · ')
}

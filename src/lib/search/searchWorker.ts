/**
 * Web Worker for shard-based search.
 * Receives messages { type: 'search', id, query, limit, baseUrl }
 * Responds with { type: 'result', id, results }
 */

type CompactSearchEntry = [string, string, string, string] // [orgnr, navn, org_type, kommunenummer]

interface SearchRequest {
  type: 'search'
  id: number
  query: string
  limit: number
  baseUrl: string
}

interface SearchResult {
  type: 'result'
  id: number
  results: Array<{
    orgnr: string
    navn: string
    orgType: string
    kommunenummer: string
  }>
}

const LRU_MAX = 64
const shardCache = new Map<string, CompactSearchEntry[]>()

function evictLru() {
  while (shardCache.size > LRU_MAX) {
    const oldest = shardCache.keys().next().value
    if (oldest == null) break
    shardCache.delete(oldest)
  }
}

function searchPrefix(query: string): string {
  const normalized = query.toLowerCase().replace(/[^a-zæøå0-9]/g, '')
  return normalized.slice(0, 2) || '__'
}

async function fetchShard(baseUrl: string, prefix: string): Promise<CompactSearchEntry[]> {
  const key = `${baseUrl}/${prefix}`
  const cached = shardCache.get(key)
  if (cached) {
    shardCache.delete(key)
    shardCache.set(key, cached)
    return cached
  }

  try {
    const response = await fetch(`${baseUrl}/search/${prefix}.json.gz`)
    if (!response.ok) return []
    const data = (await response.json()) as CompactSearchEntry[]
    shardCache.set(key, data)
    evictLru()
    return data
  } catch {
    return []
  }
}

function matchEntries(
  entries: CompactSearchEntry[],
  query: string,
  limit: number,
): SearchResult['results'] {
  const lowerQuery = query.toLowerCase()
  const results: SearchResult['results'] = []

  const orgnrMatch = /^\d{9}$/.test(query)

  for (const [orgnr, navn, orgType, kommunenummer] of entries) {
    if (orgnrMatch) {
      if (orgnr === query) {
        results.push({ orgnr, navn, orgType, kommunenummer })
      }
    } else if (navn.toLowerCase().includes(lowerQuery)) {
      results.push({ orgnr, navn, orgType, kommunenummer })
    }
    if (results.length >= limit) break
  }

  return results
}

self.onmessage = async (event: MessageEvent<SearchRequest>) => {
  const { type, id, query, limit, baseUrl } = event.data
  if (type !== 'search') return

  const prefix = searchPrefix(query)
  const entries = await fetchShard(baseUrl, prefix)
  const results = matchEntries(entries, query, limit)

  const response: SearchResult = { type: 'result', id, results }
  self.postMessage(response)
}

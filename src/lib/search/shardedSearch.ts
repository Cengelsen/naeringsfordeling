import type { OrganizationSearchHit } from '../types'
import { assetUrl } from '../utils/assets'

const STATIC_API_BASE = assetUrl('data/api')

interface WorkerSearchResult {
  type: 'result'
  id: number
  results: Array<{
    orgnr: string
    navn: string
    orgType: string
    kommunenummer: string
  }>
}

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, (results: OrganizationSearchHit[]) => void>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerSearchResult>) => {
      const { id, results } = event.data
      const resolve = pending.get(id)
      if (resolve) {
        pending.delete(id)
        resolve(
          results.map((r) => ({
            orgnr: r.orgnr,
            navn: r.navn,
            orgType: r.orgType,
            orgTypeLabel: '',
            kommunenummer: r.kommunenummer,
            lat: null,
            lng: null,
          })),
        )
      }
    }
  }
  return worker
}

export function searchSharded(query: string, limit = 8): Promise<OrganizationSearchHit[]> {
  return new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    getWorker().postMessage({
      type: 'search',
      id,
      query,
      limit,
      baseUrl: STATIC_API_BASE,
    })
  })
}

const DETAIL_SHARD_COUNT = 2048

interface DetailShardEntry {
  orgnr: string
  navn: string
  org_type: string
  org_type_label: string
  address_text: string
  postnummer: string
  kommunenummer: string
  antall_ansatte: number | null
  naeringskode: string
  naeringskode_label: string
  entity_kind: string
  flags: number
}

type CompactOrgDetail = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number | null,
  string,
  string,
  string,
  number,
]

const detailShardCache = new Map<number, CompactOrgDetail[]>()

function mapDetailEntry(entry: CompactOrgDetail): DetailShardEntry {
  return {
    orgnr: entry[0],
    navn: entry[1],
    org_type: entry[2],
    org_type_label: entry[3],
    address_text: entry[4],
    postnummer: entry[5],
    kommunenummer: entry[6],
    antall_ansatte: entry[7],
    naeringskode: entry[8],
    naeringskode_label: entry[9],
    entity_kind: entry[10],
    flags: entry[11],
  }
}

async function fetchDetailShard(shardId: number): Promise<CompactOrgDetail[]> {
  const cached = detailShardCache.get(shardId)
  if (cached) return cached

  try {
    const response = await fetch(`${STATIC_API_BASE}/detail/${shardId}.json.gz`)
    if (!response.ok) return []
    const data = (await response.json()) as CompactOrgDetail[]
    detailShardCache.set(shardId, data)
    while (detailShardCache.size > 128) {
      const oldest = detailShardCache.keys().next().value
      if (oldest == null) break
      detailShardCache.delete(oldest)
    }
    return data
  } catch {
    return []
  }
}

export async function fetchOrganizationFromShard(orgnr: string): Promise<DetailShardEntry | null> {
  const orgnrNum = parseInt(orgnr, 10)
  if (isNaN(orgnrNum)) return null
  const shardId = orgnrNum % DETAIL_SHARD_COUNT
  const entries = await fetchDetailShard(shardId)
  for (const entry of entries) {
    if (entry[0] === orgnr) return mapDetailEntry(entry)
  }
  return null
}

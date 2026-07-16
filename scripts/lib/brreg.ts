import type { BrregEntity, BrregUpdate } from './types.js'
import { LIMITS, fetchWithRetry, sleep } from './rate-limit.js'

const API_BASE = 'https://data.brreg.no/enhetsregisteret/api'
const UPDATE_PAGE_SIZE = 1000
const ENTITY_PAGE_SIZE = 1000
const BRREG_MAX_OFFSET = 10_000
const POSTNUMMER_BATCH_SIZE = 50

type EntitySearchParams = Record<string, string>

function maxAccessiblePage(size: number): number {
  return Math.floor(BRREG_MAX_OFFSET / size) - 1
}

function entitySearchQuery(params: EntitySearchParams, page = 0): string {
  const query = new URLSearchParams({ ...params, size: String(ENTITY_PAGE_SIZE), page: String(page) })
  return `/enheter?${query.toString()}`
}

function countSearchQuery(params: EntitySearchParams): string {
  const query = new URLSearchParams({ ...params, size: '1' })
  return `/enheter?${query.toString()}`
}

let organisasjonsformerCache: string[] | null = null

async function fetchOrganisasjonsformer(): Promise<string[]> {
  if (organisasjonsformerCache) return organisasjonsformerCache

  const data = await brregFetch<{
    _embedded?: { organisasjonsformer: Array<{ kode: string }> }
  }>('/organisasjonsformer?size=200')

  organisasjonsformerCache = data._embedded?.organisasjonsformer.map((form) => form.kode) ?? []
  return organisasjonsformerCache
}

function postnummerBatches(): string[][] {
  const batches: string[][] = []
  for (let start = 0; start < 10_000; start += POSTNUMMER_BATCH_SIZE) {
    const batch: string[] = []
    for (let value = start; value < start + POSTNUMMER_BATCH_SIZE; value += 1) {
      batch.push(String(value).padStart(4, '0'))
    }
    batches.push(batch)
  }
  return batches
}

async function countEntitySearch(params: EntitySearchParams): Promise<number> {
  const data = await brregFetch<{ page: { totalElements: number } }>(countSearchQuery(params))
  return data.page.totalElements
}

async function paginateEntitySearch(
  params: EntitySearchParams,
  onEntity: (entity: BrregEntity) => void | Promise<void>,
): Promise<number> {
  let page = 0
  let totalPages = 1
  let count = 0
  const pageLimit = maxAccessiblePage(ENTITY_PAGE_SIZE)

  while (page < totalPages) {
    const data = await brregFetch<{
      _embedded?: { enheter: BrregEntity[] }
      page: { totalPages: number }
    }>(entitySearchQuery(params, page))

    const batch = data._embedded?.enheter ?? []
    if (batch.length === 0) break

    for (const entity of batch) {
      await onEntity(entity)
      count += 1
    }

    totalPages = data.page.totalPages

    if (page >= pageLimit && page < totalPages - 1) {
      throw new Error(
        `BRREG-søk overskred pagineringsgrensen (${JSON.stringify(params)}). Prøv et smalere filter.`,
      )
    }

    page += 1
    if (page < totalPages) await sleep(LIMITS.brregPageDelayMs)
  }

  return count
}

async function fetchEntitySearchSlice(
  params: EntitySearchParams,
  onEntity: (entity: BrregEntity) => void | Promise<void>,
): Promise<number> {
  const total = await countEntitySearch(params)
  if (total === 0) return 0

  if (total <= BRREG_MAX_OFFSET) {
    return paginateEntitySearch(params, onEntity)
  }

  if (!params.organisasjonsform) {
    const forms = await fetchOrganisasjonsformer()
    let count = 0
    for (const form of forms) {
      count += await fetchEntitySearchSlice({ ...params, organisasjonsform: form }, onEntity)
    }
    return count
  }

  if (!params['forretningsadresse.postnummer']) {
    let count = 0
    for (const postnummers of postnummerBatches()) {
      count += await fetchEntitySearchSlice(
        { ...params, 'forretningsadresse.postnummer': postnummers.join(',') },
        onEntity,
      )
    }
    return count
  }

  if (params['forretningsadresse.postnummer'].includes(',')) {
    let count = 0
    for (const postnummer of params['forretningsadresse.postnummer'].split(',')) {
      count += await fetchEntitySearchSlice(
        { ...params, 'forretningsadresse.postnummer': postnummer },
        onEntity,
      )
    }
    return count
  }

  throw new Error(
    `BRREG-søk har ${total.toLocaleString('nb-NO')} treff for ${JSON.stringify(params)}, over grensen ${BRREG_MAX_OFFSET.toLocaleString('nb-NO')}.`,
  )
}

async function brregFetch<T>(path: string): Promise<T> {
  const response = await fetchWithRetry(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json' },
  }, `BRREG ${path}`)

  if (!response.ok) {
    throw new Error(`BRREG API feilet (${response.status}) for ${path}`)
  }

  return response.json() as Promise<T>
}

export async function fetchEntity(orgnr: string): Promise<BrregEntity | null> {
  const response = await fetchWithRetry(
    `${API_BASE}/enheter/${orgnr}`,
    { headers: { Accept: 'application/json' } },
    `BRREG enhet ${orgnr}`,
  )

  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`BRREG enhet ${orgnr} feilet (${response.status})`)
  }

  return response.json() as Promise<BrregEntity>
}

export async function fetchKommuneEntities(
  kommunenummer: string,
  onEntity: (entity: BrregEntity) => void | Promise<void>,
): Promise<number> {
  const total = await countEntitySearch({ kommunenummer })
  if (total === 0) return 0

  if (total > BRREG_MAX_OFFSET) {
    console.log(
      `  Kommune ${kommunenummer}: ${total.toLocaleString('nb-NO')} enheter – deler opp søk (BRREG-grense ${BRREG_MAX_OFFSET.toLocaleString('nb-NO')})…`,
    )
  }

  return fetchEntitySearchSlice({ kommunenummer }, onEntity)
}

export async function fetchAllKommuner(): Promise<Array<{ nummer: string; navn: string }>> {
  const data = await brregFetch<{
    _embedded?: { kommuner: Array<{ nummer: string; navn: string }> }
  }>('/kommuner?size=500')

  return data._embedded?.kommuner ?? []
}

export async function fetchKommunerForFylke(fylke: string): Promise<string[]> {
  const fylkeCode = fylke.padStart(2, '0').slice(0, 2)
  const kommuner = await fetchAllKommuner()

  return kommuner
    .filter((kommune) => kommune.nummer.slice(0, 2) === fylkeCode)
    .map((kommune) => kommune.nummer)
}

export async function fetchLatestUpdateId(): Promise<number> {
  const pageLimit = maxAccessiblePage(UPDATE_PAGE_SIZE)

  for (let daysAgo = 0; daysAgo < 7; daysAgo += 1) {
    const date = new Date()
    date.setUTCHours(0, 0, 0, 0)
    date.setUTCDate(date.getUTCDate() - daysAgo)
    const dato = date.toISOString()

    const head = await brregFetch<{
      _embedded?: { oppdaterteEnheter: BrregUpdate[] }
      page: { totalPages: number }
    }>(`/oppdateringer/enheter?dato=${encodeURIComponent(dato)}&size=${UPDATE_PAGE_SIZE}`)

    if (head.page.totalPages === 0) continue

    const targetPage = Math.min(head.page.totalPages - 1, pageLimit)
    const tail = await brregFetch<{
      _embedded?: { oppdaterteEnheter: BrregUpdate[] }
    }>(`/oppdateringer/enheter?dato=${encodeURIComponent(dato)}&size=${UPDATE_PAGE_SIZE}&page=${targetPage}`)

    const batch = tail._embedded?.oppdaterteEnheter ?? []
    const latest = batch.at(-1)
    if (!latest) continue

    if (head.page.totalPages - 1 > pageLimit) {
      const { maxId } = await fetchUpdatesSince(latest.oppdateringsid)
      return maxId
    }

    return latest.oppdateringsid
  }

  return 0
}

export async function fetchUpdatesSince(
  oppdateringsid: number,
  onBatch?: (updates: BrregUpdate[]) => void,
): Promise<{ updates: BrregUpdate[]; maxId: number }> {
  const updates: BrregUpdate[] = []
  let cursor = oppdateringsid
  let maxId = oppdateringsid
  let page = 0
  let totalPages = 1
  const pageLimit = maxAccessiblePage(UPDATE_PAGE_SIZE)

  while (true) {
    const data = await brregFetch<{
      _embedded?: { oppdaterteEnheter: BrregUpdate[] }
      page: { totalPages: number; number: number }
    }>(`/oppdateringer/enheter?oppdateringsid=${cursor}&size=${UPDATE_PAGE_SIZE}&page=${page}`)

    const batch = data._embedded?.oppdaterteEnheter ?? []
    if (batch.length === 0) break

    updates.push(...batch)
    onBatch?.(batch)

    for (const update of batch) {
      if (update.oppdateringsid > maxId) maxId = update.oppdateringsid
    }

    totalPages = data.page.totalPages

    if (batch.length < UPDATE_PAGE_SIZE) break

    if (page >= pageLimit && page < totalPages - 1) {
      cursor = batch[batch.length - 1].oppdateringsid
      page = 0
      totalPages = 1
      await sleep(LIMITS.brregPageDelayMs)
      continue
    }

    page += 1
    if (page < totalPages) await sleep(LIMITS.brregPageDelayMs)
    else break
  }

  return { updates, maxId }
}

export async function downloadBulkEntities(onEntity: (entity: BrregEntity) => Promise<void> | void) {
  const response = await fetchWithRetry(
    `${API_BASE}/enheter/lastned`,
    { headers: { Accept: 'application/vnd.brreg.enhetsregisteret.enhet.v2+gzip;charset=UTF-8' } },
    'BRREG bulk lastned',
  )

  if (!response.ok || !response.body) {
    throw new Error(`BRREG bulk download feilet (${response.status})`)
  }

  const { chain } = await import('stream-chain')
  const { parser } = await import('stream-json')
  const { streamArray } = await import('stream-json/streamers/stream-array.js')
  const { createGunzip } = await import('node:zlib')
  const { Readable } = await import('node:stream')

  const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)

  const pipeline = chain([
    nodeStream,
    createGunzip(),
    parser(),
    streamArray(),
  ])

  let count = 0
  for await (const chunk of pipeline) {
    const entity = (chunk as { value: BrregEntity }).value
    await onEntity(entity)
    count += 1
    if (count % 10000 === 0) {
      console.log(`  Importert ${count.toLocaleString('nb-NO')} enheter…`)
    }
  }

  return count
}

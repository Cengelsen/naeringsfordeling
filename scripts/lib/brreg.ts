import type { BrregEntity, BrregUpdate } from './types.js'
import { LIMITS, fetchWithRetry, sleep } from './rate-limit.js'

const API_BASE = 'https://data.brreg.no/enhetsregisteret/api'

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
  let page = 0
  let totalPages = 1
  let count = 0

  while (page < totalPages) {
    const data = await brregFetch<{
      _embedded?: { enheter: BrregEntity[] }
      page: { totalPages: number }
    }>(`/enheter?kommunenummer=${kommunenummer}&size=100&page=${page}`)

    const batch = data._embedded?.enheter ?? []
    totalPages = data.page.totalPages

    for (const entity of batch) {
      await onEntity(entity)
      count += 1
    }

    page += 1
    if (page < totalPages) await sleep(LIMITS.brregPageDelayMs)
  }

  return count
}

export async function fetchLatestUpdateId(): Promise<number> {
  for (let daysAgo = 0; daysAgo < 7; daysAgo += 1) {
    const date = new Date()
    date.setUTCHours(0, 0, 0, 0)
    date.setUTCDate(date.getUTCDate() - daysAgo)
    const dato = date.toISOString()

    const head = await brregFetch<{
      _embedded?: { oppdaterteEnheter: BrregUpdate[] }
      page: { totalPages: number }
    }>(`/oppdateringer/enheter?dato=${encodeURIComponent(dato)}&size=1000`)

    if (head.page.totalPages === 0) continue

    const lastPage = head.page.totalPages - 1
    const tail = await brregFetch<{
      _embedded?: { oppdaterteEnheter: BrregUpdate[] }
    }>(`/oppdateringer/enheter?dato=${encodeURIComponent(dato)}&size=1000&page=${lastPage}`)

    const batch = tail._embedded?.oppdaterteEnheter ?? []
    const latest = batch.at(-1)
    if (latest) return latest.oppdateringsid
  }

  return 0
}

export async function fetchUpdatesSince(
  oppdateringsid: number,
  onBatch?: (updates: BrregUpdate[]) => void,
): Promise<{ updates: BrregUpdate[]; maxId: number }> {
  const updates: BrregUpdate[] = []
  let maxId = oppdateringsid
  let page = 0
  let totalPages = 1

  while (page < totalPages) {
    const data = await brregFetch<{
      _embedded?: { oppdaterteEnheter: BrregUpdate[] }
      page: { totalPages: number; number: number }
    }>(`/oppdateringer/enheter?oppdateringsid=${oppdateringsid}&size=1000&page=${page}`)

    const batch = data._embedded?.oppdaterteEnheter ?? []
    if (batch.length === 0) break

    updates.push(...batch)
    onBatch?.(batch)

    for (const update of batch) {
      if (update.oppdateringsid > maxId) maxId = update.oppdateringsid
    }

    totalPages = data.page.totalPages
    page += 1

    if (batch.length < 1000) break
    if (page < totalPages) await sleep(LIMITS.brregPageDelayMs)
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

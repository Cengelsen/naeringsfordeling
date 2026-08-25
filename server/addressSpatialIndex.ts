import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { addressGroupKeySql } from '../shared/address-groups.js'
import { appendAreaFilters, buildFilterQuery, rtreeBboxParams, type ApiFilters } from './filters.js'
import type { SpatialWorkerInbound, SpatialWorkerOutbound } from './addressSpatialCore.js'

export { filterFingerprint, DEFAULT_SPATIAL_FILTERS } from './addressSpatialCore.js'

export interface ViewportSpatialCount {
  addressesInBbox: number
  geocodedInBbox: number
  byOrgType: Record<string, number>
}

const workerPath = fileURLToPath(new URL('./addressSpatialWorker-bootstrap.mjs', import.meta.url))

let worker: Worker | null = null
let workerReady = false
let nextRequestId = 1
const pending = new Map<
  number,
  {
    resolve: (value: ViewportSpatialCount | null) => void
    reject: (error: Error) => void
  }
>()

function handleWorkerMessage(message: SpatialWorkerOutbound) {
  if (message.type === 'ready') {
    workerReady = true
    console.log(
      `Address spatial index ready: ${message.addressCount.toLocaleString('nb-NO')} addresses (${message.ms} ms)`,
    )
    return
  }

  if (message.type === 'error') {
    if (message.id != null) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      waiter?.reject(new Error(message.message))
    } else {
      console.error('Address spatial worker error', message.message)
    }
    return
  }

  if (message.type !== 'countResult') return
  const waiter = pending.get(message.id)
  pending.delete(message.id)
  if (!waiter) return
  if (!message.hit) {
    waiter.resolve(null)
    return
  }
  waiter.resolve({
    addressesInBbox: message.addressesInBbox,
    geocodedInBbox: message.geocodedInBbox,
    byOrgType: {},
  })
}

export function startAddressSpatialWorker(dbPath: string) {
  if (worker) return
  worker = new Worker(workerPath, { workerData: { dbPath } })
  worker.on('message', handleWorkerMessage)
  worker.on('error', (error) => {
    console.error('Address spatial worker failed', error)
    workerReady = false
    for (const [id, waiter] of pending) {
      waiter.reject(error)
      pending.delete(id)
    }
  })
  worker.on('exit', (code) => {
    workerReady = false
    worker = null
    if (code !== 0) {
      console.error(`Address spatial worker exited with code ${code}`)
    }
  })
}

export async function terminateAddressSpatialWorker() {
  const current = worker
  worker = null
  workerReady = false
  for (const waiter of pending.values()) {
    waiter.resolve(null)
  }
  pending.clear()
  if (current) await current.terminate()
}

function countFromWorker(
  filters: ApiFilters,
  bbox: [number, number, number, number],
): Promise<ViewportSpatialCount | null> {
  if (!worker || !workerReady) return Promise.resolve(null)

  const id = nextRequestId
  nextRequestId += 1
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const message: SpatialWorkerInbound = { type: 'count', id, filters, bbox }
    worker!.postMessage(message)
  })
}

function prefetchWorkerFilters(filters: ApiFilters) {
  if (!worker || !workerReady) return
  const message: SpatialWorkerInbound = { type: 'prefetch', filters }
  worker.postMessage(message)
}

export function countViewportSpatialSql(
  db: Database.Database,
  filters: ApiFilters,
  bbox: [number, number, number, number],
): ViewportSpatialCount {
  const { conditions, params } = buildFilterQuery(filters, true, 'o')
  appendAreaFilters(filters, conditions, params, 'o')
  const [minLng, maxLng, minLat, maxLat] = rtreeBboxParams(bbox)
  const where = conditions.join(' AND ')
  const rtree = `r.maxLng >= ? AND r.minLng <= ? AND r.maxLat >= ? AND r.minLat <= ?`

  const geocoded = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM organizations o
       INNER JOIN orgs_rtree r ON r.id = o.rowid
       WHERE ${rtree} AND ${where}`,
    )
    .get(minLng, maxLng, minLat, maxLat, ...params) as { count: number }

  const addresses = db
    .prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT 1
         FROM organizations o
         INNER JOIN orgs_rtree r ON r.id = o.rowid
         WHERE ${rtree} AND ${where}
         GROUP BY ${addressGroupKeySql('o')}
       )`,
    )
    .get(minLng, maxLng, minLat, maxLat, ...params) as { count: number }

  return {
    addressesInBbox: addresses.count,
    geocodedInBbox: geocoded.count,
    byOrgType: {},
  }
}

export async function countViewportSpatial(
  db: Database.Database,
  filters: ApiFilters,
  bbox: [number, number, number, number],
): Promise<ViewportSpatialCount> {
  try {
    const fromWorker = await countFromWorker(filters, bbox)
    if (fromWorker) return fromWorker
  } catch (error) {
    console.error('Address spatial worker count failed', error)
  }

  prefetchWorkerFilters(filters)
  return countViewportSpatialSql(db, filters, bbox)
}

/** @deprecated Use startAddressSpatialWorker. Kept for tests that build indexes in-process. */
export function warmAddressSpatialIndex(_db: Database.Database) {
  // Warming happens in the worker thread.
}

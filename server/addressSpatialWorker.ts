import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import {
  DEFAULT_SPATIAL_FILTERS,
  INDEX_CACHE_MAX,
  buildIndexes,
  filterFingerprint,
  loadAllGeocodedRows,
  type BuiltIndexes,
  type SpatialWorkerInbound,
  type SpatialWorkerOutbound,
} from './addressSpatialCore.js'

const dbPath = (workerData as { dbPath?: string } | undefined)?.dbPath
if (!dbPath || !parentPort) {
  throw new Error('Address spatial worker requires dbPath and parentPort')
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
db.pragma('query_only = ON')

const indexCache = new Map<string, BuiltIndexes>()
const allRows = loadAllGeocodedRows(db)

function cacheIndexes(filters: Parameters<typeof filterFingerprint>[0]): BuiltIndexes {
  const key = filterFingerprint(filters)
  const cached = indexCache.get(key)
  if (cached) {
    indexCache.delete(key)
    indexCache.set(key, cached)
    return cached
  }
  const built = buildIndexes(allRows, filters)
  indexCache.set(key, built)
  while (indexCache.size > INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next().value
    if (oldest == null) break
    indexCache.delete(oldest)
  }
  return built
}

function getCached(filters: Parameters<typeof filterFingerprint>[0]): BuiltIndexes | null {
  const key = filterFingerprint(filters)
  const cached = indexCache.get(key)
  if (!cached) return null
  indexCache.delete(key)
  indexCache.set(key, cached)
  return cached
}

function post(message: SpatialWorkerOutbound) {
  parentPort!.postMessage(message)
}

const started = performance.now()
const warmed = cacheIndexes(DEFAULT_SPATIAL_FILTERS)
post({
  type: 'ready',
  addressCount: warmed.addresses.size,
  ms: Math.round(performance.now() - started),
})

parentPort.on('message', (message: SpatialWorkerInbound) => {
  try {
    if (message.type === 'prefetch') {
      cacheIndexes(message.filters)
      return
    }
    if (message.type !== 'count') return

    const indexes = getCached(message.filters)
    if (!indexes) {
      post({ type: 'countResult', id: message.id, hit: false })
      return
    }

    const [minLng, minLat, maxLng, maxLat] = message.bbox
    post({
      type: 'countResult',
      id: message.id,
      hit: true,
      addressesInBbox: indexes.addresses.countBbox(minLng, minLat, maxLng, maxLat),
      geocodedInBbox: indexes.organizations.countBbox(minLng, minLat, maxLng, maxLat),
    })
  } catch (error) {
    post({
      type: 'error',
      id: 'id' in message ? message.id : undefined,
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

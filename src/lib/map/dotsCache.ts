import type { OrganizationPoint } from '../types'

export interface DotsCacheEntry {
  points: OrganizationPoint[]
  truncated: boolean
  savedAt: number
}

const DB_NAME = 'naeringsfordeling-dots'
const STORE_NAME = 'points'
const DB_VERSION = 1
const MAX_MEMORY_ENTRIES = 30
const IDB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

class DotsCache {
  private memory = new Map<string, DotsCacheEntry>()
  private order: string[] = []
  private dbPromise: Promise<IDBDatabase | null> | null = null

  private openDb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null)
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME)
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
      })
    }
    return this.dbPromise
  }

  getMemory(key: string): DotsCacheEntry | null {
    return this.memory.get(key) ?? null
  }

  setMemory(key: string, entry: DotsCacheEntry) {
    if (this.memory.has(key)) {
      this.order = this.order.filter((item) => item !== key)
    }

    this.memory.set(key, entry)
    this.order.push(key)

    while (this.order.length > MAX_MEMORY_ENTRIES) {
      const oldest = this.order.shift()
      if (oldest) this.memory.delete(oldest)
    }
  }

  async get(key: string): Promise<DotsCacheEntry | null> {
    const cached = this.getMemory(key)
    if (cached) return cached

    const db = await this.openDb()
    if (!db) return null

    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(key)

      request.onsuccess = () => {
        const entry = request.result as DotsCacheEntry | undefined
        if (!entry || Date.now() - entry.savedAt > IDB_MAX_AGE_MS) {
          resolve(null)
          return
        }
        this.setMemory(key, entry)
        resolve(entry)
      }
      request.onerror = () => resolve(null)
    })
  }

  async set(key: string, entry: DotsCacheEntry) {
    this.setMemory(key, entry)

    const db = await this.openDb()
    if (!db) return

    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(entry, key)
  }

  clear() {
    this.memory.clear()
    this.order = []
  }
}

export const dotsCache = new DotsCache()

export function dotsCacheKey(parts: {
  bbox?: [number, number, number, number]
  kommunenumre: string[]
  filters: string
  zoom: number
}): string {
  const bbox = parts.bbox?.map((value) => value.toFixed(4)).join(',') ?? ''
  const kommuner = [...parts.kommunenumre].sort().join(',')
  return `${bbox}|${kommuner}|z${parts.zoom}|${parts.filters}`
}

export function expandBbox(
  bbox: [number, number, number, number],
  factor = 0.25,
): [number, number, number, number] {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const lngPad = (maxLng - minLng) * factor
  const latPad = (maxLat - minLat) * factor
  return [minLng - lngPad, minLat - latPad, maxLng + lngPad, maxLat + latPad]
}

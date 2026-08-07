import type Database from 'better-sqlite3'
import type { BrregAddress } from './types.js'
import { geocodeAddress, type GeocodeResult } from './geocode.js'
import {
  DEFAULT_KARTVERKET_CACHE_DIR,
  findCachedKartverketZip,
  importKartverketFromCache,
  kartverketBulkAvailable,
  kartverketAddressCount,
} from './kartverket-bulk.js'
import { lookupKartverketAddress } from './local-geocode.js'

let localReadyChecked = false

export interface GeocodeResolveOptions {
  /** When false, never call Kartverket Adresse-API (build commands). Default true for sync/server. */
  allowApi?: boolean
  kartverketCacheDir?: string
}

/** Load Kartverket bulk from cached zip into DB if not already present. */
export async function ensureLocalKartverketReady(
  db: Database.Database,
  kartverketCacheDir = DEFAULT_KARTVERKET_CACHE_DIR,
): Promise<boolean> {
  if (kartverketBulkAvailable(db)) {
    return true
  }

  const zipPath = findCachedKartverketZip(kartverketCacheDir)
  if (!zipPath) {
    return false
  }

  if (!localReadyChecked) {
    console.log(`Fant lokal Kartverket-fil: ${zipPath}`)
    console.log('Importerer adresser til databasen (engangssteg)…')
  }

  await importKartverketFromCache(db, kartverketCacheDir)
  localReadyChecked = true
  return kartverketBulkAvailable(db)
}

export function geocodeSourceDescription(
  db: Database.Database,
  options: Pick<GeocodeResolveOptions, 'allowApi' | 'kartverketCacheDir'> = {},
): string {
  const allowApi = options.allowApi ?? false
  const cacheDir = options.kartverketCacheDir ?? DEFAULT_KARTVERKET_CACHE_DIR

  if (kartverketBulkAvailable(db)) {
    return `lokal Kartverket-database (${kartverketAddressCount(db).toLocaleString('nb-NO')} adresser)`
  }
  if (findCachedKartverketZip(cacheDir)) {
    return allowApi
      ? 'lokal Kartverket-fil (importeres ved geokoding, deretter API ved miss)'
      : 'lokal Kartverket-fil (importeres ved geokoding, ingen API)'
  }
  return allowApi ? 'Kartverket Adresse-API' : 'ingen lokal Kartverket-data (geokoding hoppes over)'
}

/** Geocode via local bulk register when available; API only when bulk is missing and explicitly allowed. */
export async function geocodeAddressResolved(
  db: Database.Database,
  address: BrregAddress,
  line: string,
  options: GeocodeResolveOptions = {},
): Promise<GeocodeResult | null> {
  if (!address.postnummer) return null
  if (address.landkode && address.landkode !== 'NO') return null

  const allowApi = options.allowApi ?? false
  const cacheDir = options.kartverketCacheDir ?? DEFAULT_KARTVERKET_CACHE_DIR

  await ensureLocalKartverketReady(db, cacheDir)

  if (kartverketBulkAvailable(db)) {
    const local = lookupKartverketAddress(db, {
      address_text: line,
      postnummer: address.postnummer,
      kommunenummer: address.kommunenummer ?? null,
    })
    return local
  }

  if (!allowApi) return null

  return geocodeAddress(address, line)
}

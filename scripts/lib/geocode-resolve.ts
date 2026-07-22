import type Database from 'better-sqlite3'
import type { BrregAddress } from './types.js'
import { geocodeAddress, type GeocodeResult } from './geocode.js'
import {
  findCachedKartverketZip,
  importKartverketFromCache,
  kartverketBulkAvailable,
  kartverketAddressCount,
} from './kartverket-bulk.js'
import { lookupKartverketAddress } from './local-geocode.js'

let localReadyChecked = false

/** Load Kartverket bulk from cached zip into DB if not already present. */
export async function ensureLocalKartverketReady(db: Database.Database): Promise<boolean> {
  if (kartverketBulkAvailable(db)) {
    return true
  }

  const zipPath = findCachedKartverketZip()
  if (!zipPath) {
    return false
  }

  if (!localReadyChecked) {
    console.log(`Fant lokal Kartverket-fil: ${zipPath}`)
    console.log('Importerer adresser til databasen (engangssteg)…')
  }

  await importKartverketFromCache(db)
  localReadyChecked = true
  return kartverketBulkAvailable(db)
}

export function geocodeSourceDescription(db: Database.Database): string {
  if (kartverketBulkAvailable(db)) {
    return `lokal Kartverket-database (${kartverketAddressCount(db).toLocaleString('nb-NO')} adresser, deretter API ved miss)`
  }
  if (findCachedKartverketZip()) {
    return 'lokal Kartverket-fil (importeres ved geokoding, deretter API ved miss)'
  }
  return 'Kartverket Adresse-API'
}

/** Geocode via local bulk register when available, otherwise Kartverket API. */
export async function geocodeAddressResolved(
  db: Database.Database,
  address: BrregAddress,
  line: string,
): Promise<GeocodeResult | null> {
  if (!address.postnummer) return null
  if (address.landkode && address.landkode !== 'NO') return null

  if (kartverketBulkAvailable(db)) {
    const local = lookupKartverketAddress(db, {
      address_text: line,
      postnummer: address.postnummer,
      kommunenummer: address.kommunenummer ?? null,
    })
    if (local) return local
  }

  return geocodeAddress(address, line)
}

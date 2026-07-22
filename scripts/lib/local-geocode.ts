import type Database from 'better-sqlite3'
import type { Statement } from 'better-sqlite3'
import type { GeocodeQuality } from './types.js'
import { normalizeAddressText, structuredLookupKey } from './kartverket-bulk.js'
import { parseStreetAddress, type GeocodeResult } from './geocode.js'
import {
  applyGeocodeResult,
  getCachedAddress,
  saveAddressCache,
  sampleAddressForKey,
} from './organizations.js'

interface KartverketHit {
  lat: number
  lng: number
  adresse_id: string
  kommunenummer: string | null
  matrikkel_key: string | null
}

interface PendingSample {
  addressKey: string
  address_text: string
  postnummer: string
  kommunenummer: string | null
}

interface GeocodeStatements {
  lookupStructured: Statement
  lookupFreeText: Statement
  getCache: Statement
  saveCache: Statement
  applyGeocode: Statement
}

const BATCH_SIZE = 2000
const LOG_EVERY = 5000

function classifyQuality(
  method: 'structured' | 'freeText',
  brregKommune: string | null | undefined,
  geoKommune: string | null | undefined,
): GeocodeQuality {
  if (brregKommune && geoKommune && brregKommune !== geoKommune) return 'mismatch'
  return method === 'structured' ? 'verified' : 'fallback'
}

function createGeocodeStatements(db: Database.Database): GeocodeStatements {
  return {
    lookupStructured: db.prepare(
      `SELECT lat, lng, adresse_id, kommunenummer, matrikkel_key
       FROM kartverket_addresses
       WHERE lookup_key = ?
       LIMIT 1`,
    ),
    lookupFreeText: db.prepare(
      `SELECT lat, lng, adresse_id, kommunenummer, matrikkel_key
       FROM kartverket_addresses
       WHERE postnummer = ? AND adresse_tekst_norm = ?
       LIMIT 1`,
    ),
    getCache: db.prepare(
      `SELECT lat, lng, failed, adresse_id, matrikkel_key, kommunenummer_geo, geocode_quality
       FROM address_cache WHERE cache_key = ?`,
    ),
    saveCache: db.prepare(
      `INSERT INTO address_cache (
         cache_key, lat, lng, geocoded_at, failed,
         adresse_id, matrikkel_key, kommunenummer_geo, geocode_quality
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         lat = excluded.lat,
         lng = excluded.lng,
         geocoded_at = excluded.geocoded_at,
         failed = excluded.failed,
         adresse_id = excluded.adresse_id,
         matrikkel_key = excluded.matrikkel_key,
         kommunenummer_geo = excluded.kommunenummer_geo,
         geocode_quality = excluded.geocode_quality`,
    ),
    applyGeocode: db.prepare(
      `UPDATE organizations
       SET lat = ?, lng = ?,
           adresse_id = ?, matrikkel_key = ?,
           kommunenummer_geo = ?, geocode_quality = ?
       WHERE address_key = ? AND deleted = 0`,
    ),
  }
}

function hitToResult(
  hit: KartverketHit,
  method: 'structured' | 'freeText',
  brregKommune: string | null | undefined,
): GeocodeResult {
  return {
    lat: hit.lat,
    lng: hit.lng,
    adresseId: hit.adresse_id,
    kommunenummer: hit.kommunenummer ?? undefined,
    matrikkelKey: hit.matrikkel_key ?? undefined,
    method,
    quality: classifyQuality(method, brregKommune, hit.kommunenummer),
  }
}

function lookupKartverketWithStatements(
  stmts: GeocodeStatements,
  sample: { address_text: string; postnummer: string; kommunenummer: string | null },
): GeocodeResult | null {
  const parsed = parseStreetAddress(sample.address_text)
  if (parsed) {
    const key = structuredLookupKey(sample.postnummer, parsed.adressenavn, parsed.nummer)
    if (key) {
      const hit = stmts.lookupStructured.get(key) as KartverketHit | undefined
      if (hit) return hitToResult(hit, 'structured', sample.kommunenummer)
    }
  }

  const fallback = stmts.lookupFreeText.get(
    sample.postnummer,
    normalizeAddressText(sample.address_text),
  ) as KartverketHit | undefined
  if (!fallback) return null

  return hitToResult(fallback, 'freeText', sample.kommunenummer)
}

function readCache(stmts: GeocodeStatements, cacheKey: string): GeocodeResult | null | 'failed' {
  const row = stmts.getCache.get(cacheKey) as
    | {
        lat: number | null
        lng: number | null
        failed: number
        adresse_id: string | null
        matrikkel_key: string | null
        kommunenummer_geo: string | null
        geocode_quality: GeocodeQuality | null
      }
    | undefined
  if (!row) return null
  if (row.failed || row.lat == null || row.lng == null) return 'failed'

  return {
    lat: row.lat,
    lng: row.lng,
    adresseId: row.adresse_id ?? undefined,
    matrikkelKey: row.matrikkel_key ?? undefined,
    kommunenummer: row.kommunenummer_geo ?? undefined,
    quality: row.geocode_quality ?? 'fallback',
    method: row.geocode_quality === 'verified' ? 'structured' : 'freeText',
  }
}

function writeCache(
  stmts: GeocodeStatements,
  cacheKey: string,
  result: GeocodeResult | null,
  geocodedAt: string,
) {
  stmts.saveCache.run(
    cacheKey,
    result?.lat ?? null,
    result?.lng ?? null,
    geocodedAt,
    result ? 0 : 1,
    result?.adresseId ?? null,
    result?.matrikkelKey ?? null,
    result?.kommunenummer ?? null,
    result?.quality ?? null,
  )
}

function applyResult(
  stmts: GeocodeStatements,
  addressKey: string,
  result: GeocodeResult,
): number {
  return stmts.applyGeocode.run(
    result.lat,
    result.lng,
    result.adresseId ?? null,
    result.matrikkelKey ?? null,
    result.kommunenummer ?? null,
    result.quality,
    addressKey,
  ).changes
}

function loadPendingSamples(db: Database.Database): PendingSample[] {
  return db
    .prepare(
      `SELECT
         o.address_key AS addressKey,
         o.address_text,
         o.postnummer,
         o.kommunenummer
       FROM organizations o
       INNER JOIN (
         SELECT address_key, MIN(rowid) AS rowid
         FROM organizations
         WHERE deleted = 0
           AND lat IS NULL
           AND address_key IS NOT NULL
         GROUP BY address_key
       ) pending ON pending.rowid = o.rowid
       LEFT JOIN address_cache c
         ON c.cache_key = o.address_key AND c.failed = 1
       WHERE c.cache_key IS NULL`,
    )
    .all() as PendingSample[]
}

function loadMetadataSamples(db: Database.Database): PendingSample[] {
  return db
    .prepare(
      `SELECT
         o.address_key AS addressKey,
         o.address_text,
         o.postnummer,
         o.kommunenummer
       FROM organizations o
       INNER JOIN (
         SELECT address_key, MIN(rowid) AS rowid
         FROM organizations
         WHERE deleted = 0
           AND lat IS NOT NULL
           AND geocode_quality IS NULL
           AND address_key IS NOT NULL
         GROUP BY address_key
       ) pending ON pending.rowid = o.rowid`,
    )
    .all() as PendingSample[]
}

interface BatchResult {
  geocoded: number
  failed: number
  orgsUpdated: number
}

function processBatch(
  stmts: GeocodeStatements,
  samples: PendingSample[],
  geocodedAt: string,
  skipCacheLookup = false,
): BatchResult {
  let geocoded = 0
  let failed = 0
  let orgsUpdated = 0

  for (const sample of samples) {
    if (!skipCacheLookup) {
      const cached = readCache(stmts, sample.addressKey)
      if (cached === 'failed') {
        failed += 1
        continue
      }
      if (cached) {
        orgsUpdated += applyResult(stmts, sample.addressKey, cached)
        geocoded += 1
        continue
      }
    }

    if (!sample.address_text || !sample.postnummer) {
      writeCache(stmts, sample.addressKey, null, geocodedAt)
      failed += 1
      continue
    }

    const result = lookupKartverketWithStatements(stmts, sample)
    writeCache(stmts, sample.addressKey, result, geocodedAt)
    if (!result) {
      failed += 1
      continue
    }

    orgsUpdated += applyResult(stmts, sample.addressKey, result)
    geocoded += 1
  }

  return { geocoded, failed, orgsUpdated }
}

function runBulkGeocode(
  db: Database.Database,
  samples: PendingSample[],
  label: string,
  skipCacheLookup = false,
): { geocoded: number; failed: number; processed: number; orgsUpdated: number } {
  if (samples.length === 0) {
    console.log(`Ingen adresser å ${label}.`)
    return { geocoded: 0, failed: 0, processed: 0, orgsUpdated: 0 }
  }

  console.log(`${label} ${samples.length.toLocaleString('nb-NO')} unike adresser…`)

  db.pragma('cache_size = -64000')

  const stmts = createGeocodeStatements(db)
  const runTransaction = db.transaction((batch: PendingSample[], geocodedAt: string) =>
    processBatch(stmts, batch, geocodedAt, skipCacheLookup),
  )

  let geocoded = 0
  let failed = 0
  let orgsUpdated = 0
  const started = Date.now()

  for (let index = 0; index < samples.length; index += BATCH_SIZE) {
    const batch = samples.slice(index, index + BATCH_SIZE)
    const geocodedAt = new Date().toISOString()
    const result = runTransaction(batch, geocodedAt)
    geocoded += result.geocoded
    failed += result.failed
    orgsUpdated += result.orgsUpdated

    const processed = Math.min(index + BATCH_SIZE, samples.length)
    if (processed % LOG_EVERY === 0 || processed === samples.length) {
      const elapsedSec = (Date.now() - started) / 1000
      const rate = elapsedSec > 0 ? Math.round(processed / elapsedSec) : processed
      console.log(
        `  ${processed.toLocaleString('nb-NO')} / ${samples.length.toLocaleString('nb-NO')} adresser (${rate.toLocaleString('nb-NO')}/s) – ${geocoded.toLocaleString('nb-NO')} treff, ${failed.toLocaleString('nb-NO')} feilet | ${orgsUpdated.toLocaleString('nb-NO')} org.-rader oppdatert`,
      )
    }
  }

  const elapsedMin = ((Date.now() - started) / 1000 / 60).toFixed(1)
  console.log(
    `Ferdig: ${geocoded.toLocaleString('nb-NO')} treff, ${failed.toLocaleString('nb-NO')} feilet, ${orgsUpdated.toLocaleString('nb-NO')} org.-rader (${elapsedMin} min)`,
  )

  return { geocoded, failed, processed: samples.length, orgsUpdated }
}

export function lookupKartverketAddress(
  db: Database.Database,
  sample: { address_text: string; postnummer: string; kommunenummer: string | null },
): GeocodeResult | null {
  const stmts = createGeocodeStatements(db)
  return lookupKartverketWithStatements(stmts, sample)
}

export function geocodeAddressKeyFromBulk(
  db: Database.Database,
  addressKey: string,
): GeocodeResult | null {
  const cached = getCachedAddress(db, addressKey)
  if (cached === 'failed') return null
  if (cached) {
    applyGeocodeResult(db, addressKey, cached)
    return cached
  }

  const sample = sampleAddressForKey(db, addressKey)
  if (!sample?.address_text || !sample.postnummer) {
    saveAddressCache(db, addressKey, null)
    return null
  }

  const result = lookupKartverketAddress(db, sample)
  saveAddressCache(db, addressKey, result)
  if (result) applyGeocodeResult(db, addressKey, result)
  return result
}

export function geocodeAllFromKartverketBulk(db: Database.Database): {
  geocoded: number
  failed: number
  processed: number
} {
  const samples = loadPendingSamples(db)
  const result = runBulkGeocode(
    db,
    samples,
    'Geokoder',
  )
  return { geocoded: result.geocoded, failed: result.failed, processed: result.processed }
}

export function backfillMetadataFromKartverketBulk(db: Database.Database): {
  geocoded: number
  failed: number
  processed: number
} {
  const samples = loadMetadataSamples(db)
  const result = runBulkGeocode(
    db,
    samples,
    'Oppdaterer metadata for',
    true,
  )
  return { geocoded: result.geocoded, failed: result.failed, processed: result.processed }
}

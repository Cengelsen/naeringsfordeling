import type Database from 'better-sqlite3'
import type { Statement } from 'better-sqlite3'
import type { GeocodeQuality } from './types.js'
import { normalizeAddressText, structuredLookupKey } from './kartverket-bulk.js'
import {
  compactStreetName,
  normalizeStreetName,
  parseStreetAddress,
  streetNameVariants,
  type GeocodeResult,
} from './geocode.js'
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
  bokstav?: string | null
  adressenavn?: string | null
  nummer?: string | null
}

interface PendingSample {
  addressKey: string
  address_text: string
  postnummer: string
  kommunenummer: string | null
}

interface LookupStatements {
  lookupStructured: Statement
  lookupFreeText: Statement
  lookupStreet: Statement
  lookupByPostnummerNummer: Statement
  lookupFreeTextPrefix: Statement
}

interface GeocodeStatements extends LookupStatements {
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

function createLookupStatements(db: Database.Database): LookupStatements {
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
    lookupStreet: db.prepare(
      `SELECT lat, lng, adresse_id, kommunenummer, matrikkel_key, bokstav, adressenavn, nummer
       FROM kartverket_addresses
       WHERE postnummer = ?
         AND lower(adressenavn) = lower(?)
         AND nummer = ?`,
    ),
    lookupByPostnummerNummer: db.prepare(
      `SELECT lat, lng, adresse_id, kommunenummer, matrikkel_key, bokstav, adressenavn, nummer
       FROM kartverket_addresses
       WHERE postnummer = ?
         AND nummer = ?`,
    ),
    lookupFreeTextPrefix: db.prepare(
      `SELECT lat, lng, adresse_id, kommunenummer, matrikkel_key, bokstav, adressenavn, nummer
       FROM kartverket_addresses
       WHERE postnummer = ?
         AND adresse_tekst_norm LIKE ?
       LIMIT 8`,
    ),
  }
}

function createGeocodeStatements(db: Database.Database): GeocodeStatements {
  return {
    ...createLookupStatements(db),
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

function streetNamesMatch(left: string | null | undefined, right: string): boolean {
  if (!left) return false
  const target = compactStreetName(right)
  return streetNameVariants(left).some((variant) => compactStreetName(variant) === target)
}

function pickStreetHits(
  hits: KartverketHit[],
  bokstav: string,
  brregKommune: string | null | undefined,
): GeocodeResult | null {
  if (hits.length === 0) return null

  if (bokstav) {
    const exact = hits.find((hit) => (hit.bokstav ?? '').toLowerCase() === bokstav.toLowerCase())
    if (exact) return hitToResult(exact, 'structured', brregKommune)
  }

  if (hits.length === 1) {
    return hitToResult(hits[0]!, 'structured', brregKommune)
  }

  const withoutLetter = hits.filter((hit) => !hit.bokstav)
  if (withoutLetter.length === 1) {
    return hitToResult(withoutLetter[0]!, 'structured', brregKommune)
  }

  const sorted = [...hits].sort((left, right) =>
    (left.bokstav ?? '').localeCompare(right.bokstav ?? '', 'nb'),
  )
  return hitToResult(sorted[0]!, 'structured', brregKommune)
}

function lookupStructured(
  stmts: LookupStatements,
  postnummer: string,
  adressenavn: string,
  nummer: string,
  bokstav: string,
  brregKommune: string | null | undefined,
): GeocodeResult | null {
  for (const street of streetNameVariants(adressenavn)) {
    const keys = [
      structuredLookupKey(postnummer, street, nummer, bokstav),
      structuredLookupKey(postnummer, street, `${nummer}${bokstav}`),
      structuredLookupKey(postnummer, street, nummer),
    ].filter((key): key is string => Boolean(key))

    for (const key of keys) {
      const hit = stmts.lookupStructured.get(key) as KartverketHit | undefined
      if (hit) return hitToResult(hit, 'structured', brregKommune)
    }
  }

  return null
}

function lookupFreeText(
  stmts: LookupStatements,
  postnummer: string,
  addressText: string,
  brregKommune: string | null | undefined,
): GeocodeResult | null {
  const variants = [...new Set([normalizeAddressText(addressText)])]
  for (const variant of variants) {
    const hit = stmts.lookupFreeText.get(postnummer, variant) as KartverketHit | undefined
    if (hit) return hitToResult(hit, 'freeText', brregKommune)
  }

  for (const variant of variants) {
    const hits = stmts.lookupFreeTextPrefix.all(postnummer, `${variant}%`) as KartverketHit[]
    if (hits.length === 1) {
      return hitToResult(hits[0]!, 'freeText', brregKommune)
    }
  }

  return null
}

function lookupStreetComponents(
  stmts: LookupStatements,
  postnummer: string,
  adressenavn: string,
  nummer: string,
  bokstav: string,
  brregKommune: string | null | undefined,
): GeocodeResult | null {
  for (const street of streetNameVariants(adressenavn)) {
    const hits = stmts.lookupStreet.all(postnummer, street, nummer) as KartverketHit[]
    const picked = pickStreetHits(hits, bokstav, brregKommune)
    if (picked) return picked
  }

  const fuzzyHits = (stmts.lookupByPostnummerNummer.all(postnummer, nummer) as KartverketHit[]).filter(
    (hit) => streetNamesMatch(hit.adressenavn, adressenavn),
  )
  return pickStreetHits(fuzzyHits, bokstav, brregKommune)
}

function lookupStreetOnly(
  stmts: LookupStatements,
  postnummer: string,
  adressenavn: string,
  brregKommune: string | null | undefined,
): GeocodeResult | null {
  for (const street of streetNameVariants(adressenavn)) {
    const hits = stmts.lookupFreeTextPrefix.all(
      postnummer,
      `${normalizeAddressText(street)}%`,
    ) as KartverketHit[]
    const matched = hits.filter((hit) => streetNamesMatch(hit.adressenavn, adressenavn))
    if (matched.length === 1) {
      return hitToResult(matched[0]!, 'freeText', brregKommune)
    }
  }
  return null
}

function lookupParsedStreet(
  stmts: LookupStatements,
  postnummer: string,
  adressenavn: string,
  nummer: string,
  bokstav: string,
  brregKommune: string | null | undefined,
): GeocodeResult | null {
  const structured = lookupStructured(
    stmts,
    postnummer,
    adressenavn,
    nummer,
    bokstav,
    brregKommune,
  )
  if (structured) return structured

  return lookupStreetComponents(
    stmts,
    postnummer,
    adressenavn,
    nummer,
    bokstav,
    brregKommune,
  )
}

function lookupKartverketWithStatements(
  stmts: LookupStatements,
  sample: { address_text: string; postnummer: string; kommunenummer: string | null },
): GeocodeResult | null {
  const parsed = parseStreetAddress(sample.address_text)
  if (parsed) {
    if (parsed.range) {
      for (const nummer of parsed.range) {
        const ranged = lookupParsedStreet(
          stmts,
          sample.postnummer,
          parsed.adressenavn,
          String(nummer),
          parsed.bokstav,
          sample.kommunenummer,
        )
        if (ranged) return ranged
      }
    } else {
      const direct = lookupParsedStreet(
        stmts,
        sample.postnummer,
        parsed.adressenavn,
        parsed.nummer,
        parsed.bokstav,
        sample.kommunenummer,
      )
      if (direct) return direct
    }
  } else {
    const streetOnly = lookupStreetOnly(
      stmts,
      sample.postnummer,
      sample.address_text,
      sample.kommunenummer,
    )
    if (streetOnly) return streetOnly
  }

  return lookupFreeText(stmts, sample.postnummer, sample.address_text, sample.kommunenummer)
}

/** Drop stale failed-cache rows so improved matchers can retry pending addresses. */
export function clearPendingGeocodeFailures(db: Database.Database): number {
  return db
    .prepare(
      `DELETE FROM address_cache
       WHERE failed = 1
         AND cache_key IN (
           SELECT address_key
           FROM organizations
           WHERE deleted = 0
             AND lat IS NULL
             AND address_key IS NOT NULL
         )`,
    )
    .run().changes
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
  const stmts = createLookupStatements(db)
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
  let geocoded = 0
  let failed = 0
  let processed = 0
  let pass = 0

  while (pass < 3) {
    pass += 1
    const cleared = clearPendingGeocodeFailures(db)
    if (cleared > 0) {
      console.log(`Slettet ${cleared.toLocaleString('nb-NO')} utdaterte feilet geokode-cache-rader.`)
    }

    const samples = loadPendingSamples(db)
    if (samples.length === 0) break

    const result = runBulkGeocode(db, samples, pass === 1 ? 'Geokoder' : `Geokoder (runde ${pass})`)
    geocoded += result.geocoded
    failed += result.failed
    processed += result.processed

    if (result.geocoded === 0) break
  }

  return { geocoded, failed, processed }
}

export function backfillMetadataFromKartverketBulk(db: Database.Database): {
  geocoded: number
  failed: number
  processed: number
} {
  const samples = loadMetadataSamples(db)
  const result = runBulkGeocode(db, samples, 'Oppdaterer metadata for', true)
  return { geocoded: result.geocoded, failed: result.failed, processed: result.processed }
}

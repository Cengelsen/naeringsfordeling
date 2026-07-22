import type Database from 'better-sqlite3'
import { LIMITS, sleep } from './rate-limit.js'
import {
  fetchEntity,
  fetchKommuneEntities,
  fetchKommuneUnderenheter,
  fetchKommunerForFylke,
  fetchLatestUpdateId,
  fetchLatestUpdateIdUnderenheter,
  fetchUnderenhet,
  fetchUpdatesSince,
  fetchUpdatesSinceUnderenheter,
} from './brreg.js'
import { runPool } from './geocode.js'
import {
  ensureLocalKartverketReady,
  geocodeAddressResolved,
  geocodeSourceDescription,
} from './geocode-resolve.js'
import {
  backfillMetadataFromKartverketBulk,
  geocodeAllFromKartverketBulk,
} from './local-geocode.js'
import { kartverketBulkAvailable } from './kartverket-bulk.js'
import {
  DEFAULT_REFERENCE_CACHE_DIR,
  ensureBrregReferenceCache,
  importBrregEnheterFromCache,
  importBrregUnderenheterFromCache,
} from './reference-cache.js'
import {
  applyGeocodeResult,
  getCachedAddress,
  markDeleted,
  pendingAddressKeys,
  pendingMetadataAddressKeys,
  saveAddressCache,
  sampleAddressForKey,
  upsertEntity,
  upsertUnderenhet,
} from './organizations.js'
import {
  getBackfillStats,
  getSyncState,
  getStats,
  logBackfillStats,
  needsBackfill,
  rebuildOrgsRtree,
  setSyncState,
} from './db.js'

const LAST_UPDATE_ID_KEY = 'last_oppdateringsid'
const LAST_UPDATE_ID_UNDERENHETER_KEY = 'last_oppdateringsid_underenheter'
const LAST_SYNC_AT_KEY = 'last_sync_at'
const LAST_FULL_SYNC_KEY = 'last_full_sync_at'
const LAST_BACKFILL_AT_KEY = 'last_backfill_at'

export interface SyncOptions {
  full?: boolean
  /** Re-stream BRREG bulk into existing DB (no delete). Updates new columns + underenheter. */
  backfill?: boolean
  /** With --backfill: skip underenheter bulk download. */
  skipUnderenheterBackfill?: boolean
  /** With --backfill: refresh geocode_quality / kommunenummer_geo on already geocoded rows. */
  regeocodeMetadata?: boolean
  dev?: boolean
  /** Two-digit fylkeskode for dev import, e.g. "03" for Oslo. */
  devFylke?: string
  geocodeOnly?: boolean
  geocodeLimit?: number
  geocodeConcurrency?: number
  /** Max unique addresses to geocode in one run (e.g. CI time budget). */
  maxGeocodeAddresses?: number
  /** Geocode every pending address (no quota); intended with --dev --fylke. */
  geocodeAll?: boolean
  maxGeocodeRounds?: number
  /** Baseline org counts at start of a multi-round geocode run. */
  geocodeBaseline?: { geocoded: number; pending_geocode: number }
}

/** Small kommuner for fast local development database. */
export const DEV_KOMMUNER = ['1111', '1112', '1144']
export const DEV_GEOCODE_MAX = 2000

async function resolveDevKommuner(devFylke?: string): Promise<string[]> {
  if (!devFylke) return DEV_KOMMUNER

  const kommuner = await fetchKommunerForFylke(devFylke)
  if (kommuner.length === 0) {
    throw new Error(
      `Ingen kommuner funnet for fylke «${devFylke}». Bruk tosifret fylkeskode, f.eks. --fylke=03 for Oslo.`,
    )
  }

  return kommuner
}

export function devImportLabel(devFylke?: string, kommuneCount?: number): string {
  if (!devFylke) return `3 standardkommuner (${DEV_KOMMUNER.join(', ')})`
  return `fylke ${devFylke}${kommuneCount != null ? ` (${kommuneCount} kommuner)` : ''}`
}

function logGeocodeProgress(
  processed: number,
  total: number,
  geocoded: number,
  failed: number,
  overall?: { done: number; remaining: number },
) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 100
  let line = `  ${processed.toLocaleString('nb-NO')} / ${total.toLocaleString('nb-NO')} adresser (${pct} %) – ${geocoded.toLocaleString('nb-NO')} treff, ${failed.toLocaleString('nb-NO')} feilet`
  if (overall) {
    const overallPct =
      overall.done + overall.remaining > 0
        ? Math.round((overall.done / (overall.done + overall.remaining)) * 100)
        : 100
    line += ` | totalt ${overall.done.toLocaleString('nb-NO')} / ${(overall.done + overall.remaining).toLocaleString('nb-NO')} org. (${overallPct} %)`
  }
  console.log(line)
}

export async function geocodePending(db: Database.Database, options: SyncOptions) {
  await ensureLocalKartverketReady(db)

  const limit = options.geocodeLimit ?? LIMITS.geocodeBatchSize
  const concurrency = options.geocodeConcurrency ?? LIMITS.geocodeConcurrency

  const keys = pendingAddressKeys(db, limit)
  if (keys.length === 0) {
    console.log('Ingen adresser å geokode.')
    return { geocoded: 0, failed: 0 }
  }

  console.log(
    `Geokoder opptil ${keys.length.toLocaleString('nb-NO')} unike adresser (${geocodeSourceDescription(db)})…`,
  )

  const statsBefore = getStats(db)
  const baseline = options.geocodeBaseline ?? statsBefore
  const logEvery = keys.length <= 20 ? 1 : keys.length <= 200 ? 10 : 100

  let processed = 0
  let geocoded = 0
  let failed = 0

  const reportProgress = () => {
    const stats = getStats(db)
    const overallDone = baseline.geocoded + baseline.pending_geocode - stats.pending_geocode
    logGeocodeProgress(processed, keys.length, geocoded, failed, {
      done: overallDone,
      remaining: stats.pending_geocode,
    })
  }

  await runPool(keys, concurrency, async (addressKey) => {
    const cached = getCachedAddress(db, addressKey)
    if (cached === 'failed') {
      processed += 1
      if (processed % logEvery === 0 || processed === keys.length) reportProgress()
      return
    }
    if (cached) {
      applyGeocodeResult(db, addressKey, cached)
      geocoded += 1
      processed += 1
      if (processed % logEvery === 0 || processed === keys.length) reportProgress()
      return
    }

    const sample = sampleAddressForKey(db, addressKey)
    if (!sample?.address_text || !sample.postnummer) {
      saveAddressCache(db, addressKey, null)
      failed += 1
      processed += 1
      if (processed % logEvery === 0 || processed === keys.length) reportProgress()
      return
    }

    const result = await geocodeAddressResolved(
      db,
      {
        postnummer: sample.postnummer,
        adresse: [sample.address_text],
        kommunenummer: sample.kommunenummer,
        landkode: 'NO',
      },
      sample.address_text,
    )

    saveAddressCache(db, addressKey, result)
    if (result) {
      applyGeocodeResult(db, addressKey, result)
      geocoded += 1
    } else {
      failed += 1
    }

    processed += 1
    if (processed % logEvery === 0 || processed === keys.length) reportProgress()
  })

  console.log(`Geokoding ferdig: ${geocoded.toLocaleString('nb-NO')} treff, ${failed.toLocaleString('nb-NO')} feilet`)
  return { geocoded, failed, processed: keys.length }
}

export async function backfillGeocodeMetadata(db: Database.Database, options: SyncOptions) {
  await ensureLocalKartverketReady(db)

  const limit = options.geocodeLimit ?? LIMITS.geocodeBatchSize
  const concurrency = options.geocodeConcurrency ?? LIMITS.geocodeConcurrency

  const keys = pendingMetadataAddressKeys(db, limit)
  if (keys.length === 0) {
    console.log('Ingen geokodede adresser mangler metadata.')
    return { geocoded: 0, failed: 0, processed: 0 }
  }

  console.log(
    `Oppdaterer Kartverket-metadata for opptil ${keys.length.toLocaleString('nb-NO')} adresser (${geocodeSourceDescription(db)})…`,
  )

  let processed = 0
  let geocoded = 0
  let failed = 0
  const logEvery = keys.length <= 20 ? 1 : keys.length <= 200 ? 10 : 100

  await runPool(keys, concurrency, async (addressKey) => {
    const cached = getCachedAddress(db, addressKey)
    if (cached && cached !== 'failed' && cached.quality) {
      applyGeocodeResult(db, addressKey, cached)
      geocoded += 1
      processed += 1
      if (processed % logEvery === 0 || processed === keys.length) {
        console.log(
          `  ${processed.toLocaleString('nb-NO')} / ${keys.length.toLocaleString('nb-NO')} adresser – ${geocoded.toLocaleString('nb-NO')} oppdatert`,
        )
      }
      return
    }

    const sample = sampleAddressForKey(db, addressKey)
    if (!sample?.address_text || !sample.postnummer) {
      failed += 1
      processed += 1
      return
    }

    const result = await geocodeAddressResolved(
      db,
      {
        postnummer: sample.postnummer,
        adresse: [sample.address_text],
        kommunenummer: sample.kommunenummer,
        landkode: 'NO',
      },
      sample.address_text,
    )

    saveAddressCache(db, addressKey, result)
    if (result) {
      applyGeocodeResult(db, addressKey, result)
      geocoded += 1
    } else {
      failed += 1
    }

    processed += 1
    if (processed % logEvery === 0 || processed === keys.length) {
      console.log(
        `  ${processed.toLocaleString('nb-NO')} / ${keys.length.toLocaleString('nb-NO')} adresser – ${geocoded.toLocaleString('nb-NO')} oppdatert, ${failed.toLocaleString('nb-NO')} feilet`,
      )
    }
  })

  console.log(
    `Metadata-backfill ferdig: ${geocoded.toLocaleString('nb-NO')} oppdatert, ${failed.toLocaleString('nb-NO')} feilet`,
  )
  return { geocoded, failed, processed: keys.length }
}

async function runGeocodeMetadataLoop(db: Database.Database, options: SyncOptions) {
  await ensureLocalKartverketReady(db)

  const backfill = getBackfillStats(db)
  if (backfill.missing_metadata_addresses === 0) {
    console.log('Alle geokodede adresser har metadata.')
    return
  }

  console.log(
    `${backfill.missing_geocode_metadata.toLocaleString('nb-NO')} organisasjoner mangler geokode-metadata (${backfill.missing_metadata_addresses.toLocaleString('nb-NO')} unike adresser)`,
  )
  console.log(`Geokilde: ${geocodeSourceDescription(db)}`)

  const maxGeocodeAddresses = resolveMaxGeocodeAddresses(options)
  if (kartverketBulkAvailable(db) && maxGeocodeAddresses == null) {
    await backfillMetadataFromKartverketBulk(db)
    return
  }

  const maxRounds = options.maxGeocodeRounds ?? Number(process.env.BUILD_DB_MAX_ROUNDS ?? 10000)
  let round = 0
  let addressesThisRun = 0

  while (round < maxRounds) {
    const remaining = getBackfillStats(db).missing_metadata_addresses
    if (remaining === 0) {
      console.log('Alle geokode-metadata er oppdatert.')
      break
    }

    if (maxGeocodeAddresses != null && addressesThisRun >= maxGeocodeAddresses) {
      console.log(
        `Metadata-kvote nådd (${maxGeocodeAddresses.toLocaleString('nb-NO')} adresser, ${remaining.toLocaleString('nb-NO')} gjenstår).`,
      )
      break
    }

    const batchLimit = geocodeLimitForRun(options, addressesThisRun)
    if (batchLimit === 0) break

    round += 1
    console.log(`\nMetadata-runde ${round}: ${remaining.toLocaleString('nb-NO')} adresser gjenstår`)

    const { processed } = await backfillGeocodeMetadata(db, {
      ...options,
      geocodeLimit: batchLimit,
    })
    addressesThisRun += processed

    const stillRemaining = getBackfillStats(db).missing_metadata_addresses
    if (stillRemaining >= remaining) {
      console.warn('Ingen fremgang denne metadata-runden – stopper.')
      break
    }

    if (stillRemaining > 0) {
      await sleep(LIMITS.geocodeBatchPauseMs)
    }
  }
}

export async function runBackfillImport(
  db: Database.Database,
  options: Pick<SyncOptions, 'devFylke' | 'dev' | 'skipUnderenheterBackfill'> = {},
) {
  logBackfillStats(db, 'Før backfill:')

  const scoped = options.dev || options.devFylke != null
  let imported = 0

  if (scoped) {
    console.log(
      `Backfill: oppdaterer eksisterende database for ${devImportLabel(options.devFylke)} (ingen sletting)…`,
    )
    imported = await runDevImport(db, {
      devFylke: options.devFylke,
      skipUnderenheterBackfill: options.skipUnderenheterBackfill,
    })
  } else {
    console.log('Backfill: importerer BRREG fra referansecache (hele landet, ingen sletting)…')

    const reference = await ensureBrregReferenceCache(DEFAULT_REFERENCE_CACHE_DIR, {
      reuseDownloads: true,
      skipUnderenheter: options.skipUnderenheterBackfill,
    })

    console.log(`Backfill enheter fra ${reference.enheterPath}…`)
    await importBrregEnheterFromCache(reference.enheterPath, async (entity) => {
      upsertEntity(db, entity, Boolean(entity.slettedato))
      imported += 1
    })
    console.log(`  Oppdatert ${imported.toLocaleString('nb-NO')} enheter`)

    let importedUnder = 0
    if (options.skipUnderenheterBackfill) {
      console.log('Hopper over underenheter (--skip-underenheter-backfill).')
    } else if (reference.underenheterPath) {
      console.log(`Backfill underenheter fra ${reference.underenheterPath}…`)
      await importBrregUnderenheterFromCache(reference.underenheterPath, async (entity) => {
        upsertUnderenhet(db, entity, Boolean(entity.slettedato))
        importedUnder += 1
      })
      console.log(`  Importert/oppdatert ${importedUnder.toLocaleString('nb-NO')} underenheter`)
    }

    imported += importedUnder

    const manifest = reference.manifest
    if (manifest.last_oppdateringsid) {
      setSyncState(db, LAST_UPDATE_ID_KEY, manifest.last_oppdateringsid)
    }
    if (manifest.last_oppdateringsid_underenheter) {
      setSyncState(db, LAST_UPDATE_ID_UNDERENHETER_KEY, manifest.last_oppdateringsid_underenheter)
    }
  }

  setSyncState(db, LAST_BACKFILL_AT_KEY, new Date().toISOString())
  setSyncState(db, LAST_FULL_SYNC_KEY, new Date().toISOString())
  logBackfillStats(db, 'Etter BRREG-backfill:')

  return imported
}

/** Alias kept for --full; same bulk upsert without deleting the database file. */
export async function runFullImport(db: Database.Database) {
  return runBackfillImport(db)
}

export async function runIncrementalSync(db: Database.Database) {
  const lastId = Number(getSyncState(db, LAST_UPDATE_ID_KEY) ?? '0')
  console.log(`Henter enhetsoppdateringer siden oppdateringsid ${lastId}…`)

  const { updates, maxId } = await fetchUpdatesSince(lastId + 1, (batch) => {
    if (batch.length > 0) {
      console.log(`  Mottok ${batch.length} enhetsoppdateringer (siste id ${batch[batch.length - 1].oppdateringsid})`)
    }
  })

  if (updates.length > 0) {
    const touched = new Set<string>()
    for (const update of updates) {
      touched.add(update.organisasjonsnummer)
    }

    console.log(`Prosesserer ${touched.size.toLocaleString('nb-NO')} unike enheter…`)

    for (const orgnr of touched) {
      const update = updates.filter((item) => item.organisasjonsnummer === orgnr).at(-1)
      if (!update) continue

      if (update.endringstype === 'Sletting') {
        markDeleted(db, orgnr)
        await sleep(LIMITS.brregEntityDelayMs)
        continue
      }

      const entity = await fetchEntity(orgnr)
      if (!entity) {
        markDeleted(db, orgnr)
      } else {
        upsertEntity(db, entity, Boolean(entity.slettedato))
      }

      await sleep(LIMITS.brregEntityDelayMs)
    }

    setSyncState(db, LAST_UPDATE_ID_KEY, String(maxId))
    console.log(`Inkrementell enhetssync ferdig. Siste oppdateringsid: ${maxId}`)
  } else {
    console.log('Ingen nye enhetsoppdateringer.')
  }

  const lastUnderId = Number(getSyncState(db, LAST_UPDATE_ID_UNDERENHETER_KEY) ?? '0')
  console.log(`Henter underenhetsoppdateringer siden oppdateringsid ${lastUnderId}…`)

  const { updates: underUpdates, maxId: maxUnderId } = await fetchUpdatesSinceUnderenheter(
    lastUnderId + 1,
    (batch) => {
      if (batch.length > 0) {
        console.log(
          `  Mottok ${batch.length} underenhetsoppdateringer (siste id ${batch[batch.length - 1].oppdateringsid})`,
        )
      }
    },
  )

  if (underUpdates.length === 0) {
    console.log('Ingen nye underenhetsoppdateringer.')
    return updates.length + underUpdates.length
  }

  const touchedUnder = new Set<string>()
  for (const update of underUpdates) {
    touchedUnder.add(update.organisasjonsnummer)
  }

  console.log(`Prosesserer ${touchedUnder.size.toLocaleString('nb-NO')} unike underenheter…`)

  for (const orgnr of touchedUnder) {
    const update = underUpdates.filter((item) => item.organisasjonsnummer === orgnr).at(-1)
    if (!update) continue

    if (update.endringstype === 'Sletting') {
      markDeleted(db, orgnr)
      await sleep(LIMITS.brregEntityDelayMs)
      continue
    }

    const entity = await fetchUnderenhet(orgnr)
    if (!entity) {
      markDeleted(db, orgnr)
    } else {
      upsertUnderenhet(db, entity, Boolean(entity.slettedato))
    }

    await sleep(LIMITS.brregEntityDelayMs)
  }

  setSyncState(db, LAST_UPDATE_ID_UNDERENHETER_KEY, String(maxUnderId))
  console.log(`Inkrementell underenhetssync ferdig. Siste oppdateringsid: ${maxUnderId}`)
  return updates.length + underUpdates.length
}

export async function runDevImport(
  db: Database.Database,
  options: Pick<SyncOptions, 'devFylke' | 'skipUnderenheterBackfill'> = {},
) {
  const kommuner = await resolveDevKommuner(options.devFylke)
  console.log(`Dev-import for ${devImportLabel(options.devFylke, kommuner.length)}`)
  let imported = 0
  let importedUnder = 0

  for (const kommunenummer of kommuner) {
    const count = await fetchKommuneEntities(kommunenummer, (entity) => {
      upsertEntity(db, entity, Boolean(entity.slettedato))
    })
    imported += count
    console.log(`  ${kommunenummer}: ${count.toLocaleString('nb-NO')} enheter`)

    if (options.skipUnderenheterBackfill) continue

    const underCount = await fetchKommuneUnderenheter(kommunenummer, (entity) => {
      upsertUnderenhet(db, entity, Boolean(entity.slettedato))
    })
    importedUnder += underCount
    console.log(`  ${kommunenummer}: ${underCount.toLocaleString('nb-NO')} underenheter`)
  }

  if (options.skipUnderenheterBackfill) {
    console.log('  Underenheter hoppet over (--skip-underenheter-backfill).')
  }

  const latestId = await fetchLatestUpdateId()
  if (latestId > 0) {
    setSyncState(db, LAST_UPDATE_ID_KEY, String(latestId))
  }

  const latestUnderId = await fetchLatestUpdateIdUnderenheter()
  if (latestUnderId > 0) {
    setSyncState(db, LAST_UPDATE_ID_UNDERENHETER_KEY, String(latestUnderId))
  }

  console.log(
    `Dev-import ferdig: ${imported.toLocaleString('nb-NO')} enheter, ${importedUnder.toLocaleString('nb-NO')} underenheter`,
  )
  return imported + importedUnder
}

export function devGeocodeOptions(geocodeAll: boolean): Pick<
  SyncOptions,
  'geocodeAll' | 'maxGeocodeAddresses' | 'maxGeocodeRounds' | 'geocodeLimit'
> {
  if (geocodeAll) {
    return {
      geocodeAll: true,
      maxGeocodeAddresses: undefined,
      maxGeocodeRounds: 10_000,
      geocodeLimit: LIMITS.geocodeBatchSize,
    }
  }

  return {
    geocodeAll: false,
    maxGeocodeAddresses: DEV_GEOCODE_MAX,
    maxGeocodeRounds: 1,
    geocodeLimit: DEV_GEOCODE_MAX,
  }
}

function resolveMaxGeocodeAddresses(options: SyncOptions): number | undefined {
  if (options.geocodeAll) return undefined
  if (options.maxGeocodeAddresses != null) return options.maxGeocodeAddresses
  const fromEnv = Number(process.env.BUILD_DB_MAX_GEOCODE_ADDRESSES ?? '')
  return fromEnv > 0 ? fromEnv : undefined
}

function geocodeLimitForRun(options: SyncOptions, addressesThisRun: number): number {
  const batchSize = options.geocodeLimit ?? LIMITS.geocodeBatchSize
  const maxAddresses = resolveMaxGeocodeAddresses(options)
  if (maxAddresses == null) return batchSize
  return Math.max(0, Math.min(batchSize, maxAddresses - addressesThisRun))
}

async function runGeocodeLoop(db: Database.Database, options: SyncOptions) {
  await ensureLocalKartverketReady(db)

  const geocodeStart = getStats(db)
  const maxGeocodeAddresses = resolveMaxGeocodeAddresses(options)
  console.log(
    `${geocodeStart.pending_geocode.toLocaleString('nb-NO')} organisasjoner venter geokoding`,
  )
  console.log(`Geokilde: ${geocodeSourceDescription(db)}`)
  if (options.geocodeAll) {
    console.log('Geokoder alle adresser (ingen kvote).')
  } else if (maxGeocodeAddresses != null) {
    console.log(`Geokodingskvote: ${maxGeocodeAddresses.toLocaleString('nb-NO')} adresser.`)
  }

  if (
    kartverketBulkAvailable(db) &&
    maxGeocodeAddresses == null &&
    geocodeStart.pending_geocode > 0
  ) {
    console.log('Kjører bulk geokoding mot lokal Kartverket-database.')
    await geocodeAllFromKartverketBulk(db)
    return
  }

  const maxRounds = options.maxGeocodeRounds ?? Number(process.env.BUILD_DB_MAX_ROUNDS ?? 10000)
  let round = 0
  let addressesThisRun = 0

  while (round < maxRounds) {
    const pending = getStats(db).pending_geocode
    const batchKeys = pendingAddressKeys(db, 1)

    if (maxGeocodeAddresses != null && addressesThisRun >= maxGeocodeAddresses) {
      console.log(
        `Geokodingsgrense nådd (${maxGeocodeAddresses.toLocaleString('nb-NO')} adresser per kjøring, ${pending.toLocaleString('nb-NO')} organisasjoner gjenstår).`,
      )
      break
    }

    if (pending === 0) {
      console.log('Alle adresser er geokodet.')
      break
    }

    if (batchKeys.length === 0) {
      console.log(
        `${pending.toLocaleString('nb-NO')} organisasjoner gjenstår, men ingen nye adresser kan geokodes (feilet/ugyldig).`,
      )
      break
    }

    const batchLimit = geocodeLimitForRun(options, addressesThisRun)
    if (batchLimit === 0) {
      console.log(
        `Geokodingsgrense nådd (${maxGeocodeAddresses?.toLocaleString('nb-NO')} adresser per kjøring).`,
      )
      break
    }

    round += 1
    const doneOrgs = geocodeStart.pending_geocode - pending
    console.log(
      `\nGeokodingsrunde ${round}: ${pending.toLocaleString('nb-NO')} organisasjoner gjenstår (${doneOrgs.toLocaleString('nb-NO')} ferdig totalt)`,
    )

    const { processed } = await geocodePending(db, {
      ...options,
      geocodeLimit: batchLimit,
      geocodeBaseline: geocodeStart,
    })
    addressesThisRun += processed

    const remaining = getStats(db).pending_geocode
    if (remaining >= pending) {
      console.warn('Ingen fremgang denne runden – stopper for å unngå uendelig løkke.')
      break
    }

    if (remaining > 0) {
      await sleep(LIMITS.geocodeBatchPauseMs)
    }
  }
}

export async function runSync(db: Database.Database, options: SyncOptions = {}) {
  const statsBefore = getStats(db)

  if (options.geocodeOnly) {
    if (options.regeocodeMetadata) {
      console.log('\nOppdaterer geokode-metadata…')
      await runGeocodeMetadataLoop(db, options)
    } else if (options.geocodeAll) {
      console.log('\nGeokoder adresser…')
      await runGeocodeLoop(db, options)
    } else {
      const limit = geocodeLimitForRun(options, 0)
      if (limit === 0) {
        console.log('Geokodingsgrense nådd (0 adresser igjen av kvoten).')
      } else {
        await geocodePending(db, { ...options, geocodeLimit: limit })
      }
    }
  } else if (options.dev) {
    await runDevImport(db, options)
    console.log('\nGeokoder adresser…')
    if (options.geocodeAll) {
      await runGeocodeLoop(db, options)
    } else {
      const limit = geocodeLimitForRun(options, 0)
      if (limit === 0) {
        console.log('Geokodingsgrense nådd (0 adresser igjen av kvoten).')
      } else {
        await geocodePending(db, { ...options, geocodeLimit: limit })
      }
    }
  } else if (options.backfill || options.full || statsBefore.total === 0) {
    if (options.backfill) {
      logBackfillStats(db, 'Starter backfill:')
    }
    await runBackfillImport(db, {
      dev: options.dev,
      devFylke: options.devFylke,
      skipUnderenheterBackfill: options.skipUnderenheterBackfill,
    })
    console.log('\nGeokoder nye adresser…')
    await runGeocodeLoop(db, options)
    if (options.regeocodeMetadata) {
      console.log('\nOppdaterer geokode-metadata for eksisterende adresser…')
      await runGeocodeMetadataLoop(db, options)
    } else if (getBackfillStats(db).needs_metadata_backfill) {
      console.log(
        'Tips: mange geokodede rader mangler fortsatt metadata. Kjør med --regeocode-metadata for Kartverket-feltene.',
      )
    }
  } else {
    if (needsBackfill(db)) {
      console.log(
        'Databasen mangler nye felt (næringskode, underenheter, osv.). Kjør «yarn sync --backfill» (hele landet) eller «yarn sync --backfill --fylke=46» for fylke-scoped database.',
      )
    }
    await runIncrementalSync(db)
    await geocodePending(db, options)
  }

  setSyncState(db, LAST_SYNC_AT_KEY, new Date().toISOString())

  const stats = getStats(db)
  console.log('Database status:')
  console.log(`  Totalt: ${stats.total.toLocaleString('nb-NO')}`)
  console.log(`  Enheter: ${stats.enheter.toLocaleString('nb-NO')}`)
  console.log(`  Underenheter: ${stats.underenheter.toLocaleString('nb-NO')}`)
  console.log(`  Aktive: ${stats.active.toLocaleString('nb-NO')}`)
  console.log(`  Geokodet: ${stats.geocoded.toLocaleString('nb-NO')}`)
  console.log(`  Venter geokoding: ${stats.pending_geocode.toLocaleString('nb-NO')}`)
  console.log(`  Siste oppdateringsid (enheter): ${getSyncState(db, LAST_UPDATE_ID_KEY) ?? '—'}`)
  console.log(
    `  Siste oppdateringsid (underenheter): ${getSyncState(db, LAST_UPDATE_ID_UNDERENHETER_KEY) ?? '—'}`,
  )

  return stats
}

export interface BuildDbOptions extends SyncOptions {
  fresh?: boolean
  skipGeocode?: boolean
}

export async function runBuildDatabase(db: Database.Database, options: BuildDbOptions = {}) {
  const statsBefore = getStats(db)
  const needsFullImport = options.fresh || statsBefore.total === 0

  console.log('API-grenser:')
  console.log(`  BRREG sidepause: ${LIMITS.brregPageDelayMs}ms`)
  console.log(`  BRREG enhetpause: ${LIMITS.brregEntityDelayMs}ms`)
  await ensureLocalKartverketReady(db)
  console.log(`  Geokilde: ${geocodeSourceDescription(db)}`)
  console.log(`  Geokoding (API): ${LIMITS.geocodeConcurrency} parallelle, ${LIMITS.geocodeDelayMs}ms mellomrom`)
  const maxGeocodeAddresses = resolveMaxGeocodeAddresses(options)
  console.log(`  Geokoding batch: ${options.geocodeLimit ?? LIMITS.geocodeBatchSize} adresser`)
  if (options.geocodeAll) {
    console.log('  Geokoding kvote: alle adresser')
  } else if (maxGeocodeAddresses != null) {
    console.log(`  Geokoding kvote: ${maxGeocodeAddresses.toLocaleString('nb-NO')} adresser per kjøring`)
  }

  if (options.dev) {
    console.log(`\nSteg 1/2: Dev-import fra BRREG (${devImportLabel(options.devFylke)})…`)
    await runDevImport(db, options)
  } else if (options.backfill) {
    const scope =
      options.devFylke != null || options.dev
        ? devImportLabel(options.devFylke)
        : 'hele landet'
    console.log(`\nSteg 1/2: Backfill fra BRREG (${scope}, beholder eksisterende database)…`)
    await runBackfillImport(db, {
      dev: options.dev,
      devFylke: options.devFylke,
      skipUnderenheterBackfill: options.skipUnderenheterBackfill,
    })
  } else if (needsFullImport) {
    console.log('\nSteg 1/2: Full import fra BRREG bulk (enheter + underenheter)…')
    await runBackfillImport(db)
  } else {
    console.log('\nSteg 1/2: Inkrementell oppdatering fra BRREG…')
    if (needsBackfill(db)) {
      console.log(
        '  (Databasen mangler nye felt – vurder «yarn build-db --backfill --fylke=XX» for fylke-database.)',
      )
    }
    await runIncrementalSync(db)
  }

  if (options.skipGeocode) {
    console.log('\nHopper over geokoding (--skip-geocode).')
  } else {
    console.log('\nSteg 2/2: Geokoder adresser…')
    await runGeocodeLoop(db, options)
    if (options.regeocodeMetadata) {
      console.log('\nSteg 3/3: Oppdaterer geokode-metadata…')
      await runGeocodeMetadataLoop(db, options)
    }
  }

  setSyncState(db, LAST_SYNC_AT_KEY, new Date().toISOString())
  rebuildOrgsRtree(db)

  const stats = getStats(db)
  console.log('\nFerdig. Database status:')
  console.log(`  Fil: ${process.env.DATABASE_PATH ?? 'data/organizations.db'}`)
  console.log(`  Totalt: ${stats.total.toLocaleString('nb-NO')}`)
  console.log(`  Enheter: ${stats.enheter.toLocaleString('nb-NO')}`)
  console.log(`  Underenheter: ${stats.underenheter.toLocaleString('nb-NO')}`)
  console.log(`  Aktive: ${stats.active.toLocaleString('nb-NO')}`)
  console.log(`  Geokodet: ${stats.geocoded.toLocaleString('nb-NO')}`)
  console.log(`  Venter geokoding: ${stats.pending_geocode.toLocaleString('nb-NO')}`)
  console.log(`  Siste oppdateringsid (enheter): ${getSyncState(db, LAST_UPDATE_ID_KEY) ?? '—'}`)
  console.log(
    `  Siste oppdateringsid (underenheter): ${getSyncState(db, LAST_UPDATE_ID_UNDERENHETER_KEY) ?? '—'}`,
  )

  return stats
}

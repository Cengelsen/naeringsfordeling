import type Database from 'better-sqlite3'
import { LIMITS, sleep } from './rate-limit.js'
import {
  fetchEntity,
  fetchKommunerForFylke,
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
  loadKommunerCache,
} from './reference-cache.js'
import { importBrregForKommuner, importBrregNationwideFromCache } from './brreg-local-import.js'
import {
  importEntireNationalDb,
  listKommunerFromNationalDb,
  nationalDatabaseAvailable,
  resolveNationalDbPath,
} from './national-db-slice.js'
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
  /** Allow BRREG/Kartverket HTTP APIs when local files are missing (default: false for build-db). */
  allowApi?: boolean
  /** Re-download BRREG reference files even if cached (requires --allow-api or explicit opt-in). */
  refreshDownloads?: boolean
  referenceCacheDir?: string
  nationalDbPath?: string
}

/** Small kommuner for fast local development database. */
export const DEV_KOMMUNER = ['1111', '1112', '1144']
export const DEV_GEOCODE_MAX = 2000

async function resolveDevKommuner(
  devFylke: string | undefined,
  options: Pick<SyncOptions, 'allowApi' | 'referenceCacheDir' | 'nationalDbPath'> = {},
): Promise<string[]> {
  if (!devFylke) return DEV_KOMMUNER

  const referenceCacheDir = options.referenceCacheDir ?? DEFAULT_REFERENCE_CACHE_DIR
  const cached = loadKommunerCache(referenceCacheDir)
  if (cached) {
    const code = devFylke.padStart(2, '0').slice(0, 2)
    const kommuner = cached
      .filter((k) => k.nummer.padStart(4, '0').slice(0, 2) === code)
      .map((k) => k.nummer.padStart(4, '0'))
    if (kommuner.length > 0) return kommuner
  }

  const nationalPath = resolveNationalDbPath(options.nationalDbPath)
  if (nationalDatabaseAvailable(nationalPath)) {
    const code = devFylke.padStart(2, '0').slice(0, 2)
    const kommuner = listKommunerFromNationalDb(nationalPath)
      .filter((k) => k.nummer.slice(0, 2) === code)
      .map((k) => k.nummer)
    if (kommuner.length > 0) {
      console.log(`  Kommuneliste for fylke ${code} fra ${nationalPath}`)
      return kommuner
    }
  }

  if (!options.allowApi) {
    throw new Error(
      `Mangler kommuneliste for fylke «${devFylke}» i ${referenceCacheDir} og nasjonal database (${nationalPath}). Kjør yarn build-national-db eller bruk --allow-api.`,
    )
  }

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
      { allowApi: options.allowApi ?? false },
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
      { allowApi: options.allowApi ?? false },
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
  options: Pick<
    SyncOptions,
    | 'devFylke'
    | 'dev'
    | 'skipUnderenheterBackfill'
    | 'allowApi'
    | 'refreshDownloads'
    | 'referenceCacheDir'
    | 'nationalDbPath'
  > = {},
) {
  logBackfillStats(db, 'Før backfill:')

  const scoped = options.dev || options.devFylke != null
  const referenceCacheDir = options.referenceCacheDir ?? DEFAULT_REFERENCE_CACHE_DIR
  const localOnly = !(options.allowApi ?? false)
  let imported = 0

  if (scoped) {
    console.log(
      `Backfill: oppdaterer eksisterende database for ${devImportLabel(options.devFylke)} (ingen sletting)…`,
    )
    imported = await runDevImport(db, {
      devFylke: options.devFylke,
      skipUnderenheterBackfill: options.skipUnderenheterBackfill,
      allowApi: options.allowApi,
      referenceCacheDir,
      nationalDbPath: options.nationalDbPath,
    })
  } else {
    const nationalPath = resolveNationalDbPath(options.nationalDbPath)
    if (getStats(db).total === 0 && nationalDatabaseAvailable(nationalPath)) {
      console.log(`Tom database – kopierer fra ${nationalPath} (prioriterer lokal fil over API)…`)
      const copied = importEntireNationalDb(db, nationalPath, {
        skipUnderenheter: options.skipUnderenheterBackfill,
      })
      console.log(`  ${copied.organizations.toLocaleString('nb-NO')} organisasjoner`)
      console.log(`  ${copied.addressCache.toLocaleString('nb-NO')} adresse-cache-rader`)
      console.log(`  ${copied.kartverket.toLocaleString('nb-NO')} Kartverket-adresser`)
      imported = copied.organizations
    } else {
      console.log('Backfill: importerer BRREG fra lokal referansecache (hele landet, ingen sletting)…')
      imported = await importBrregNationwideFromCache(db, {
        skipUnderenheter: options.skipUnderenheterBackfill,
        referenceCacheDir,
        refreshDownloads: options.refreshDownloads,
        localOnly,
      })
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

export async function runIncrementalSync(
  db: Database.Database,
  options: Pick<SyncOptions, 'allowApi'> = {},
) {
  if (!(options.allowApi ?? false)) {
    console.log(
      'Hopper over inkrementell BRREG-sync (lokal modus). Bruk --allow-api for å hente oppdateringer fra BRREG API.',
    )
    return 0
  }

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
  options: Pick<
    SyncOptions,
    'devFylke' | 'skipUnderenheterBackfill' | 'allowApi' | 'referenceCacheDir' | 'nationalDbPath'
  > = {},
) {
  const referenceCacheDir = options.referenceCacheDir ?? DEFAULT_REFERENCE_CACHE_DIR
  const kommuner = await resolveDevKommuner(options.devFylke, options)
  console.log(`Dev-import for ${devImportLabel(options.devFylke, kommuner.length)} fra lokal BRREG-cache`)

  const imported = await importBrregForKommuner(db, kommuner, {
    skipUnderenheter: options.skipUnderenheterBackfill,
    referenceCacheDir,
  })

  console.log(`Dev-import ferdig: ${imported.toLocaleString('nb-NO')} organisasjoner`)
  return imported
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
  const resolved: SyncOptions = { ...options, allowApi: options.allowApi ?? false }

  if (resolved.geocodeOnly) {
    if (resolved.regeocodeMetadata) {
      console.log('\nOppdaterer geokode-metadata…')
      await runGeocodeMetadataLoop(db, resolved)
    } else if (resolved.geocodeAll) {
      console.log('\nGeokoder adresser…')
      await runGeocodeLoop(db, resolved)
    } else {
      const limit = geocodeLimitForRun(resolved, 0)
      if (limit === 0) {
        console.log('Geokodingsgrense nådd (0 adresser igjen av kvoten).')
      } else {
        await geocodePending(db, { ...resolved, geocodeLimit: limit })
      }
    }
  } else if (resolved.dev) {
    await runDevImport(db, resolved)
    console.log('\nGeokoder adresser…')
    if (resolved.geocodeAll) {
      await runGeocodeLoop(db, resolved)
    } else {
      const limit = geocodeLimitForRun(resolved, 0)
      if (limit === 0) {
        console.log('Geokodingsgrense nådd (0 adresser igjen av kvoten).')
      } else {
        await geocodePending(db, { ...resolved, geocodeLimit: limit })
      }
    }
  } else if (resolved.backfill || resolved.full || statsBefore.total === 0) {
    if (resolved.backfill) {
      logBackfillStats(db, 'Starter backfill:')
    }
    await runBackfillImport(db, resolved)
    console.log('\nGeokoder nye adresser…')
    await runGeocodeLoop(db, resolved)
    if (resolved.regeocodeMetadata) {
      console.log('\nOppdaterer geokode-metadata for eksisterende adresser…')
      await runGeocodeMetadataLoop(db, resolved)
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
    await runIncrementalSync(db, { allowApi: resolved.allowApi })
    await geocodePending(db, resolved)
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

async function importFullFromLocalSources(
  db: Database.Database,
  options: BuildDbOptions,
): Promise<number> {
  const nationalPath = resolveNationalDbPath(options.nationalDbPath)
  if (nationalDatabaseAvailable(nationalPath)) {
    console.log(`Kopierer hele databasen fra ${nationalPath} (prioriterer lokal fil over API)…`)
    const copied = importEntireNationalDb(db, nationalPath, {
      skipUnderenheter: options.skipUnderenheterBackfill,
    })
    console.log(`  ${copied.organizations.toLocaleString('nb-NO')} organisasjoner`)
    console.log(`  ${copied.addressCache.toLocaleString('nb-NO')} adresse-cache-rader`)
    console.log(`  ${copied.kartverket.toLocaleString('nb-NO')} Kartverket-adresser`)
    return copied.organizations
  }

  console.log('Importerer fra lokal BRREG referansecache…')
  return importBrregNationwideFromCache(db, {
    skipUnderenheter: options.skipUnderenheterBackfill,
    referenceCacheDir: options.referenceCacheDir ?? DEFAULT_REFERENCE_CACHE_DIR,
    refreshDownloads: options.refreshDownloads,
    localOnly: !(options.allowApi ?? false),
  })
}

export async function runBuildDatabase(db: Database.Database, options: BuildDbOptions = {}) {
  const statsBefore = getStats(db)
  const needsFullImport = options.fresh || statsBefore.total === 0

  console.log('Datakilder (lokal først):')
  console.log(`  Nasjonal database: ${resolveNationalDbPath(options.nationalDbPath)}`)
  console.log(`  BRREG referansecache: ${options.referenceCacheDir ?? DEFAULT_REFERENCE_CACHE_DIR}`)
  console.log(`  API tillatt: ${options.allowApi ? 'ja' : 'nei (--allow-api for å aktivere)'}`)
  console.log('API-grenser (kun ved --allow-api):')
  console.log(`  BRREG sidepause: ${LIMITS.brregPageDelayMs}ms`)
  console.log(`  BRREG enhetpause: ${LIMITS.brregEntityDelayMs}ms`)
  await ensureLocalKartverketReady(db)
  console.log(`  Geokilde: ${geocodeSourceDescription(db, { allowApi: options.allowApi ?? false })}`)
  if (options.allowApi) {
    console.log(`  Geokoding (API): ${LIMITS.geocodeConcurrency} parallelle, ${LIMITS.geocodeDelayMs}ms mellomrom`)
  }
  const maxGeocodeAddresses = resolveMaxGeocodeAddresses(options)
  console.log(`  Geokoding batch: ${options.geocodeLimit ?? LIMITS.geocodeBatchSize} adresser`)
  if (options.geocodeAll) {
    console.log('  Geokoding kvote: alle adresser')
  } else if (maxGeocodeAddresses != null) {
    console.log(`  Geokoding kvote: ${maxGeocodeAddresses.toLocaleString('nb-NO')} adresser per kjøring`)
  }

  if (options.dev) {
    console.log(`\nSteg 1/2: Dev-import fra lokal BRREG-cache (${devImportLabel(options.devFylke)})…`)
    await runDevImport(db, options)
  } else if (options.backfill) {
    const scope =
      options.devFylke != null || options.dev
        ? devImportLabel(options.devFylke)
        : 'hele landet'
    console.log(`\nSteg 1/2: Backfill fra lokal BRREG-data (${scope}, beholder eksisterende database)…`)
    await runBackfillImport(db, options)
  } else if (needsFullImport) {
    console.log('\nSteg 1/2: Full import fra lokale filer (norway.db → referansecache, aldri API uten --allow-api)…')
    await importFullFromLocalSources(db, options)
  } else {
    console.log('\nSteg 1/2: Oppdatering…')
    if (needsBackfill(db)) {
      console.log(
        '  (Databasen mangler nye felt – vurder «yarn build-db --backfill --fylke=XX» for fylke-database.)',
      )
    }
    await runIncrementalSync(db, { allowApi: options.allowApi })
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

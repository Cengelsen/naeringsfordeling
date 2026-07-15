import type Database from 'better-sqlite3'
import { LIMITS, sleep } from './rate-limit.js'
import { downloadBulkEntities, fetchEntity, fetchKommuneEntities, fetchLatestUpdateId, fetchUpdatesSince } from './brreg.js'
import { geocodeAddress, runPool } from './geocode.js'
import {
  applyCachedCoordinates,
  getCachedAddress,
  markDeleted,
  pendingAddressKeys,
  saveAddressCache,
  sampleAddressForKey,
  upsertEntity,
} from './organizations.js'
import { getSyncState, getStats, setSyncState } from './db.js'

const LAST_UPDATE_ID_KEY = 'last_oppdateringsid'
const LAST_SYNC_AT_KEY = 'last_sync_at'
const LAST_FULL_SYNC_KEY = 'last_full_sync_at'

export interface SyncOptions {
  full?: boolean
  dev?: boolean
  geocodeOnly?: boolean
  geocodeLimit?: number
  geocodeConcurrency?: number
  /** Max unique addresses to geocode in one run (e.g. CI time budget). */
  maxGeocodeAddresses?: number
  /** Baseline org counts at start of a multi-round geocode run. */
  geocodeBaseline?: { geocoded: number; pending_geocode: number }
}

/** Small kommuner for fast local development database. */
const DEV_KOMMUNER = ['1111', '1112', '1144']

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
  const limit = options.geocodeLimit ?? LIMITS.geocodeBatchSize
  const concurrency = options.geocodeConcurrency ?? LIMITS.geocodeConcurrency

  const keys = pendingAddressKeys(db, limit)
  if (keys.length === 0) {
    console.log('Ingen adresser å geokode.')
    return { geocoded: 0, failed: 0 }
  }

  console.log(`Geokoder opptil ${keys.length.toLocaleString('nb-NO')} unike adresser…`)

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
      applyCachedCoordinates(db, addressKey, cached.lat, cached.lng)
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

    const coords = await geocodeAddress(
      {
        postnummer: sample.postnummer,
        adresse: [sample.address_text],
        kommunenummer: sample.kommunenummer,
        landkode: 'NO',
      },
      sample.address_text,
    )

    saveAddressCache(db, addressKey, coords)
    if (coords) {
      applyCachedCoordinates(db, addressKey, coords.lat, coords.lng)
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

export async function runFullImport(db: Database.Database) {
  console.log('Starter full import fra BRREG…')
  let imported = 0

  await downloadBulkEntities(async (entity) => {
    upsertEntity(db, entity, Boolean(entity.slettedato))
    imported += 1
  })

  setSyncState(db, LAST_FULL_SYNC_KEY, new Date().toISOString())

  const latestId = await fetchLatestUpdateId()
  if (latestId > 0) {
    setSyncState(db, LAST_UPDATE_ID_KEY, String(latestId))
  }

  console.log(`Full import ferdig: ${imported.toLocaleString('nb-NO')} enheter`)
  return imported
}

export async function runIncrementalSync(db: Database.Database) {
  const lastId = Number(getSyncState(db, LAST_UPDATE_ID_KEY) ?? '0')
  console.log(`Henter oppdateringer siden oppdateringsid ${lastId}…`)

  const { updates, maxId } = await fetchUpdatesSince(lastId + 1, (batch) => {
    if (batch.length > 0) {
      console.log(`  Mottok ${batch.length} oppdateringer (siste id ${batch[batch.length - 1].oppdateringsid})`)
    }
  })

  if (updates.length === 0) {
    console.log('Ingen nye oppdateringer.')
    return 0
  }

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
  console.log(`Inkrementell sync ferdig. Siste oppdateringsid: ${maxId}`)
  return updates.length
}

export async function runDevImport(db: Database.Database) {
  console.log(`Dev-import for kommuner: ${DEV_KOMMUNER.join(', ')}`)
  let imported = 0

  for (const kommunenummer of DEV_KOMMUNER) {
    const count = await fetchKommuneEntities(kommunenummer, (entity) => {
      upsertEntity(db, entity, Boolean(entity.slettedato))
    })
    imported += count
    console.log(`  ${kommunenummer}: ${count.toLocaleString('nb-NO')} enheter`)
  }

  const latestId = await fetchLatestUpdateId()
  if (latestId > 0) {
    setSyncState(db, LAST_UPDATE_ID_KEY, String(latestId))
  }

  console.log(`Dev-import ferdig: ${imported.toLocaleString('nb-NO')} enheter`)
  return imported
}

function resolveMaxGeocodeAddresses(options: SyncOptions): number | undefined {
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

export async function runSync(db: Database.Database, options: SyncOptions = {}) {
  const statsBefore = getStats(db)

  if (options.geocodeOnly) {
    const limit = geocodeLimitForRun(options, 0)
    if (limit === 0) {
      console.log('Geokodingsgrense nådd (0 adresser igjen av kvoten).')
    } else {
      await geocodePending(db, { ...options, geocodeLimit: limit })
    }
  } else if (options.dev) {
    await runDevImport(db)
    await geocodePending(db, options)
  } else if (options.full || statsBefore.total === 0) {
    await runFullImport(db)
    await geocodePending(db, options)
  } else {
    await runIncrementalSync(db)
    await geocodePending(db, options)
  }

  setSyncState(db, LAST_SYNC_AT_KEY, new Date().toISOString())

  const stats = getStats(db)
  console.log('Database status:')
  console.log(`  Totalt: ${stats.total.toLocaleString('nb-NO')}`)
  console.log(`  Aktive: ${stats.active.toLocaleString('nb-NO')}`)
  console.log(`  Geokodet: ${stats.geocoded.toLocaleString('nb-NO')}`)
  console.log(`  Venter geokoding: ${stats.pending_geocode.toLocaleString('nb-NO')}`)
  console.log(`  Siste oppdateringsid: ${getSyncState(db, LAST_UPDATE_ID_KEY) ?? '—'}`)

  return stats
}

export interface BuildDbOptions extends SyncOptions {
  fresh?: boolean
  skipGeocode?: boolean
  maxGeocodeRounds?: number
}

export async function runBuildDatabase(db: Database.Database, options: BuildDbOptions = {}) {
  const statsBefore = getStats(db)
  const needsFullImport = options.fresh || statsBefore.total === 0

  console.log('API-grenser:')
  console.log(`  BRREG sidepause: ${LIMITS.brregPageDelayMs}ms`)
  console.log(`  BRREG enhetpause: ${LIMITS.brregEntityDelayMs}ms`)
  console.log(`  Geokoding: ${LIMITS.geocodeConcurrency} parallelle, ${LIMITS.geocodeDelayMs}ms mellomrom`)
  const maxGeocodeAddresses = resolveMaxGeocodeAddresses(options)
  console.log(`  Geokoding batch: ${options.geocodeLimit ?? LIMITS.geocodeBatchSize} adresser`)
  if (maxGeocodeAddresses != null) {
    console.log(`  Geokoding kvote: ${maxGeocodeAddresses.toLocaleString('nb-NO')} adresser per kjøring`)
  }

  if (needsFullImport) {
    console.log('\nSteg 1/2: Full import fra BRREG bulk (én nedlasting)…')
    await runFullImport(db)
  } else {
    console.log('\nSteg 1/2: Inkrementell oppdatering fra BRREG…')
    await runIncrementalSync(db)
  }

  if (options.skipGeocode) {
    console.log('\nHopper over geokoding (--skip-geocode).')
  } else {
    console.log('\nSteg 2/2: Geokoder adresser via Kartverket…')
    const geocodeStart = getStats(db)
    console.log(
      `${geocodeStart.pending_geocode.toLocaleString('nb-NO')} organisasjoner venter geokoding`,
    )
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

  setSyncState(db, LAST_SYNC_AT_KEY, new Date().toISOString())

  const stats = getStats(db)
  console.log('\nFerdig. Database status:')
  console.log(`  Fil: ${process.env.DATABASE_PATH ?? 'data/organizations.db'}`)
  console.log(`  Totalt: ${stats.total.toLocaleString('nb-NO')}`)
  console.log(`  Aktive: ${stats.active.toLocaleString('nb-NO')}`)
  console.log(`  Geokodet: ${stats.geocoded.toLocaleString('nb-NO')}`)
  console.log(`  Venter geokoding: ${stats.pending_geocode.toLocaleString('nb-NO')}`)
  console.log(`  Siste oppdateringsid: ${getSyncState(db, LAST_UPDATE_ID_KEY) ?? '—'}`)

  return stats
}

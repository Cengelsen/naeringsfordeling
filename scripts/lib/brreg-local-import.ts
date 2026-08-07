import { existsSync } from 'node:fs'
import type Database from 'better-sqlite3'
import {
  BRREG_ENHETER_FILE,
  BRREG_UNDERENHETER_FILE,
  DEFAULT_REFERENCE_CACHE_DIR,
  importBrregEnheterFromCacheTransactional,
  importBrregUnderenheterFromCacheTransactional,
  readReferenceManifest,
  referencePath,
  ensureBrregReferenceCache,
} from './reference-cache.js'
import { setSyncState } from './db.js'
import { entityKommunenummer, upsertEntity, upsertUnderenhet } from './organizations.js'

const LAST_UPDATE_ID_KEY = 'last_oppdateringsid'
const LAST_UPDATE_ID_UNDERENHETER_KEY = 'last_oppdateringsid_underenheter'
const LAST_FULL_SYNC_KEY = 'last_full_sync_at'
const LAST_BACKFILL_AT_KEY = 'last_backfill_at'

export async function importBrregForKommuner(
  db: Database.Database,
  kommuner: string[],
  options: {
    skipUnderenheter?: boolean
    referenceCacheDir?: string
  } = {},
): Promise<number> {
  const referenceCacheDir = options.referenceCacheDir ?? DEFAULT_REFERENCE_CACHE_DIR
  const enheterPath = referencePath(referenceCacheDir, BRREG_ENHETER_FILE)

  if (!existsSync(enheterPath)) {
    throw new Error(
      `Mangler lokal BRREG enheter-fil: ${enheterPath}. Kjør yarn build-national-db for å laste ned referansedata.`,
    )
  }

  const kommuneSet = new Set(kommuner.map((k) => k.padStart(4, '0')))
  const filterEntity = (entity: Parameters<typeof upsertEntity>[1]) => {
    const k = entityKommunenummer(entity)
    return k != null && kommuneSet.has(k)
  }

  const underenheterPath = referencePath(referenceCacheDir, BRREG_UNDERENHETER_FILE)

  console.log(`  Filtrerer nasjonal BRREG-cache for ${kommuner.length} kommune(r)…`)
  console.log(`  Enheter fra ${enheterPath}`)

  let imported = 0
  await importBrregEnheterFromCacheTransactional(db, enheterPath, async (entity) => {
    upsertEntity(db, entity, Boolean(entity.slettedato), { deferParentLink: true })
    imported += 1
  }, filterEntity)
  console.log(`  ${imported.toLocaleString('nb-NO')} enheter importert`)

  if (options.skipUnderenheter) {
    console.log('  Underenheter hoppet over.')
  } else if (existsSync(underenheterPath)) {
    let importedUnder = 0
    console.log(`  Underenheter fra ${underenheterPath}`)
    await importBrregUnderenheterFromCacheTransactional(db, underenheterPath, async (entity) => {
      upsertUnderenhet(db, entity, Boolean(entity.slettedato), { deferParentLink: true })
      importedUnder += 1
    }, filterEntity)
    imported += importedUnder
    console.log(`  ${importedUnder.toLocaleString('nb-NO')} underenheter importert`)
  } else {
    console.log('  Ingen lokal underenheter-fil i referansecache.')
  }

  const manifest = readReferenceManifest(referenceCacheDir)
  if (manifest.last_oppdateringsid) {
    setSyncState(db, LAST_UPDATE_ID_KEY, manifest.last_oppdateringsid)
  }
  if (manifest.last_oppdateringsid_underenheter) {
    setSyncState(db, LAST_UPDATE_ID_UNDERENHETER_KEY, manifest.last_oppdateringsid_underenheter)
  }

  setSyncState(db, LAST_FULL_SYNC_KEY, new Date().toISOString())
  setSyncState(db, LAST_BACKFILL_AT_KEY, new Date().toISOString())

  return imported
}

export async function importBrregNationwideFromCache(
  db: Database.Database,
  options: {
    skipUnderenheter?: boolean
    referenceCacheDir?: string
    refreshDownloads?: boolean
    localOnly?: boolean
  } = {},
): Promise<number> {
  const referenceCacheDir = options.referenceCacheDir ?? DEFAULT_REFERENCE_CACHE_DIR

  const reference = await ensureBrregReferenceCache(referenceCacheDir, {
    reuseDownloads: true,
    refreshDownloads: options.refreshDownloads ?? false,
    localOnly: options.localOnly ?? !(options.refreshDownloads ?? false),
    skipUnderenheter: options.skipUnderenheter,
  })

  console.log(`Backfill enheter fra ${reference.enheterPath}…`)
  let imported = 0
  await importBrregEnheterFromCacheTransactional(db, reference.enheterPath, async (entity) => {
    upsertEntity(db, entity, Boolean(entity.slettedato), { deferParentLink: true })
    imported += 1
  })
  console.log(`  Oppdatert ${imported.toLocaleString('nb-NO')} enheter`)

  let importedUnder = 0
  if (options.skipUnderenheter) {
    console.log('Hopper over underenheter.')
  } else if (reference.underenheterPath) {
    console.log(`Backfill underenheter fra ${reference.underenheterPath}…`)
    await importBrregUnderenheterFromCacheTransactional(db, reference.underenheterPath, async (entity) => {
      upsertUnderenhet(db, entity, Boolean(entity.slettedato), { deferParentLink: true })
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

  setSyncState(db, LAST_BACKFILL_AT_KEY, new Date().toISOString())
  setSyncState(db, LAST_FULL_SYNC_KEY, new Date().toISOString())

  return imported
}

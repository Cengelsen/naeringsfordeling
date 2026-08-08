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
import { entityKommunenummer } from './organizations.js'
import type { BrregEntity, BrregUnderenhet } from './types.js'

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
    quiet?: boolean
    /** Total rows in national enheter gzip (for scan progress). */
    nationalEnheterRows?: number
    /** Total rows in national underenheter gzip (for scan progress). */
    nationalUnderenheterRows?: number
    onBrregProgress?: (event: {
      phase: 'enheter' | 'underenheter'
      rowsRead: number
      imported: number
    }) => void
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
  const filterEntity = (entity: BrregEntity | BrregUnderenhet) => {
    const k = entityKommunenummer(entity)
    return k != null && kommuneSet.has(k)
  }

  const underenheterPath = referencePath(referenceCacheDir, BRREG_UNDERENHETER_FILE)

  if (!options.quiet) {
    console.log(`  Filtrerer nasjonal BRREG-cache for ${kommuner.length} kommune(r)…`)
    console.log(`  Enheter fra ${enheterPath}`)
  }

  let enheterRowsRead = 0
  let enheterImported = 0
  const enheterImportOptions = {
    quiet: options.quiet,
    onRowsRead: (rowsRead: number) => {
      enheterRowsRead = rowsRead
      options.onBrregProgress?.({ phase: 'enheter', rowsRead, imported: enheterImported })
    },
    onProgress: (imported: number) => {
      enheterImported = imported
      options.onBrregProgress?.({ phase: 'enheter', rowsRead: enheterRowsRead, imported })
    },
  }

  const enheterResult = await importBrregEnheterFromCacheTransactional(
    db,
    enheterPath,
    filterEntity,
    enheterImportOptions,
  )
  if (options.onBrregProgress) {
    options.onBrregProgress({
      phase: 'enheter',
      rowsRead: options.nationalEnheterRows ?? enheterRowsRead,
      imported: enheterResult.scanned,
    })
  }
  if (!options.quiet) {
    console.log(`  ${enheterResult.scanned.toLocaleString('nb-NO')} enheter importert`)
  }

  let imported = enheterResult.scanned

  if (options.skipUnderenheter) {
    if (!options.quiet) console.log('  Underenheter hoppet over.')
  } else if (existsSync(underenheterPath)) {
    if (!options.quiet) console.log(`  Underenheter fra ${underenheterPath}`)
    let underRowsRead = 0
    let underImported = 0
    const underResult = await importBrregUnderenheterFromCacheTransactional(
      db,
      underenheterPath,
      filterEntity,
      {
        quiet: options.quiet,
        onRowsRead: (rowsRead) => {
          underRowsRead = rowsRead
          options.onBrregProgress?.({ phase: 'underenheter', rowsRead, imported: underImported })
        },
        onProgress: (imported) => {
          underImported = imported
          options.onBrregProgress?.({ phase: 'underenheter', rowsRead: underRowsRead, imported })
        },
      },
    )
    if (options.onBrregProgress) {
      options.onBrregProgress({
        phase: 'underenheter',
        rowsRead: options.nationalUnderenheterRows ?? underRowsRead,
        imported: underResult.scanned,
      })
    }
    imported += underResult.scanned
    if (!options.quiet) {
      console.log(`  ${underResult.scanned.toLocaleString('nb-NO')} underenheter importert`)
    }
  } else if (!options.quiet) {
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
  const enheterResult = await importBrregEnheterFromCacheTransactional(db, reference.enheterPath)
  console.log(`  Oppdatert ${enheterResult.scanned.toLocaleString('nb-NO')} enheter`)

  let imported = enheterResult.scanned
  if (options.skipUnderenheter) {
    console.log('Hopper over underenheter.')
  } else if (reference.underenheterPath) {
    console.log(`Backfill underenheter fra ${reference.underenheterPath}…`)
    const underResult = await importBrregUnderenheterFromCacheTransactional(
      db,
      reference.underenheterPath,
    )
    imported += underResult.scanned
    console.log(`  Importert/oppdatert ${underResult.scanned.toLocaleString('nb-NO')} underenheter`)
  }

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

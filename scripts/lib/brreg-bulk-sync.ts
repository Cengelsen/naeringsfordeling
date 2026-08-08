import { existsSync } from 'node:fs'
import type Database from 'better-sqlite3'
import {
  DEFAULT_REFERENCE_CACHE_DIR,
  ensureBrregReferenceCache,
  readReferenceManifest,
  sha256File,
} from './reference-cache.js'
import { getSyncState, setSyncState, beginBulkLoad, endBulkLoad } from './db.js'
import { loadBrregHashIndex, nullOrphanOverordnetEnhet } from './organizations.js'
import { importBrregFromGzip } from './brreg-import-pipeline.js'

const ENHETER_FILE_HASH_KEY = 'brreg_enheter_file_hash'
const UNDERENHETER_FILE_HASH_KEY = 'brreg_underenheter_file_hash'
const LAST_UPDATE_ID_KEY = 'last_oppdateringsid'
const LAST_UPDATE_ID_UNDERENHETER_KEY = 'last_oppdateringsid_underenheter'
const LAST_SYNC_AT_KEY = 'last_sync_at'

export interface SyncBrregFromBulkOptions {
  referenceCacheDir?: string
  skipUnderenheter?: boolean
  reuseDownloads?: boolean
  refreshDownloads?: boolean
  localOnly?: boolean
}

export interface SyncBrregFromBulkResult {
  skipped: boolean
  enheterChanged: number
  underenheterChanged: number
  enheterFileChanged: boolean
  underenheterFileChanged: boolean
}

function fileHashUnchanged(db: Database.Database, stateKey: string, fileHash: string): boolean {
  return getSyncState(db, stateKey) === fileHash
}

async function syncEnheterFile(
  db: Database.Database,
  gzipPath: string,
  fileHash: string,
): Promise<{ changed: number; fileChanged: boolean }> {
  if (fileHashUnchanged(db, ENHETER_FILE_HASH_KEY, fileHash)) {
    console.log('  BRREG enheter-fil uendret – hopper over import.')
    return { changed: 0, fileChanged: false }
  }

  console.log('  BRREG enheter-fil endret – synkroniserer diff fra lokal bulk…')
  beginBulkLoad(db)
  db.exec('BEGIN DEFERRED')
  try {
    const hashIndex = loadBrregHashIndex(db)
    const result = await importBrregFromGzip(db, gzipPath, {
      entityKind: 'enhet',
      hashIndex,
      deferParentLink: true,
    })

    nullOrphanOverordnetEnhet(db)
    setSyncState(db, ENHETER_FILE_HASH_KEY, fileHash)
    db.exec('COMMIT')
    return { changed: result.written, fileChanged: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    endBulkLoad(db)
  }
}

async function syncUnderenheterFile(
  db: Database.Database,
  gzipPath: string,
  fileHash: string,
): Promise<{ changed: number; fileChanged: boolean }> {
  if (fileHashUnchanged(db, UNDERENHETER_FILE_HASH_KEY, fileHash)) {
    console.log('  BRREG underenheter-fil uendret – hopper over import.')
    return { changed: 0, fileChanged: false }
  }

  console.log('  BRREG underenheter-fil endret – synkroniserer diff fra lokal bulk…')
  beginBulkLoad(db)
  db.exec('BEGIN DEFERRED')
  try {
    const hashIndex = loadBrregHashIndex(db)
    const result = await importBrregFromGzip(db, gzipPath, {
      entityKind: 'underenhet',
      hashIndex,
      deferParentLink: true,
    })

    nullOrphanOverordnetEnhet(db)
    setSyncState(db, UNDERENHETER_FILE_HASH_KEY, fileHash)
    db.exec('COMMIT')
    return { changed: result.written, fileChanged: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    endBulkLoad(db)
  }
}

export async function syncBrregFromBulkCache(
  db: Database.Database,
  options: SyncBrregFromBulkOptions = {},
): Promise<SyncBrregFromBulkResult> {
  const referenceCacheDir = options.referenceCacheDir ?? DEFAULT_REFERENCE_CACHE_DIR

  const reference = await ensureBrregReferenceCache(referenceCacheDir, {
    reuseDownloads: options.reuseDownloads ?? true,
    refreshDownloads: options.refreshDownloads ?? false,
    localOnly: options.localOnly ?? true,
    skipUnderenheter: options.skipUnderenheter,
  })

  const enheterPath = reference.enheterPath
  if (!existsSync(enheterPath)) {
    throw new Error(`Mangler lokal BRREG enheter-fil: ${enheterPath}`)
  }

  const enheterHash = sha256File(enheterPath)
  const enheterResult = await syncEnheterFile(db, enheterPath, enheterHash)

  let underenheterResult = { changed: 0, fileChanged: false }
  if (!options.skipUnderenheter && reference.underenheterPath && existsSync(reference.underenheterPath)) {
    const underHash = sha256File(reference.underenheterPath)
    underenheterResult = await syncUnderenheterFile(db, reference.underenheterPath, underHash)
  }

  if (enheterResult.fileChanged || underenheterResult.fileChanged) {
    const cleared = nullOrphanOverordnetEnhet(db)
    if (cleared > 0) {
      console.log(
        `  Nullstilte ${cleared.toLocaleString('nb-NO')} foreldreløse overordnet_enhet-referanser`,
      )
    }
  }

  const manifest = readReferenceManifest(referenceCacheDir)
  if (manifest.last_oppdateringsid) {
    setSyncState(db, LAST_UPDATE_ID_KEY, manifest.last_oppdateringsid)
  }
  if (manifest.last_oppdateringsid_underenheter) {
    setSyncState(db, LAST_UPDATE_ID_UNDERENHETER_KEY, manifest.last_oppdateringsid_underenheter)
  }

  if (enheterResult.changed > 0 || underenheterResult.changed > 0) {
    setSyncState(db, LAST_SYNC_AT_KEY, new Date().toISOString())
  }

  const skipped =
    !enheterResult.fileChanged &&
    !underenheterResult.fileChanged &&
    enheterResult.changed === 0 &&
    underenheterResult.changed === 0

  return {
    skipped,
    enheterChanged: enheterResult.changed,
    underenheterChanged: underenheterResult.changed,
    enheterFileChanged: enheterResult.fileChanged,
    underenheterFileChanged: underenheterResult.fileChanged,
  }
}

export function kartverketZipHashUnchanged(
  db: Database.Database,
  zipPath: string,
  stateKey = 'kartverket_zip_file_hash',
): boolean {
  if (!existsSync(zipPath)) return false
  const fileHash = sha256File(zipPath)
  return fileHashUnchanged(db, stateKey, fileHash)
}

export function rememberKartverketZipHash(
  db: Database.Database,
  zipPath: string,
  stateKey = 'kartverket_zip_file_hash',
): void {
  setSyncState(db, stateKey, sha256File(zipPath))
}

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import {
  backfillMetadataFromKartverketBulk,
  geocodeAllFromKartverketBulk,
} from './local-geocode.js'
import {
  countPendingGeocodeWithPostnummer,
  getStats,
  openDatabase,
  rebuildOrgsRtree,
  removeDatabaseFiles,
  setSyncState,
} from './db.js'
import {
  DEFAULT_REFERENCE_CACHE_DIR,
  describeReferenceCache,
  ensureBrregReferenceCache,
  importBrregEnheterFromCacheTransactional,
  importBrregUnderenheterFromCacheTransactional,
  nationalKartverketZipPath,
  refreshReferenceFileHashes,
  sha256File,
  writeReferenceManifest,
} from './reference-cache.js'
import {
  describeKartverketCache,
  downloadNationalKartverketCsv,
  ensureKartverketSchema,
  kartverketAddressCount,
} from './kartverket-bulk.js'
import {
  kartverketZipHashUnchanged,
  rememberKartverketZipHash,
  syncBrregFromBulkCache,
} from './brreg-bulk-sync.js'

const REPO_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)))

export interface NationalBuildOptions {
  output: string
  fresh?: boolean
  skipBrreg?: boolean
  skipKartverket?: boolean
  skipGeocode?: boolean
  skipUnderenheter?: boolean
  reuseDownloads?: boolean
  refreshDownloads?: boolean
  metadataOnly?: boolean
  referenceCacheDir?: string
  parallel?: boolean
}

function runTaskScript(scriptName: string, args: string[]): Promise<void> {
  const tsxPath = join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
  return new Promise((resolve, reject) => {
    const child = spawn(tsxPath, [join(REPO_ROOT, 'scripts/tasks', scriptName), ...args], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: process.env,
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${scriptName} avsluttet med status ${code ?? 1}`))
    })
  })
}

function attachAndCopyKartverket(targetDb: Database.Database, kartverketDbPath: string) {
  ensureKartverketSchema(targetDb)
  const escaped = kartverketDbPath.replace(/\\/g, '/').replace(/'/g, "''")
  targetDb.exec(`ATTACH DATABASE '${escaped}' AS kartverket_src`)
  try {
    targetDb.exec('DELETE FROM kartverket_addresses')
    targetDb.exec(`
      INSERT INTO kartverket_addresses
      SELECT * FROM kartverket_src.kartverket_addresses
    `)
  } finally {
    targetDb.exec('DETACH DATABASE kartverket_src')
  }
}

async function importBrregNationwide(
  db: Database.Database,
  referenceCacheDir: string,
  options: Pick<NationalBuildOptions, 'skipUnderenheter' | 'reuseDownloads' | 'refreshDownloads'>,
): Promise<number> {
  console.log('\nSteg 2/4: Importerer BRREG fra referansecache…')

  const reference = await ensureBrregReferenceCache(referenceCacheDir, {
    reuseDownloads: options.reuseDownloads,
    refreshDownloads: options.refreshDownloads,
    skipUnderenheter: options.skipUnderenheter,
  })

  console.log(`  Enheter fra ${reference.enheterPath}…`)
  const enheterResult = await importBrregEnheterFromCacheTransactional(db, reference.enheterPath)
  let imported = enheterResult.scanned
  console.log(`  ${imported.toLocaleString('nb-NO')} enheter importert`)

  let importedUnder = 0
  if (options.skipUnderenheter) {
    console.log('  Underenheter hoppet over (--skip-underenheter).')
  } else if (reference.underenheterPath) {
    console.log(`  Underenheter fra ${reference.underenheterPath}…`)
    const underResult = await importBrregUnderenheterFromCacheTransactional(
      db,
      reference.underenheterPath,
    )
    importedUnder = underResult.scanned
    console.log(`  ${importedUnder.toLocaleString('nb-NO')} underenheter importert`)
  }

  imported += importedUnder

  const manifest = reference.manifest
  if (manifest.last_oppdateringsid) {
    setSyncState(db, 'last_oppdateringsid', manifest.last_oppdateringsid)
  }
  if (manifest.last_oppdateringsid_underenheter) {
    setSyncState(db, 'last_oppdateringsid_underenheter', manifest.last_oppdateringsid_underenheter)
  }

  refreshReferenceFileHashes(referenceCacheDir)
  setSyncState(db, 'brreg_enheter_file_hash', sha256File(reference.enheterPath))
  if (reference.underenheterPath) {
    setSyncState(db, 'brreg_underenheter_file_hash', sha256File(reference.underenheterPath))
  }

  setSyncState(db, 'last_full_sync_at', new Date().toISOString())
  setSyncState(db, 'last_backfill_at', new Date().toISOString())
  setSyncState(db, 'build_source', 'build-national-db')

  return imported
}

async function runParallelFreshImport(
  outputPath: string,
  options: NationalBuildOptions,
): Promise<Database.Database> {
  const referenceCacheDir = options.referenceCacheDir ?? DEFAULT_REFERENCE_CACHE_DIR
  const kartverketCacheDir = process.env.KARTVERKET_CACHE_DIR ?? join(referenceCacheDir, 'kartverket')
  const stagingDir = join(dirname(outputPath), '.national-build-staging')
  mkdirSync(stagingDir, { recursive: true })

  const kartverketStagingPath = join(stagingDir, 'kartverket-staging.db')
  const orgsStagingPath = join(stagingDir, 'orgs-staging.db')

  removeDatabaseFiles(kartverketStagingPath)
  removeDatabaseFiles(orgsStagingPath)

  console.log('\nSteg 1–2/4: Parallell nedlasting og import (Kartverket + BRREG)…')

  await ensureBrregReferenceCache(referenceCacheDir, {
    reuseDownloads: options.reuseDownloads,
    refreshDownloads: options.refreshDownloads,
    skipUnderenheter: options.skipUnderenheter,
  })

  const kartverketZipPromise = options.skipKartverket
    ? Promise.resolve(null)
    : downloadNationalKartverketCsv({
        cacheDir: kartverketCacheDir,
        reuseDownload: options.reuseDownloads,
      })

  const kartverketZipPath = await kartverketZipPromise

  const taskArgs = [
    `--output=${kartverketStagingPath}`,
    `--cache-dir=${referenceCacheDir}`,
    `--kartverket-cache-dir=${kartverketCacheDir}`,
  ]
  if (kartverketZipPath) taskArgs.push(`--zip=${kartverketZipPath}`)
  if (options.refreshDownloads) taskArgs.push('--refresh-downloads')

  const brregArgs = [
    `--output=${orgsStagingPath}`,
    `--cache-dir=${referenceCacheDir}`,
  ]
  if (options.skipUnderenheter) brregArgs.push('--skip-underenheter')
  if (options.refreshDownloads) brregArgs.push('--refresh-downloads')

  const parallelTasks: Promise<void>[] = []
  if (!options.skipKartverket) {
    parallelTasks.push(runTaskScript('import-kartverket-national.ts', taskArgs))
  }
  if (!options.skipBrreg) {
    parallelTasks.push(runTaskScript('import-brreg-national.ts', brregArgs))
  }

  await Promise.all(parallelTasks)

  removeDatabaseFiles(outputPath)
  renameSync(orgsStagingPath, outputPath)

  const db = openDatabase(outputPath, { runBackfill: true })

  if (!options.skipKartverket) {
    console.log('\nFletter Kartverket-staging inn i nasjonal database…')
    attachAndCopyKartverket(db, kartverketStagingPath)
    writeReferenceManifest(referenceCacheDir, {
      kartverket_national_cached_at: new Date().toISOString(),
    })
    refreshReferenceFileHashes(referenceCacheDir)
    if (kartverketZipPath) rememberKartverketZipHash(db, kartverketZipPath)
    setSyncState(db, 'kartverket_bulk_imported_at', new Date().toISOString())
  }

  rmSync(stagingDir, { recursive: true, force: true })
  setSyncState(db, 'build_source', 'build-national-db')
  return db
}

async function runSequentialImport(
  db: Database.Database,
  options: NationalBuildOptions,
): Promise<void> {
  const referenceCacheDir = options.referenceCacheDir ?? DEFAULT_REFERENCE_CACHE_DIR
  const kartverketCacheDir = process.env.KARTVERKET_CACHE_DIR ?? join(referenceCacheDir, 'kartverket')

  if (!options.skipKartverket) {
    const zipPath = nationalKartverketZipPath(referenceCacheDir)
    const canSkipKartverket =
      !options.fresh &&
      existsSync(zipPath) &&
      kartverketZipHashUnchanged(db, zipPath) &&
      kartverketAddressCount(db) > 0

    if (canSkipKartverket) {
      console.log('\nSteg 1/4: Kartverket zip uendret – gjenbruker eksisterende adresser.')
    } else {
      console.log('\nSteg 1/4: Kartverket Adresse (bulk CSV, hele landet)…')
      const { downloadAndImportNationalKartverket } = await import('./kartverket-bulk.js')
      await downloadAndImportNationalKartverket(db, {
        cacheDir: kartverketCacheDir,
        reuseDownload: options.reuseDownloads,
        clearExisting: true,
      })
      writeReferenceManifest(referenceCacheDir, {
        kartverket_national_cached_at: new Date().toISOString(),
      })
      refreshReferenceFileHashes(referenceCacheDir)
      rememberKartverketZipHash(db, nationalKartverketZipPath(referenceCacheDir))
      setSyncState(db, 'kartverket_bulk_imported_at', new Date().toISOString())
    }
  } else {
    console.log('\nSteg 1/4: Hopper over Kartverket-nedlasting (--skip-kartverket).')
    const existing = kartverketAddressCount(db)
    if (existing === 0) {
      throw new Error(
        'Ingen Kartverket-adresser i databasen. Fjern --skip-kartverket eller importer Kartverket først.',
      )
    }
    console.log(`  Bruker ${existing.toLocaleString('nb-NO')} eksisterende Kartverket-rader.`)
  }

  if (!options.skipBrreg) {
    if (options.fresh) {
      await importBrregNationwide(db, referenceCacheDir, {
        skipUnderenheter: options.skipUnderenheter,
        reuseDownloads: options.reuseDownloads,
        refreshDownloads: options.refreshDownloads,
      })
    } else {
      console.log('\nSteg 2/4: Synkroniserer BRREG fra lokal bulk (diff)…')
      const result = await syncBrregFromBulkCache(db, {
        referenceCacheDir,
        skipUnderenheter: options.skipUnderenheter,
        reuseDownloads: options.reuseDownloads,
        refreshDownloads: options.refreshDownloads,
        localOnly: true,
      })
      if (result.skipped) {
        console.log('  Ingen BRREG-endringer i referansecache.')
      } else {
        console.log(
          `  Oppdatert ${result.enheterChanged.toLocaleString('nb-NO')} enheter, ${result.underenheterChanged.toLocaleString('nb-NO')} underenheter`,
        )
      }
      setSyncState(db, 'build_source', 'build-national-db')
    }
  } else {
    console.log('\nSteg 2/4: Hopper over BRREG-import (--skip-brreg).')
    const total = getStats(db).total
    if (total === 0) {
      console.log('  Ingen organisasjoner i databasen.')
    } else {
      console.log(`  ${total.toLocaleString('nb-NO')} eksisterende organisasjoner.`)
    }
  }
}

async function runGeocodeStep(db: Database.Database, options: NationalBuildOptions) {
  if (options.skipGeocode) {
    console.log('\nSteg 3/4: Hopper over geokoding (--skip-geocode).')
    return
  }

  console.log('\nSteg 3/4: Geokoder organisasjoner mot lokal Kartverket-database (ingen API)…')
  if (options.metadataOnly) {
    await backfillMetadataFromKartverketBulk(db)
  } else {
    await geocodeAllFromKartverketBulk(db)
    await backfillMetadataFromKartverketBulk(db)

    const pendingWithPostnummer = countPendingGeocodeWithPostnummer(db)
    const pendingTotal = getStats(db).pending_geocode
    if (pendingWithPostnummer > 0) {
      console.warn(
        `\nAdvarsel: ${pendingWithPostnummer.toLocaleString('nb-NO')} organisasjoner med postnummer mangler fortsatt koordinater etter lokal geokoding.`,
      )
    }
    if (pendingTotal > pendingWithPostnummer) {
      console.warn(
        `  ${(pendingTotal - pendingWithPostnummer).toLocaleString('nb-NO')} organisasjoner uten postnummer kan ikke geokodes lokalt.`,
      )
    }
  }
}

export async function buildNationalDatabase(options: NationalBuildOptions) {
  const referenceCacheDir = options.referenceCacheDir ?? DEFAULT_REFERENCE_CACHE_DIR
  const kartverketCacheDir = process.env.KARTVERKET_CACHE_DIR ?? join(referenceCacheDir, 'kartverket')
  const useParallel =
    options.parallel !== false &&
    options.fresh &&
    !options.skipBrreg &&
    !options.skipKartverket

  if (options.fresh && existsSync(options.output)) {
    console.log(`Sletter eksisterende database: ${options.output}`)
    removeDatabaseFiles(options.output)
  }

  console.log('Bygger nasjonal SQLite-database')
  console.log(`  Output: ${options.output}`)
  console.log(`  Referansecache: ${describeReferenceCache(referenceCacheDir)}`)
  console.log(`  Kartverket-cache: ${describeKartverketCache(kartverketCacheDir)}`)
  console.log(`  Modus: ${options.fresh ? 'full import (--fresh)' : 'lokal bulk-diff'}`)
  console.log(`  Parallell import: ${useParallel ? 'ja' : 'nei'}`)
  console.log('Kilder: lokale BRREG/Kartverket-filer (nedlastes kun ved manglende cache)')

  let db: Database.Database | undefined

  try {
    if (useParallel) {
      db = await runParallelFreshImport(options.output, options)
    } else {
      db = openDatabase(options.output, { runBackfill: true })
      await runSequentialImport(db, options)
    }

    await runGeocodeStep(db, options)
    console.log('\nSteg 4/4: Bygger spatialt indeks (R-tree)…')
    rebuildOrgsRtree(db)
    setSyncState(db, 'last_sync_at', new Date().toISOString())
  } catch (error) {
    db?.close()
    throw error
  }

  const stats = getStats(db)
  const kartverketCount = kartverketAddressCount(db)

  console.log('\nFerdig. Database status:')
  console.log(`  Fil: ${options.output}`)
  console.log(`  Referansecache: ${referenceCacheDir}`)
  console.log(`  Kartverket-adresser: ${kartverketCount.toLocaleString('nb-NO')}`)
  console.log(`  Organisasjoner totalt: ${stats.total.toLocaleString('nb-NO')}`)
  console.log(`  Enheter: ${(stats.enheter ?? 0).toLocaleString('nb-NO')}`)
  console.log(`  Underenheter: ${(stats.underenheter ?? 0).toLocaleString('nb-NO')}`)
  console.log(`  Aktive: ${(stats.active ?? 0).toLocaleString('nb-NO')}`)
  console.log(`  Geokodet: ${(stats.geocoded ?? 0).toLocaleString('nb-NO')}`)
  console.log(`  Venter geokoding: ${(stats.pending_geocode ?? 0).toLocaleString('nb-NO')}`)
  console.log(
    `  Uten koordinat (med postnummer): ${countPendingGeocodeWithPostnummer(db).toLocaleString('nb-NO')}`,
  )
  console.log(`  R-tree-punkter: ${(stats.rtree ?? 0).toLocaleString('nb-NO')}`)

  db.close()
}

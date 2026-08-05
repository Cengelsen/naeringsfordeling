#!/usr/bin/env node
/**
 * Build a single SQLite database with nationwide BRREG + Kartverket data.
 *
 * Reference data (Kartverket CSV zip + BRREG bulk gzip) is cached under
 * data/cache/reference/ so later builds can run offline without re-downloading.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  describeKartverketCache,
  downloadAndImportNationalKartverket,
  kartverketAddressCount,
} from './lib/kartverket-bulk.js'
import {
  backfillMetadataFromKartverketBulk,
  geocodeAllFromKartverketBulk,
} from './lib/local-geocode.js'
import {
  getStats,
  openDatabase,
  rebuildOrgsRtree,
  removeDatabaseFiles,
  setSyncState,
} from './lib/db.js'
import {
  DEFAULT_REFERENCE_CACHE_DIR,
  describeReferenceCache,
  ensureBrregReferenceCache,
  importBrregEnheterFromCache,
  importBrregUnderenheterFromCache,
  writeReferenceManifest,
} from './lib/reference-cache.js'
import { upsertEntity, upsertUnderenhet } from './lib/organizations.js'

const NATIONAL_DB_PATH = process.env.NATIONAL_DB_PATH ?? 'data/norway.db'

function parseArgs(argv: string[]) {
  const outputArg = argv.find((arg) => arg.startsWith('--output='))?.split('=')[1]
  const cacheDirArg = argv.find((arg) => arg.startsWith('--cache-dir='))?.split('=')[1]
  const refreshDownloads = argv.includes('--refresh-downloads')

  return {
    fresh: argv.includes('--fresh'),
    output: outputArg ?? process.env.DATABASE_PATH ?? NATIONAL_DB_PATH,
    skipBrreg: argv.includes('--skip-brreg'),
    skipKartverket: argv.includes('--skip-kartverket'),
    skipGeocode: argv.includes('--skip-geocode'),
    skipUnderenheter: argv.includes('--skip-underenheter'),
    refreshDownloads,
    reuseDownloads: !refreshDownloads,
    metadataOnly: argv.includes('--metadata-only'),
    referenceCacheDir: cacheDirArg ?? DEFAULT_REFERENCE_CACHE_DIR,
  }
}

async function importBrregNationwide(
  db: ReturnType<typeof openDatabase>,
  referenceCacheDir: string,
  options: {
    skipUnderenheter: boolean
    reuseDownloads: boolean
    refreshDownloads: boolean
  },
): Promise<number> {
  console.log('\nSteg 2/4: Importerer BRREG fra referansecache…')

  const reference = await ensureBrregReferenceCache(referenceCacheDir, {
    reuseDownloads: options.reuseDownloads,
    refreshDownloads: options.refreshDownloads,
    skipUnderenheter: options.skipUnderenheter,
  })

  let imported = 0
  console.log(`  Enheter fra ${reference.enheterPath}…`)
  await importBrregEnheterFromCache(reference.enheterPath, async (entity) => {
    upsertEntity(db, entity, Boolean(entity.slettedato))
    imported += 1
  })
  console.log(`  ${imported.toLocaleString('nb-NO')} enheter importert`)

  let importedUnder = 0
  if (options.skipUnderenheter) {
    console.log('  Underenheter hoppet over (--skip-underenheter).')
  } else if (reference.underenheterPath) {
    console.log(`  Underenheter fra ${reference.underenheterPath}…`)
    await importBrregUnderenheterFromCache(reference.underenheterPath, async (entity) => {
      upsertUnderenhet(db, entity, Boolean(entity.slettedato))
      importedUnder += 1
    })
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

  setSyncState(db, 'last_full_sync_at', new Date().toISOString())
  setSyncState(db, 'last_backfill_at', new Date().toISOString())
  setSyncState(db, 'build_source', 'build-national-db')

  return imported
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const kartverketCacheDir =
    process.env.KARTVERKET_CACHE_DIR ?? join(args.referenceCacheDir, 'kartverket')

  if (args.fresh && existsSync(args.output)) {
    console.log(`Sletter eksisterende database: ${args.output}`)
    removeDatabaseFiles(args.output)
  }

  const db = openDatabase(args.output, { runBackfill: true })

  console.log('Bygger nasjonal SQLite-database')
  console.log(`  Output: ${args.output}`)
  console.log(`  Referansecache: ${describeReferenceCache(args.referenceCacheDir)}`)
  console.log(`  Kartverket-cache: ${describeKartverketCache(kartverketCacheDir)}`)
  console.log('Kilder: lokale BRREG/Kartverket-filer (nedlastes kun ved manglende cache)')

  if (!args.skipKartverket) {
    console.log('\nSteg 1/4: Kartverket Adresse (bulk CSV, hele landet)…')
    await downloadAndImportNationalKartverket(db, {
      cacheDir: kartverketCacheDir,
      reuseDownload: args.reuseDownloads,
      clearExisting: true,
    })
    writeReferenceManifest(args.referenceCacheDir, {
      kartverket_national_cached_at: new Date().toISOString(),
    })
    setSyncState(db, 'kartverket_bulk_imported_at', new Date().toISOString())
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

  if (!args.skipBrreg) {
    await importBrregNationwide(db, args.referenceCacheDir, {
      skipUnderenheter: args.skipUnderenheter,
      reuseDownloads: args.reuseDownloads,
      refreshDownloads: args.refreshDownloads,
    })
  } else {
    console.log('\nSteg 2/4: Hopper over BRREG-import (--skip-brreg).')
    const total = getStats(db).total
    if (total === 0) {
      console.log('  Ingen organisasjoner i databasen.')
    } else {
      console.log(`  ${total.toLocaleString('nb-NO')} eksisterende organisasjoner.`)
    }
  }

  if (!args.skipGeocode) {
    console.log('\nSteg 3/4: Geokoder organisasjoner mot lokal Kartverket-database (ingen API)…')
    if (args.metadataOnly) {
      await backfillMetadataFromKartverketBulk(db)
    } else {
      await geocodeAllFromKartverketBulk(db)
      await backfillMetadataFromKartverketBulk(db)
    }
  } else {
    console.log('\nSteg 3/4: Hopper over geokoding (--skip-geocode).')
  }

  console.log('\nSteg 4/4: Bygger spatialt indeks (R-tree)…')
  rebuildOrgsRtree(db)
  setSyncState(db, 'last_sync_at', new Date().toISOString())

  const stats = getStats(db)
  const kartverketCount = kartverketAddressCount(db)

  console.log('\nFerdig. Database status:')
  console.log(`  Fil: ${args.output}`)
  console.log(`  Referansecache: ${args.referenceCacheDir}`)
  console.log(`  Kartverket-adresser: ${kartverketCount.toLocaleString('nb-NO')}`)
  console.log(`  Organisasjoner totalt: ${stats.total.toLocaleString('nb-NO')}`)
  console.log(`  Enheter: ${(stats.enheter ?? 0).toLocaleString('nb-NO')}`)
  console.log(`  Underenheter: ${(stats.underenheter ?? 0).toLocaleString('nb-NO')}`)
  console.log(`  Aktive: ${(stats.active ?? 0).toLocaleString('nb-NO')}`)
  console.log(`  Geokodet: ${(stats.geocoded ?? 0).toLocaleString('nb-NO')}`)
  console.log(`  Venter geokoding: ${(stats.pending_geocode ?? 0).toLocaleString('nb-NO')}`)
  console.log(`  R-tree-punkter: ${(stats.rtree ?? 0).toLocaleString('nb-NO')}`)

  db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

#!/usr/bin/env node
/**
 * Build a single SQLite database with nationwide BRREG + Kartverket data.
 *
 * 1. Download Kartverket Matrikkelen Adresse (CSV, EPSG:4258) for all of Norway
 * 2. Download BRREG bulk (enheter + underenheter)
 * 3. Geocode organizations against the local Kartverket table (no live API calls)
 */
import { existsSync } from 'node:fs'
import {
  DEFAULT_KARTVERKET_CACHE_DIR,
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
  downloadBulkEntities,
  downloadBulkUnderenheter,
  fetchLatestUpdateId,
  fetchLatestUpdateIdUnderenheter,
} from './lib/brreg.js'
import { upsertEntity, upsertUnderenhet } from './lib/organizations.js'

const NATIONAL_DB_PATH = process.env.NATIONAL_DB_PATH ?? 'data/norway.db'

function parseArgs(argv: string[]) {
  const outputArg = argv.find((arg) => arg.startsWith('--output='))?.split('=')[1]
  const cacheDirArg = argv.find((arg) => arg.startsWith('--cache-dir='))?.split('=')[1]

  return {
    fresh: argv.includes('--fresh'),
    output: outputArg ?? process.env.DATABASE_PATH ?? NATIONAL_DB_PATH,
    skipBrreg: argv.includes('--skip-brreg'),
    skipKartverket: argv.includes('--skip-kartverket'),
    skipGeocode: argv.includes('--skip-geocode'),
    skipUnderenheter: argv.includes('--skip-underenheter'),
    reuseDownloads: argv.includes('--reuse-downloads'),
    metadataOnly: argv.includes('--metadata-only'),
    cacheDir: cacheDirArg ?? DEFAULT_KARTVERKET_CACHE_DIR,
  }
}

async function importBrregNationwide(
  db: ReturnType<typeof openDatabase>,
  skipUnderenheter: boolean,
): Promise<number> {
  console.log('\nSteg 2/4: Importerer BRREG bulk (hele landet)…')

  let imported = 0
  console.log('  Enheter…')
  await downloadBulkEntities(async (entity) => {
    upsertEntity(db, entity, Boolean(entity.slettedato))
    imported += 1
  })
  console.log(`  ${imported.toLocaleString('nb-NO')} enheter importert`)

  let importedUnder = 0
  if (skipUnderenheter) {
    console.log('  Underenheter hoppet over (--skip-underenheter).')
  } else {
    console.log('  Underenheter…')
    await downloadBulkUnderenheter(async (entity) => {
      upsertUnderenhet(db, entity, Boolean(entity.slettedato))
      importedUnder += 1
    })
    console.log(`  ${importedUnder.toLocaleString('nb-NO')} underenheter importert`)
  }

  imported += importedUnder

  const latestId = await fetchLatestUpdateId()
  if (latestId > 0) {
    setSyncState(db, 'last_oppdateringsid', String(latestId))
  }

  const latestUnderId = await fetchLatestUpdateIdUnderenheter()
  if (latestUnderId > 0) {
    setSyncState(db, 'last_oppdateringsid_underenheter', String(latestUnderId))
  }

  setSyncState(db, 'last_full_sync_at', new Date().toISOString())
  setSyncState(db, 'last_backfill_at', new Date().toISOString())
  setSyncState(db, 'build_source', 'build-national-db')

  return imported
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.fresh && existsSync(args.output)) {
    console.log(`Sletter eksisterende database: ${args.output}`)
    removeDatabaseFiles(args.output)
  }

  const db = openDatabase(args.output)

  console.log('Bygger nasjonal SQLite-database')
  console.log(`  Output: ${args.output}`)
  console.log(`  Kartverket-cache: ${describeKartverketCache(args.cacheDir)}`)
  console.log('Kilder: BRREG bulk + Kartverket Matrikkelen Adresse (CSV bulk)')

  if (!args.skipKartverket) {
    console.log('\nSteg 1/4: Kartverket Adresse (bulk CSV, hele landet)…')
    await downloadAndImportNationalKartverket(db, {
      cacheDir: args.cacheDir,
      reuseDownload: args.reuseDownloads,
      clearExisting: true,
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
    await importBrregNationwide(db, args.skipUnderenheter)
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
    console.log('\nSteg 3/4: Geokoder organisasjoner mot lokal Kartverket-database…')
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

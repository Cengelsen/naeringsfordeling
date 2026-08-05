#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { openDatabase, DEFAULT_DB_PATH, removeDatabaseFiles } from './lib/db.js'
import { LIMITS } from './lib/rate-limit.js'
import { DEV_GEOCODE_MAX, devGeocodeOptions, devImportLabel, runBuildDatabase } from './lib/sync.js'

function parseStringArg(argv: string[], name: string, envKey: string): string | undefined {
  const prefix = `--${name}=`
  const fromArg = argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  return fromArg || process.env[envKey] || undefined
}

function parseArgs(argv: string[]) {
  const dev = argv.includes('--dev')
  const geocodeAll = argv.includes('--geocode-all')
  const devGeocode = dev ? devGeocodeOptions(geocodeAll) : null

  return {
    fresh: argv.includes('--fresh'),
    backfill: argv.includes('--backfill'),
    skipUnderenheterBackfill: argv.includes('--skip-underenheter-backfill'),
    regeocodeMetadata: argv.includes('--regeocode-metadata'),
    allowApi: argv.includes('--allow-api'),
    refreshDownloads: argv.includes('--refresh-downloads'),
    dev,
    devFylke: parseStringArg(argv, 'fylke', 'SYNC_DEV_FYLKE'),
    nationalDbPath: parseStringArg(argv, 'national-db', 'NATIONAL_DB_PATH'),
    geocodeAll,
    skipGeocode: argv.includes('--skip-geocode'),
    geocodeLimit: Number(
      argv.find((arg) => arg.startsWith('--geocode-limit='))?.split('=')[1] ??
        devGeocode?.geocodeLimit ??
        LIMITS.geocodeBatchSize,
    ),
    maxGeocodeRounds: Number(
      argv.find((arg) => arg.startsWith('--max-rounds='))?.split('=')[1] ??
        process.env.BUILD_DB_MAX_ROUNDS ??
        devGeocode?.maxGeocodeRounds ??
        10_000,
    ),
    maxGeocodeAddresses: geocodeAll
      ? undefined
      : Number(process.env.BUILD_DB_MAX_GEOCODE_ADDRESSES ?? '') ||
        devGeocode?.maxGeocodeAddresses ||
        undefined,
  }
}

function validateArgs(args: ReturnType<typeof parseArgs>) {
  if (args.fresh && args.backfill) {
    throw new Error('--fresh og --backfill kan ikke kombineres (--fresh sletter databasen først)')
  }
  if (args.geocodeAll && !args.dev) {
    throw new Error('--geocode-all krever --dev')
  }
  if (args.geocodeAll && !args.devFylke) {
    throw new Error('--geocode-all krever --fylke=XX (tosifret fylkeskode)')
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  validateArgs(args)
  const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH

  if (args.fresh) {
    console.log(`Sletter eksisterende database: ${dbPath}`)
    removeDatabaseFiles(dbPath)
  }

  const db = openDatabase(dbPath, { runBackfill: true })

  console.log(`Bygger SQLite-database: ${dbPath}`)
  console.log('Kilder: norway.db → BRREG referansecache → API (kun med --allow-api)')
  const modus = args.dev
    ? `dev-import (${devImportLabel(args.devFylke)}${args.geocodeAll ? ', geokoder alle adresser' : `, geokoder ${DEV_GEOCODE_MAX}`})`
    : args.backfill
      ? args.devFylke != null || args.dev
        ? `backfill (${devImportLabel(args.devFylke)})`
        : 'backfill (hele landet)'
      : args.fresh || !existsSync(dbPath)
        ? 'full import'
        : 'oppdater + geokode rest'
  console.log('Modus:', modus)

  await runBuildDatabase(db, {
    fresh: args.fresh,
    backfill: args.backfill,
    skipUnderenheterBackfill: args.skipUnderenheterBackfill,
    regeocodeMetadata: args.regeocodeMetadata,
    allowApi: args.allowApi,
    refreshDownloads: args.refreshDownloads,
    nationalDbPath: args.nationalDbPath,
    dev: args.dev,
    devFylke: args.devFylke,
    geocodeAll: args.geocodeAll,
    skipGeocode: args.skipGeocode,
    geocodeLimit: args.geocodeLimit,
    maxGeocodeRounds: args.maxGeocodeRounds,
    maxGeocodeAddresses: args.maxGeocodeAddresses,
  })

  db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

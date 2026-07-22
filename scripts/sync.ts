#!/usr/bin/env node
import { openDatabase, DEFAULT_DB_PATH } from './lib/db.js'
import { DEV_GEOCODE_MAX, devGeocodeOptions, devImportLabel, runSync } from './lib/sync.js'

function parseStringArg(argv: string[], name: string, envKey: string): string | undefined {
  const prefix = `--${name}=`
  const fromArg = argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  return fromArg || process.env[envKey] || undefined
}

function parseArgs(argv: string[]) {
  const dev = argv.includes('--dev')
  const geocodeAll = argv.includes('--geocode-all')
  const devGeocode = dev || geocodeAll ? devGeocodeOptions(geocodeAll) : null

  return {
    full: argv.includes('--full'),
    backfill: argv.includes('--backfill'),
    skipUnderenheterBackfill: argv.includes('--skip-underenheter-backfill'),
    regeocodeMetadata: argv.includes('--regeocode-metadata'),
    dev,
    devFylke: parseStringArg(argv, 'fylke', 'SYNC_DEV_FYLKE'),
    geocodeAll,
    geocodeOnly: argv.includes('--geocode-only'),
    geocodeLimit: Number(
      argv.find((arg) => arg.startsWith('--geocode-limit='))?.split('=')[1] ??
        process.env.SYNC_GEOCODE_LIMIT ??
        devGeocode?.geocodeLimit ??
        10_000,
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
  if (args.full && args.backfill) {
    throw new Error('--full og --backfill er redundant – bruk bare --backfill')
  }
  if (args.geocodeAll && !args.dev && !args.geocodeOnly) {
    throw new Error('--geocode-all krever --dev eller --geocode-only')
  }
  if (args.geocodeAll && !args.devFylke && args.dev) {
    throw new Error('--geocode-all med --dev krever --fylke=XX (tosifret fylkeskode)')
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  validateArgs(args)
  const db = openDatabase()

  console.log(`Synkroniserer database: ${DEFAULT_DB_PATH}`)
  const mode = args.geocodeOnly
    ? args.geocodeAll
      ? 'kun geokoding (alle adresser)'
      : 'kun geokoding'
    : args.dev
      ? args.devFylke
        ? `dev-import (fylke ${args.devFylke}${args.geocodeAll ? ', alle adresser' : ''})`
        : 'dev-import'
      : args.backfill
        ? args.devFylke != null || args.dev
          ? `backfill (${devImportLabel(args.devFylke)})`
          : 'backfill (hele landet)'
        : args.full
          ? 'full import'
          : 'inkrementell'
  console.log(`Modus: ${mode}`)

  await runSync(db, {
    full: args.full,
    backfill: args.backfill,
    skipUnderenheterBackfill: args.skipUnderenheterBackfill,
    regeocodeMetadata: args.regeocodeMetadata,
    dev: args.dev,
    devFylke: args.devFylke,
    geocodeAll: args.geocodeAll,
    geocodeOnly: args.geocodeOnly,
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

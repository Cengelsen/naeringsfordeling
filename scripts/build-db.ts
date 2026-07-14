#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { openDatabase, DEFAULT_DB_PATH, removeDatabaseFiles } from './lib/db.js'
import { LIMITS } from './lib/rate-limit.js'
import { runBuildDatabase } from './lib/sync.js'

function parseArgs(argv: string[]) {
  return {
    fresh: argv.includes('--fresh'),
    skipGeocode: argv.includes('--skip-geocode'),
    geocodeLimit: Number(
      argv.find((arg) => arg.startsWith('--geocode-limit='))?.split('=')[1] ??
        LIMITS.geocodeBatchSize,
    ),
    maxGeocodeRounds: Number(
      argv.find((arg) => arg.startsWith('--max-rounds='))?.split('=')[1] ??
        process.env.BUILD_DB_MAX_ROUNDS ??
        10000,
    ),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH

  if (args.fresh) {
    console.log(`Sletter eksisterende database: ${dbPath}`)
    removeDatabaseFiles(dbPath)
  }

  const db = openDatabase(dbPath)

  console.log(`Bygger SQLite-database: ${dbPath}`)
  console.log('Kilder: BRREG bulk/oppdateringer + Kartverket Adresse-API')
  console.log('Modus:', args.fresh || !existsSync(dbPath) ? 'full import' : 'oppdater + geokode rest')

  await runBuildDatabase(db, {
    fresh: args.fresh,
    skipGeocode: args.skipGeocode,
    geocodeLimit: args.geocodeLimit,
    maxGeocodeRounds: args.maxGeocodeRounds,
  })

  db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

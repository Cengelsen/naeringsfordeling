#!/usr/bin/env node
import { openDatabase, DEFAULT_DB_PATH } from './lib/db.js'
import { runSync } from './lib/sync.js'

function parseArgs(argv: string[]) {
  return {
    full: argv.includes('--full'),
    dev: argv.includes('--dev'),
    geocodeOnly: argv.includes('--geocode-only'),
    geocodeLimit: Number(
      argv.find((arg) => arg.startsWith('--geocode-limit='))?.split('=')[1] ??
        process.env.SYNC_GEOCODE_LIMIT ??
        10000,
    ),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const db = openDatabase()

  console.log(`Synkroniserer database: ${DEFAULT_DB_PATH}`)
  const mode = args.geocodeOnly
    ? 'kun geokoding'
    : args.dev
      ? 'dev-import'
      : args.full
        ? 'full import'
        : 'inkrementell'
  console.log(`Modus: ${mode}`)

  await runSync(db, {
    full: args.full,
    dev: args.dev,
    geocodeOnly: args.geocodeOnly,
    geocodeLimit: args.geocodeLimit,
  })
  db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

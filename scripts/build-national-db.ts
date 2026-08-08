#!/usr/bin/env node
/**
 * Build a single SQLite database with nationwide BRREG + Kartverket data.
 *
 * Reference data (Kartverket CSV zip + BRREG bulk gzip) is cached under
 * data/cache/reference/ so later builds can run offline without re-downloading.
 */
import { buildNationalDatabase } from './lib/national-build.js'

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
    referenceCacheDir: cacheDirArg,
    parallel: !argv.includes('--no-parallel'),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await buildNationalDatabase({
    output: args.output,
    fresh: args.fresh,
    skipBrreg: args.skipBrreg,
    skipKartverket: args.skipKartverket,
    skipGeocode: args.skipGeocode,
    skipUnderenheter: args.skipUnderenheter,
    reuseDownloads: args.reuseDownloads,
    refreshDownloads: args.refreshDownloads,
    metadataOnly: args.metadataOnly,
    referenceCacheDir: args.referenceCacheDir,
    parallel: args.parallel,
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

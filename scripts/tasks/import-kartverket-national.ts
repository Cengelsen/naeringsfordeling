#!/usr/bin/env node
import { openDatabase, removeDatabaseFiles } from '../lib/db.js'
import { downloadNationalKartverketCsv, importNationalKartverketFromZip } from '../lib/kartverket-bulk.js'

function parseArgs(argv: string[]) {
  return {
    output: argv.find((arg) => arg.startsWith('--output='))?.split('=')[1] ?? 'data/kartverket-staging.db',
    cacheDir:
      argv.find((arg) => arg.startsWith('--cache-dir='))?.split('=')[1] ?? 'data/cache/reference',
    kartverketCacheDir:
      argv.find((arg) => arg.startsWith('--kartverket-cache-dir='))?.split('=')[1] ??
      process.env.KARTVERKET_CACHE_DIR,
    zipPath: argv.find((arg) => arg.startsWith('--zip='))?.split('=')[1],
    refreshDownloads: argv.includes('--refresh-downloads'),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  removeDatabaseFiles(args.output)
  const db = openDatabase(args.output, { runBackfill: true })

  const zipPath =
    args.zipPath ??
    (await downloadNationalKartverketCsv({
      cacheDir: args.kartverketCacheDir,
      reuseDownload: !args.refreshDownloads,
    }))

  await importNationalKartverketFromZip(db, zipPath, { clearExisting: true })
  db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

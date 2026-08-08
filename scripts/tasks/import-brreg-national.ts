#!/usr/bin/env node
import { openDatabase, removeDatabaseFiles, setSyncState } from '../lib/db.js'
import {
  DEFAULT_REFERENCE_CACHE_DIR,
  ensureBrregReferenceCache,
  importBrregEnheterFromCacheTransactional,
  importBrregUnderenheterFromCacheTransactional,
  readReferenceManifest,
  refreshReferenceFileHashes,
  sha256File,
} from '../lib/reference-cache.js'

function parseArgs(argv: string[]) {
  return {
    output: argv.find((arg) => arg.startsWith('--output='))?.split('=')[1] ?? 'data/orgs-staging.db',
    cacheDir:
      argv.find((arg) => arg.startsWith('--cache-dir='))?.split('=')[1] ?? DEFAULT_REFERENCE_CACHE_DIR,
    skipUnderenheter: argv.includes('--skip-underenheter'),
    refreshDownloads: argv.includes('--refresh-downloads'),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  removeDatabaseFiles(args.output)
  const db = openDatabase(args.output, { runBackfill: true })

  const reference = await ensureBrregReferenceCache(args.cacheDir, {
    reuseDownloads: !args.refreshDownloads,
    refreshDownloads: args.refreshDownloads,
    skipUnderenheter: args.skipUnderenheter,
  })

  const enheterResult = await importBrregEnheterFromCacheTransactional(db, reference.enheterPath)
  let imported = enheterResult.scanned

  if (!args.skipUnderenheter && reference.underenheterPath) {
    const underResult = await importBrregUnderenheterFromCacheTransactional(
      db,
      reference.underenheterPath,
    )
    imported += underResult.scanned
  }

  const manifest = readReferenceManifest(args.cacheDir)
  if (manifest.last_oppdateringsid) {
    setSyncState(db, 'last_oppdateringsid', manifest.last_oppdateringsid)
  }
  if (manifest.last_oppdateringsid_underenheter) {
    setSyncState(db, 'last_oppdateringsid_underenheter', manifest.last_oppdateringsid_underenheter)
  }

  setSyncState(db, 'brreg_enheter_file_hash', sha256File(reference.enheterPath))
  if (reference.underenheterPath) {
    setSyncState(db, 'brreg_underenheter_file_hash', sha256File(reference.underenheterPath))
  }

  refreshReferenceFileHashes(args.cacheDir)
  setSyncState(db, 'last_full_sync_at', new Date().toISOString())
  setSyncState(db, 'last_backfill_at', new Date().toISOString())

  console.log(`BRREG staging-import ferdig: ${imported.toLocaleString('nb-NO')} rader`)
  db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

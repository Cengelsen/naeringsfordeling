import { existsSync } from 'node:fs'
import type Database from 'better-sqlite3'
import {
  beginBulkLoad,
  endBulkLoad,
  openDatabase,
  rebuildOrgsRtree,
  setSyncState,
} from './db.js'
import { ensureKartverketSchema } from './kartverket-bulk.js'
import { nullOrphanOverordnetEnhet } from './organizations.js'

const SYNC_STATE_KEYS_TO_MERGE = [
  'last_oppdateringsid',
  'last_oppdateringsid_underenheter',
  'last_full_sync_at',
  'last_backfill_at',
  'kartverket_bulk_imported_at',
  'brreg_enheter_file_hash',
  'brreg_underenheter_file_hash',
  'kartverket_zip_file_hash',
] as const

function sqliteTableExists(db: Database.Database, table: string, schema = 'main'): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok
       FROM ${schema}.sqlite_master
       WHERE type = 'table' AND name = ?`,
    )
    .get(table) as { ok: number } | undefined
  return row != null
}

function attachSourceDatabase(target: Database.Database, alias: string, sourcePath: string): void {
  if (!existsSync(sourcePath)) {
    throw new Error(`Mangler regionsdatabase: ${sourcePath}`)
  }
  const escaped = sourcePath.replace(/\\/g, '/').replace(/'/g, "''")
  target.exec(`ATTACH DATABASE '${escaped}' AS ${alias}`)
}

function detachSourceDatabase(target: Database.Database, alias: string): void {
  target.exec(`DETACH DATABASE ${alias}`)
}

export interface MergeRegionDatabaseResult {
  organizations: number
  addressCache: number
  kartverket: number
  sourcePath: string
}

export interface MergeRegionDatabasesOptions {
  /** Clear target tables before first source is merged. */
  clearTarget?: boolean
  quiet?: boolean
  onSourceMerged?: (event: {
    index: number
    total: number
    sourcePath: string
    result: MergeRegionDatabaseResult
  }) => void
}

function mergeNumericSyncState(target: Database.Database, key: string, value: string) {
  const existing = target.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  const next = Math.max(Number(existing?.value ?? 0), Number(value))
  if (!Number.isFinite(next) || next <= 0) return
  setSyncState(target, key, String(next))
}

function mergeSyncStateFromSource(target: Database.Database, alias: string) {
  if (!sqliteTableExists(target, 'sync_state', alias)) return

  const rows = target
    .prepare(`SELECT key, value FROM ${alias}.sync_state`)
    .all() as Array<{ key: string; value: string }>

  for (const row of rows) {
    if (
      row.key === 'last_oppdateringsid' ||
      row.key === 'last_oppdateringsid_underenheter'
    ) {
      mergeNumericSyncState(target, row.key, row.value)
      continue
    }

    if ((SYNC_STATE_KEYS_TO_MERGE as readonly string[]).includes(row.key)) {
      setSyncState(target, row.key, row.value)
    }
  }
}

export function mergeRegionDatabaseInto(
  target: Database.Database,
  sourcePath: string,
  alias = 'region_src',
  options: MergeRegionDatabasesOptions = {},
): MergeRegionDatabaseResult {
  if (!existsSync(sourcePath)) {
    throw new Error(`Mangler regionsdatabase: ${sourcePath}`)
  }

  attachSourceDatabase(target, alias, sourcePath)

  try {
    if (!sqliteTableExists(target, 'organizations', alias)) {
      throw new Error(`Kilde mangler organizations-tabell: ${sourcePath}`)
    }

    if (options.clearTarget) {
      target.exec('DELETE FROM organizations')
      target.exec('DELETE FROM address_cache')
      ensureKartverketSchema(target)
      target.exec('DELETE FROM kartverket_addresses')
    }

    const orgResult = target
      .prepare(
        `INSERT OR REPLACE INTO organizations
         SELECT o.*
         FROM ${alias}.organizations o`,
      )
      .run()

    const cacheResult = target
      .prepare(
        `INSERT OR REPLACE INTO address_cache
         SELECT ac.*
         FROM ${alias}.address_cache ac
         WHERE ac.cache_key IN (
           SELECT DISTINCT address_key
           FROM ${alias}.organizations
           WHERE address_key IS NOT NULL
         )`,
      )
      .run()

    let kartverketCount = 0
    if (sqliteTableExists(target, 'kartverket_addresses', alias)) {
      ensureKartverketSchema(target)
      const kvResult = target
        .prepare(
          `INSERT OR REPLACE INTO kartverket_addresses
           SELECT kv.*
           FROM ${alias}.kartverket_addresses kv`,
        )
        .run()
      kartverketCount = kvResult.changes
    }

    mergeSyncStateFromSource(target, alias)

    return {
      organizations: orgResult.changes,
      addressCache: cacheResult.changes,
      kartverket: kartverketCount,
      sourcePath,
    }
  } finally {
    detachSourceDatabase(target, alias)
  }
}

export interface MergeAllRegionDatabasesSummary {
  sources: MergeRegionDatabaseResult[]
  clearedOrphans: number
}

export function mergeRegionDatabases(
  targetPath: string,
  sourcePaths: string[],
  options: MergeRegionDatabasesOptions = {},
): MergeAllRegionDatabasesSummary {
  if (sourcePaths.length === 0) {
    throw new Error('Ingen regionsdatabaser å flette.')
  }

  for (const path of sourcePaths) {
    if (!existsSync(path)) {
      throw new Error(`Mangler regionsdatabase: ${path}`)
    }
  }

  const db = openDatabase(targetPath, { runBackfill: true })
  beginBulkLoad(db)

  try {
    const sources: MergeRegionDatabaseResult[] = []

    for (let index = 0; index < sourcePaths.length; index += 1) {
      const sourcePath = sourcePaths[index]!
      const alias = `region_${index}`
      if (!options.quiet) {
        console.log(`Fletter ${sourcePath}…`)
      }
      const result = mergeRegionDatabaseInto(db, sourcePath, alias, {
        clearTarget: options.clearTarget && index === 0,
      })
      if (!options.quiet) {
        console.log(
          `  +${result.organizations.toLocaleString('nb-NO')} org., ${result.addressCache.toLocaleString('nb-NO')} cache, ${result.kartverket.toLocaleString('nb-NO')} Kartverket`,
        )
      }
      options.onSourceMerged?.({
        index,
        total: sourcePaths.length,
        sourcePath,
        result,
      })
      sources.push(result)
    }

    const clearedOrphans = nullOrphanOverordnetEnhet(db)
    if (clearedOrphans > 0 && !options.quiet) {
      console.log(
        `Nullstilte ${clearedOrphans.toLocaleString('nb-NO')} foreldreløse overordnet_enhet-referanser etter fletting.`,
      )
    }

    setSyncState(db, 'build_source', 'merge-fylker-databases')
    setSyncState(db, 'last_sync_at', new Date().toISOString())

    rebuildOrgsRtree(db)
    endBulkLoad(db)

    return { sources, clearedOrphans }
  } finally {
    db.close()
  }
}

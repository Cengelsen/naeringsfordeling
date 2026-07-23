import { existsSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { effectiveKommunenummerExpr, openDatabase, setSyncState } from './db.js'
import { ensureKartverketSchema } from './kartverket-bulk.js'
import { brregReferenceAvailable } from './reference-cache.js'

export const DEFAULT_NATIONAL_DB_PATH = process.env.NATIONAL_DB_PATH ?? 'data/norway.db'

export type RegionDataSource = 'cache' | 'national'

export function resolveNationalDbPath(explicit?: string): string {
  return explicit ?? DEFAULT_NATIONAL_DB_PATH
}

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

export function nationalDatabaseAvailable(path = DEFAULT_NATIONAL_DB_PATH): boolean {
  if (!existsSync(path)) return false
  const db = openDatabase(path)
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM organizations').get() as { count: number }
    return row.count > 0
  } catch {
    return false
  } finally {
    db.close()
  }
}

export function listKommunerFromNationalDb(
  path = DEFAULT_NATIONAL_DB_PATH,
): Array<{ nummer: string; navn: string }> {
  const db = openDatabase(path)
  try {
    const kommuneExpr = effectiveKommunenummerExpr('organizations')
    const rows = db
      .prepare(
        `SELECT DISTINCT ${kommuneExpr} AS nummer
         FROM organizations
         WHERE deleted = 0 AND ${kommuneExpr} IS NOT NULL
         ORDER BY nummer`,
      )
      .all() as Array<{ nummer: string }>

    return rows.map((row) => ({
      nummer: row.nummer.padStart(4, '0'),
      navn: row.nummer.padStart(4, '0'),
    }))
  } finally {
    db.close()
  }
}

function attachNationalDatabase(target: Database.Database, sourcePath: string): void {
  const escaped = sourcePath.replace(/\\/g, '/').replace(/'/g, "''")
  target.exec(`ATTACH DATABASE '${escaped}' AS national`)
}

function detachNationalDatabase(target: Database.Database): void {
  target.exec('DETACH DATABASE national')
}

function kommunePlaceholders(kommuner: string[]): string {
  return kommuner.map(() => '?').join(', ')
}

function organizationKommuneFilter(alias: string, kommuner: string[]): { sql: string; params: string[] } {
  const expr = effectiveKommunenummerExpr(alias)
  const padded = kommuner.map((k) => k.padStart(4, '0'))
  return {
    sql: `${expr} IN (${kommunePlaceholders(padded)})`,
    params: padded,
  }
}

export interface ImportRegionFromNationalOptions {
  skipUnderenheter?: boolean
}

export function importEntireNationalDb(
  target: Database.Database,
  sourcePath: string,
  options: ImportRegionFromNationalOptions = {},
): { organizations: number; addressCache: number; kartverket: number } {
  if (!nationalDatabaseAvailable(sourcePath)) {
    throw new Error(`Nasjonal database mangler eller er tom: ${sourcePath}`)
  }

  attachNationalDatabase(target, sourcePath)

  try {
    if (!sqliteTableExists(target, 'organizations', 'national')) {
      throw new Error(`Nasjonal database har ingen organizations-tabell: ${sourcePath}`)
    }

    const entityFilter = options.skipUnderenheter ? "WHERE entity_kind = 'enhet'" : ''

    target.exec('DELETE FROM organizations')
    target.exec('DELETE FROM address_cache')
    ensureKartverketSchema(target)
    target.exec('DELETE FROM kartverket_addresses')

    const orgResult = target
      .prepare(
        `INSERT INTO organizations
         SELECT o.*
         FROM national.organizations o
         ${entityFilter}`,
      )
      .run()

    const cacheResult = target
      .prepare(
        `INSERT INTO address_cache
         SELECT ac.*
         FROM national.address_cache ac
         WHERE ac.cache_key IN (
           SELECT DISTINCT address_key
           FROM organizations
           WHERE address_key IS NOT NULL
         )`,
      )
      .run()

    let kartverketCount = 0
    if (sqliteTableExists(target, 'kartverket_addresses', 'national')) {
      const kvResult = target
        .prepare(
          `INSERT INTO kartverket_addresses
           SELECT kv.*
           FROM national.kartverket_addresses kv`,
        )
        .run()
      kartverketCount = kvResult.changes
    }

    if (sqliteTableExists(target, 'sync_state', 'national')) {
      target.exec(`
        INSERT OR REPLACE INTO sync_state (key, value)
        SELECT key, value
        FROM national.sync_state
      `)
    }

    setSyncState(target, 'copied_from_national_db', sourcePath)

    return {
      organizations: orgResult.changes,
      addressCache: cacheResult.changes,
      kartverket: kartverketCount,
    }
  } finally {
    detachNationalDatabase(target)
  }
}

export function importRegionFromNationalDb(
  target: Database.Database,
  sourcePath: string,
  kommuner: string[],
  options: ImportRegionFromNationalOptions = {},
): { organizations: number; addressCache: number; kartverket: number } {
  if (!nationalDatabaseAvailable(sourcePath)) {
    throw new Error(`Nasjonal database mangler eller er tom: ${sourcePath}`)
  }

  attachNationalDatabase(target, sourcePath)

  try {
    if (!sqliteTableExists(target, 'organizations', 'national')) {
      throw new Error(`Nasjonal database har ingen organizations-tabell: ${sourcePath}`)
    }

    const { sql: kommuneSql, params: kommuneParams } = organizationKommuneFilter('o', kommuner)
    const entityFilter = options.skipUnderenheter ? "AND o.entity_kind = 'enhet'" : ''

    target.exec('DELETE FROM organizations')
    target.exec('DELETE FROM address_cache')
    ensureKartverketSchema(target)
    target.exec('DELETE FROM kartverket_addresses')

    const orgInsert = target.prepare(`
      INSERT INTO organizations
      SELECT o.*
      FROM national.organizations o
      WHERE ${kommuneSql}
        ${entityFilter}
    `)
    const orgResult = orgInsert.run(...kommuneParams)

    const cacheInsert = target.prepare(`
      INSERT INTO address_cache
      SELECT ac.*
      FROM national.address_cache ac
      WHERE ac.cache_key IN (
        SELECT DISTINCT address_key
        FROM organizations
        WHERE address_key IS NOT NULL
      )
    `)
    const cacheResult = cacheInsert.run()

    let kartverketCount = 0
    if (sqliteTableExists(target, 'kartverket_addresses', 'national')) {
      const padded = kommuner.map((k) => k.padStart(4, '0'))
      const kvInsert = target.prepare(`
        INSERT INTO kartverket_addresses
        SELECT kv.*
        FROM national.kartverket_addresses kv
        WHERE kv.kommunenummer IN (${kommunePlaceholders(padded)})
      `)
      const kvResult = kvInsert.run(...padded)
      kartverketCount = kvResult.changes
    }

    if (sqliteTableExists(target, 'sync_state', 'national')) {
      target.exec(`
        INSERT OR REPLACE INTO sync_state (key, value)
        SELECT key, value
        FROM national.sync_state
        WHERE key IN (
          'last_oppdateringsid',
          'last_oppdateringsid_underenheter',
          'last_full_sync_at',
          'last_backfill_at',
          'kartverket_bulk_imported_at',
          'build_source'
        )
      `)
    }

    return {
      organizations: orgResult.changes,
      addressCache: cacheResult.changes,
      kartverket: kartverketCount,
    }
  } finally {
    detachNationalDatabase(target)
  }
}

export function resolveRegionDataSource(options: {
  referenceCacheDir: string
  nationalDbPath?: string
}): { source: RegionDataSource; nationalDbPath: string } {
  const nationalDbPath = resolveNationalDbPath(options.nationalDbPath)
  const nationalAvailable = nationalDatabaseAvailable(nationalDbPath)
  const cacheAvailable = brregReferenceAvailable(options.referenceCacheDir)

  if (nationalAvailable) {
    return { source: 'national', nationalDbPath }
  }
  if (cacheAvailable) {
    return { source: 'cache', nationalDbPath }
  }

  throw new Error(
    `Ingen datakilde tilgjengelig. Kjør yarn build-national-db (referansecache eller ${nationalDbPath}).`,
  )
}

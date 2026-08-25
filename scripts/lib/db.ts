import Database from 'better-sqlite3'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { employeeBandSql } from '../../shared/employeeBands.js'

export const DEFAULT_DB_PATH = process.env.DATABASE_PATH ?? 'data/organizations.db'

const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const

const CURRENT_SCHEMA_VERSION = 1

const ORGANIZATION_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: 'entity_kind', ddl: "TEXT NOT NULL DEFAULT 'enhet'" },
  { name: 'overordnet_enhet', ddl: 'TEXT' },
  { name: 'naeringskode', ddl: 'TEXT' },
  { name: 'naeringskode_label', ddl: 'TEXT' },
  { name: 'antall_ansatte', ddl: 'INTEGER' },
  { name: 'har_registrert_antall_ansatte', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'er_i_konsern', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'adresse_id', ddl: 'TEXT' },
  { name: 'matrikkel_key', ddl: 'TEXT' },
  { name: 'kommunenummer_geo', ddl: 'TEXT' },
  { name: 'geocode_quality', ddl: 'TEXT' },
  { name: 'employee_band', ddl: 'TEXT' },
  { name: 'naeringskode_section', ddl: 'TEXT' },
  { name: 'brreg_content_hash', ddl: 'TEXT' },
]

interface BulkLoadState {
  savedJournalMode: string
  savedSynchronous: number
}

const bulkLoadState = new WeakMap<Database.Database, BulkLoadState>()

/** Remove main DB file and WAL/SHM/journal sidecars (required for a clean --fresh). */
export function removeDatabaseFiles(path = DEFAULT_DB_PATH) {
  for (const suffix of ['', ...SQLITE_SIDECAR_SUFFIXES]) {
    const file = suffix ? `${path}${suffix}` : path
    if (existsSync(file)) unlinkSync(file)
  }
}

export interface OpenDatabaseOptions {
  runBackfill?: boolean
}

export function openDatabase(
  path = DEFAULT_DB_PATH,
  options: OpenDatabaseOptions = {},
): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db, options.runBackfill ?? false)
  return db
}

/** Backfill computed columns that may be NULL after schema upgrades. */
export function runPendingBackfills(db: Database.Database) {
  db.exec(`
    UPDATE organizations SET
      employee_band = ${employeeBandSql()}
    WHERE employee_band IS NULL;

    UPDATE organizations SET
      naeringskode_section = substr(naeringskode, 1, 2)
    WHERE naeringskode_section IS NULL AND naeringskode IS NOT NULL AND length(naeringskode) >= 2;
  `)
}

function ensureColumns(db: Database.Database) {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(organizations)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  )

  for (const column of ORGANIZATION_COLUMNS) {
    if (existing.has(column.name)) continue
    db.exec(`ALTER TABLE organizations ADD COLUMN ${column.name} ${column.ddl}`)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_naeringskode
      ON organizations(naeringskode)
      WHERE deleted = 0;

    CREATE INDEX IF NOT EXISTS idx_org_entity_kind
      ON organizations(entity_kind)
      WHERE deleted = 0;

    CREATE INDEX IF NOT EXISTS idx_org_overordnet
      ON organizations(overordnet_enhet)
      WHERE deleted = 0 AND overordnet_enhet IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_org_konsern
      ON organizations(er_i_konsern)
      WHERE deleted = 0 AND er_i_konsern = 1;

    CREATE INDEX IF NOT EXISTS idx_employee_band
      ON organizations(employee_band)
      WHERE deleted = 0;

    CREATE INDEX IF NOT EXISTS idx_naeringskode_section
      ON organizations(naeringskode_section)
      WHERE deleted = 0;

    CREATE INDEX IF NOT EXISTS idx_org_entity_section_band
      ON organizations(entity_kind, naeringskode_section, employee_band)
      WHERE deleted = 0 AND lat IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_org_entity_kommune
      ON organizations(entity_kind, kommunenummer)
      WHERE deleted = 0;
  `)
}

function getSchemaVersion(db: Database.Database): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0
}

function setSchemaVersion(db: Database.Database, version: number) {
  db.pragma(`user_version = ${version}`)
}

function migrate(db: Database.Database, runBackfill: boolean) {
  const version = getSchemaVersion(db)

  if (version >= CURRENT_SCHEMA_VERSION) {
    ensureColumns(db)
    ensureAddressCacheColumns(db)
    ensureOrgsRtree(db)
    ensureFtsPopulated(db)
    return
  }

  // Version 0 -> 1: full schema creation + improvements
  if (version < 1) {
    migrateToV1(db)
  }

  if (runBackfill) {
    runPendingBackfills(db)
  }

  ensureOrgsRtree(db)
  ensureFts(db)
  ensureFtsPopulated(db)
  setSchemaVersion(db, CURRENT_SCHEMA_VERSION)
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return row != null
}

function migrateToV1(db: Database.Database) {
  const isExistingDb = tableExists(db, 'organizations')

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS address_cache (
      cache_key TEXT PRIMARY KEY,
      lat REAL,
      lng REAL,
      geocoded_at TEXT NOT NULL,
      failed INTEGER NOT NULL DEFAULT 0,
      adresse_id TEXT,
      matrikkel_key TEXT,
      kommunenummer_geo TEXT,
      geocode_quality TEXT
    ) WITHOUT ROWID;
  `)

  if (!isExistingDb) {
    db.exec(`
      CREATE TABLE organizations (
        orgnr TEXT PRIMARY KEY,
        navn TEXT NOT NULL,
        org_type TEXT NOT NULL,
        org_type_label TEXT NOT NULL,
        address_text TEXT,
        postnummer TEXT,
        kommunenummer TEXT,
        address_key TEXT,
        lat REAL,
        lng REAL,
        konkurs INTEGER NOT NULL DEFAULT 0,
        under_avvikling INTEGER NOT NULL DEFAULT 0,
        vat_registered INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        entity_kind TEXT NOT NULL DEFAULT 'enhet',
        overordnet_enhet TEXT REFERENCES organizations(orgnr) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
        naeringskode TEXT,
        naeringskode_label TEXT,
        antall_ansatte INTEGER,
        har_registrert_antall_ansatte INTEGER NOT NULL DEFAULT 0,
        er_i_konsern INTEGER NOT NULL DEFAULT 0,
        adresse_id TEXT,
        matrikkel_key TEXT,
        kommunenummer_geo TEXT,
        geocode_quality TEXT,
        employee_band TEXT,
        naeringskode_section TEXT
      ) STRICT;
    `)
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        orgnr TEXT PRIMARY KEY,
        navn TEXT NOT NULL,
        org_type TEXT NOT NULL,
        org_type_label TEXT NOT NULL,
        address_text TEXT,
        postnummer TEXT,
        kommunenummer TEXT,
        address_key TEXT,
        lat REAL,
        lng REAL,
        konkurs INTEGER NOT NULL DEFAULT 0,
        under_avvikling INTEGER NOT NULL DEFAULT 0,
        vat_registered INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_kommune
      ON organizations(kommunenummer)
      WHERE deleted = 0;

    CREATE INDEX IF NOT EXISTS idx_org_type
      ON organizations(org_type)
      WHERE deleted = 0;

    CREATE INDEX IF NOT EXISTS idx_org_geocoded
      ON organizations(kommunenummer)
      WHERE deleted = 0 AND lat IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_org_pending_geocode
      ON organizations(updated_at)
      WHERE deleted = 0 AND lat IS NULL AND address_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_org_coords
      ON organizations(lat, lng)
      WHERE deleted = 0 AND lat IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_org_address_key
      ON organizations(address_key)
      WHERE deleted = 0 AND address_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_cache_failed
      ON address_cache(cache_key)
      WHERE failed = 1;

    CREATE VIRTUAL TABLE IF NOT EXISTS orgs_rtree USING rtree(
      id,
      minLng, maxLng,
      minLat, maxLat
    );
  `)

  rebuildTableIfNeeded(
    db,
    'sync_state',
    `
    CREATE TABLE sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `,
  )
  rebuildTableIfNeeded(
    db,
    'address_cache',
    `
    CREATE TABLE address_cache (
      cache_key TEXT PRIMARY KEY,
      lat REAL,
      lng REAL,
      geocoded_at TEXT NOT NULL,
      failed INTEGER NOT NULL DEFAULT 0,
      adresse_id TEXT,
      matrikkel_key TEXT,
      kommunenummer_geo TEXT,
      geocode_quality TEXT
    ) WITHOUT ROWID
  `,
  )

  ensureColumns(db)
  ensureAddressCacheColumns(db)
}

/** Rebuild a table with new DDL if it exists but lacks WITHOUT ROWID / STRICT. */
function rebuildTableIfNeeded(db: Database.Database, tableName: string, newDdl: string) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql: string } | undefined
  if (!row) return

  const currentSql = row.sql.toLowerCase()
  const needsRebuild =
    (newDdl.toLowerCase().includes('without rowid') && !currentSql.includes('without rowid')) ||
    (newDdl.toLowerCase().includes('strict') && !currentSql.includes('strict'))

  if (!needsRebuild) return

  const oldColumns = (
    db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  ).map((c) => c.name)

  const tmpName = `${tableName}__rebuild_tmp`
  db.exec(`ALTER TABLE ${tableName} RENAME TO ${tmpName}`)
  db.exec(newDdl)

  const newColumns = (
    db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  ).map((c) => c.name)

  const shared = oldColumns.filter((c) => newColumns.includes(c))
  const cols = shared.join(', ')
  db.exec(`INSERT OR IGNORE INTO ${tableName} (${cols}) SELECT ${cols} FROM ${tmpName}`)
  db.exec(`DROP TABLE ${tmpName}`)
}

function rebuildFts(db: Database.Database) {
  db.exec(`
    DROP TRIGGER IF EXISTS organizations_fts_insert;
    DROP TRIGGER IF EXISTS organizations_fts_delete;
    DROP TRIGGER IF EXISTS organizations_fts_update;
  `)

  try {
    db.exec('DROP TABLE IF EXISTS organizations_fts')
  } catch {
    for (const suffix of ['', '_data', '_idx', '_docsize', '_config', '_content']) {
      try {
        db.exec(`DROP TABLE IF EXISTS organizations_fts${suffix}`)
      } catch {
        /* ignore */
      }
    }
  }

  db.exec(`
    CREATE VIRTUAL TABLE organizations_fts USING fts5(
      navn,
      content='organizations',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2',
      prefix='2,3'
    );

    CREATE TRIGGER organizations_fts_insert AFTER INSERT ON organizations BEGIN
      INSERT INTO organizations_fts(rowid, navn) VALUES (new.rowid, new.navn);
    END;
    CREATE TRIGGER organizations_fts_delete AFTER DELETE ON organizations BEGIN
      INSERT INTO organizations_fts(organizations_fts, rowid, navn) VALUES('delete', old.rowid, old.navn);
    END;
    CREATE TRIGGER organizations_fts_update AFTER UPDATE ON organizations BEGIN
      INSERT INTO organizations_fts(organizations_fts, rowid, navn) VALUES('delete', old.rowid, old.navn);
      INSERT INTO organizations_fts(rowid, navn) VALUES (new.rowid, new.navn);
    END;
  `)
}

function ftsSchemaValid(db: Database.Database): boolean {
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'organizations_fts'")
      .get() as { sql: string } | undefined
    if (!row) return false

    const sql = row.sql.toLowerCase()
    if (sql.includes('orgnr')) return false
    if (!sql.includes('unicode61')) return false

    const triggerCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('organizations_fts_insert', 'organizations_fts_delete', 'organizations_fts_update')",
        )
        .get() as { count: number }
    ).count
    return triggerCount === 3
  } catch {
    return false
  }
}

function ensureFts(db: Database.Database) {
  if (ftsSchemaValid(db)) return
  rebuildFts(db)
}

function ftsIndexIsSearchable(db: Database.Database): boolean {
  const orgCount = (
    db.prepare('SELECT COUNT(*) AS count FROM organizations').get() as { count: number }
  ).count
  if (orgCount === 0) return true

  try {
    const hit = db
      .prepare('SELECT 1 FROM organizations_fts WHERE organizations_fts MATCH ? LIMIT 1')
      .get('a*') as { 1: number } | undefined
    return hit != null
  } catch {
    return false
  }
}

function ensureFtsPopulated(db: Database.Database) {
  if (ftsIndexIsSearchable(db)) return
  rebuildFtsIndex(db)
}

/** Drop FTS triggers so bulk INSERT does not update the index per row. */
export function disableFtsTriggers(db: Database.Database) {
  db.exec(`
    DROP TRIGGER IF EXISTS organizations_fts_insert;
    DROP TRIGGER IF EXISTS organizations_fts_delete;
    DROP TRIGGER IF EXISTS organizations_fts_update;
  `)
}

/** Rebuild FTS from organizations content and recreate maintenance triggers. */
export function rebuildFtsIndex(db: Database.Database) {
  const orgCount = (
    db.prepare('SELECT COUNT(*) AS count FROM organizations').get() as { count: number }
  ).count

  if (!ftsSchemaValid(db)) {
    rebuildFts(db)
    if (orgCount > 0) {
      db.exec(`INSERT INTO organizations_fts(organizations_fts) VALUES('rebuild')`)
    }
    return
  }

  if (orgCount > 0) {
    db.exec(`INSERT INTO organizations_fts(organizations_fts) VALUES('rebuild')`)
  }

  disableFtsTriggers(db)
  db.exec(`
    CREATE TRIGGER organizations_fts_insert AFTER INSERT ON organizations BEGIN
      INSERT INTO organizations_fts(rowid, navn) VALUES (new.rowid, new.navn);
    END;
    CREATE TRIGGER organizations_fts_delete AFTER DELETE ON organizations BEGIN
      INSERT INTO organizations_fts(organizations_fts, rowid, navn) VALUES('delete', old.rowid, old.navn);
    END;
    CREATE TRIGGER organizations_fts_update AFTER UPDATE ON organizations BEGIN
      INSERT INTO organizations_fts(organizations_fts, rowid, navn) VALUES('delete', old.rowid, old.navn);
      INSERT INTO organizations_fts(rowid, navn) VALUES (new.rowid, new.navn);
    END;
  `)
}

/** Speed up large imports; pair with endBulkLoad before serving the database. */
export function beginBulkLoad(db: Database.Database) {
  if (bulkLoadState.has(db)) return

  bulkLoadState.set(db, {
    savedJournalMode: db.pragma('journal_mode', { simple: true }) as string,
    savedSynchronous: db.pragma('synchronous', { simple: true }) as number,
  })

  db.pragma('journal_mode = MEMORY')
  db.pragma('synchronous = OFF')
  db.pragma('temp_store = MEMORY')
  db.pragma('cache_size = -262144')
  disableFtsTriggers(db)
}

/** Restore pragmas and rebuild FTS after bulk import. */
export function endBulkLoad(db: Database.Database) {
  rebuildFtsIndex(db)

  const saved = bulkLoadState.get(db)
  if (saved) {
    db.pragma(`journal_mode = ${saved.savedJournalMode}`)
    db.pragma(`synchronous = ${saved.savedSynchronous}`)
    bulkLoadState.delete(db)
  } else {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
  }
}

export function isBulkLoadActive(db: Database.Database): boolean {
  return bulkLoadState.has(db)
}

function ensureAddressCacheColumns(db: Database.Database) {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(address_cache)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  )

  const columns = [
    { name: 'adresse_id', ddl: 'TEXT' },
    { name: 'matrikkel_key', ddl: 'TEXT' },
    { name: 'kommunenummer_geo', ddl: 'TEXT' },
    { name: 'geocode_quality', ddl: 'TEXT' },
  ]

  for (const column of columns) {
    if (existing.has(column.name)) continue
    db.exec(`ALTER TABLE address_cache ADD COLUMN ${column.name} ${column.ddl}`)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cache_failed
      ON address_cache(cache_key)
      WHERE failed = 1;
  `)
}

/** Rebuild the spatial R-tree index for O(log n) bbox queries. */
export function rebuildOrgsRtree(db: Database.Database) {
  db.exec('DELETE FROM orgs_rtree')
  db.prepare(
    `INSERT INTO orgs_rtree (id, minLng, maxLng, minLat, maxLat)
     SELECT rowid, lng, lng, lat, lat
     FROM organizations
     WHERE deleted = 0 AND lat IS NOT NULL AND lng IS NOT NULL`,
  ).run()
}

function ensureOrgsRtree(db: Database.Database) {
  const orgCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM organizations
         WHERE deleted = 0 AND lat IS NOT NULL AND lng IS NOT NULL`,
      )
      .get() as { count: number }
  ).count

  const rtreeCount = (
    db.prepare('SELECT COUNT(*) AS count FROM orgs_rtree').get() as { count: number }
  ).count

  if (orgCount > 0 && rtreeCount !== orgCount) {
    rebuildOrgsRtree(db)
  }
}

export function getSyncState(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

export function setSyncState(db: Database.Database, key: string, value: string) {
  db.prepare(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
}

export function getStats(db: Database.Database) {
  const stats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN deleted = 0 AND lat IS NOT NULL THEN 1 ELSE 0 END) AS geocoded,
         SUM(CASE WHEN deleted = 0 AND lat IS NULL AND address_key IS NOT NULL THEN 1 ELSE 0 END) AS pending_geocode,
         SUM(CASE WHEN deleted = 0 AND entity_kind = 'enhet' THEN 1 ELSE 0 END) AS enheter,
         SUM(CASE WHEN deleted = 0 AND entity_kind = 'underenhet' THEN 1 ELSE 0 END) AS underenheter
       FROM organizations`,
    )
    .get() as {
    total: number
    active: number
    geocoded: number
    pending_geocode: number
    enheter: number
    underenheter: number
  }

  const rtree = db.prepare('SELECT COUNT(*) AS count FROM orgs_rtree').get() as { count: number }

  return { ...stats, rtree: rtree.count }
}

/** Organizations with a Norwegian postnummer that still lack coordinates. */
export function countPendingGeocodeWithPostnummer(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM organizations
         WHERE deleted = 0
           AND lat IS NULL
           AND address_key IS NOT NULL
           AND postnummer IS NOT NULL
           AND trim(postnummer) != ''`,
      )
      .get() as { count: number }
  ).count
}

/** Rows that still lack data introduced after an schema upgrade. */
export function getBackfillStats(db: Database.Database) {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN deleted = 0 AND entity_kind = 'enhet' AND naeringskode IS NULL THEN 1 ELSE 0 END)
           AS missing_naeringskode,
         SUM(CASE WHEN deleted = 0 AND lat IS NOT NULL AND geocode_quality IS NULL THEN 1 ELSE 0 END)
           AS missing_geocode_metadata,
         (SELECT COUNT(DISTINCT address_key)
          FROM organizations
          WHERE deleted = 0
            AND lat IS NOT NULL
            AND geocode_quality IS NULL
            AND address_key IS NOT NULL)
           AS missing_metadata_addresses
       FROM organizations`,
    )
    .get() as {
    missing_naeringskode: number
    missing_geocode_metadata: number
    missing_metadata_addresses: number
  }

  const stats = getStats(db)
  return {
    ...row,
    underenheter: stats.underenheter,
    needs_underenheter: stats.underenheter === 0,
    needs_field_backfill: row.missing_naeringskode > 0,
    needs_metadata_backfill: row.missing_geocode_metadata > 0,
  }
}

export function logBackfillStats(db: Database.Database, label: string) {
  const backfill = getBackfillStats(db)
  console.log(label)
  console.log(`  Underenheter: ${backfill.underenheter.toLocaleString('nb-NO')}`)
  console.log(
    `  Enheter uten næringskode: ${backfill.missing_naeringskode.toLocaleString('nb-NO')}`,
  )
  console.log(
    `  Geokodede uten metadata: ${backfill.missing_geocode_metadata.toLocaleString('nb-NO')} org. (${backfill.missing_metadata_addresses.toLocaleString('nb-NO')} adresser)`,
  )
}

export function needsBackfill(db: Database.Database): boolean {
  const backfill = getBackfillStats(db)
  return (
    backfill.needs_underenheter || backfill.needs_field_backfill || backfill.needs_metadata_backfill
  )
}

/** Municipality for choropleth: prefer Kartverket when geocode is trusted. */
export function effectiveKommunenummerExpr(tableAlias = ''): string {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  return `CASE
    WHEN ${prefix}geocode_quality IN ('verified', 'fallback', 'mismatch')
      AND ${prefix}kommunenummer_geo IS NOT NULL
    THEN ${prefix}kommunenummer_geo
    ELSE ${prefix}kommunenummer
  END`
}

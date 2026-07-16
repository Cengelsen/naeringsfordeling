import Database from 'better-sqlite3'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_DB_PATH = process.env.DATABASE_PATH ?? 'data/organizations.db'

const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const

/** Remove main DB file and WAL/SHM/journal sidecars (required for a clean --fresh). */
export function removeDatabaseFiles(path = DEFAULT_DB_PATH) {
  for (const suffix of ['', ...SQLITE_SIDECAR_SUFFIXES]) {
    const file = suffix ? `${path}${suffix}` : path
    if (existsSync(file)) unlinkSync(file)
  }
}

export function openDatabase(path = DEFAULT_DB_PATH): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS address_cache (
      cache_key TEXT PRIMARY KEY,
      lat REAL,
      lng REAL,
      geocoded_at TEXT NOT NULL,
      failed INTEGER NOT NULL DEFAULT 0
    );

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
  `)
}

export function getSyncState(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSyncState(db: Database.Database, key: string, value: string) {
  db.prepare(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
}

export function getStats(db: Database.Database) {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN deleted = 0 AND lat IS NOT NULL THEN 1 ELSE 0 END) AS geocoded,
         SUM(CASE WHEN deleted = 0 AND lat IS NULL AND address_key IS NOT NULL THEN 1 ELSE 0 END) AS pending_geocode
       FROM organizations`,
    )
    .get() as {
    total: number
    active: number
    geocoded: number
    pending_geocode: number
  }
}

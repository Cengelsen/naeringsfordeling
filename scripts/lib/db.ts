import Database from 'better-sqlite3'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_DB_PATH = process.env.DATABASE_PATH ?? 'data/organizations.db'

const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const

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
]

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
  `)
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
      failed INTEGER NOT NULL DEFAULT 0,
      adresse_id TEXT,
      matrikkel_key TEXT,
      kommunenummer_geo TEXT,
      geocode_quality TEXT
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
      updated_at TEXT NOT NULL,
      entity_kind TEXT NOT NULL DEFAULT 'enhet',
      overordnet_enhet TEXT,
      naeringskode TEXT,
      naeringskode_label TEXT,
      antall_ansatte INTEGER,
      har_registrert_antall_ansatte INTEGER NOT NULL DEFAULT 0,
      er_i_konsern INTEGER NOT NULL DEFAULT 0,
      adresse_id TEXT,
      matrikkel_key TEXT,
      kommunenummer_geo TEXT,
      geocode_quality TEXT
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

    CREATE INDEX IF NOT EXISTS idx_org_address_key
      ON organizations(address_key)
      WHERE deleted = 0 AND address_key IS NOT NULL;

    CREATE VIRTUAL TABLE IF NOT EXISTS orgs_rtree USING rtree(
      id,
      minLng, maxLng,
      minLat, maxLat
    );
  `)

  ensureColumns(db)
  ensureAddressCacheColumns(db)
  ensureOrgsRtree(db)
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

  const rtreeCount = (db.prepare('SELECT COUNT(*) AS count FROM orgs_rtree').get() as { count: number })
    .count

  if (orgCount > 0 && rtreeCount !== orgCount) {
    rebuildOrgsRtree(db)
  }
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
    backfill.needs_underenheter ||
    backfill.needs_field_backfill ||
    backfill.needs_metadata_backfill
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

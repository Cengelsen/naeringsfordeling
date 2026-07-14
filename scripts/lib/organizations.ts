import type Database from 'better-sqlite3'
import type { BrregAddress, BrregEntity } from './types.js'
import { addressCacheKey, pickAddressLine } from './geocode.js'

export function entityAddress(entity: BrregEntity): BrregAddress | null {
  return entity.forretningsadresse ?? entity.postadresse ?? null
}

export function entityToRecord(entity: BrregEntity, deleted = false) {
  const address = entityAddress(entity)
  const line = address ? pickAddressLine(address.adresse) : null
  const key = address && line ? addressCacheKey(address, line) : null

  return {
    orgnr: entity.organisasjonsnummer,
    navn: entity.navn,
    org_type: entity.organisasjonsform?.kode ?? 'UKJENT',
    org_type_label: entity.organisasjonsform?.beskrivelse ?? 'Ukjent',
    address_text: line,
    postnummer: address?.postnummer ?? null,
    kommunenummer: address?.kommunenummer ?? null,
    address_key: key,
    konkurs: entity.konkurs ? 1 : 0,
    under_avvikling: entity.underAvvikling ? 1 : 0,
    vat_registered: entity.registrertIMvaregisteret ? 1 : 0,
    deleted: deleted || entity.slettedato ? 1 : 0,
    updated_at: new Date().toISOString(),
  }
}

const upsertStmt = `
  INSERT INTO organizations (
    orgnr, navn, org_type, org_type_label, address_text, postnummer,
    kommunenummer, address_key, lat, lng, konkurs, under_avvikling,
    vat_registered, deleted, updated_at
  ) VALUES (
    @orgnr, @navn, @org_type, @org_type_label, @address_text, @postnummer,
    @kommunenummer, @address_key, @lat, @lng, @konkurs, @under_avvikling,
    @vat_registered, @deleted, @updated_at
  )
  ON CONFLICT(orgnr) DO UPDATE SET
    navn = excluded.navn,
    org_type = excluded.org_type,
    org_type_label = excluded.org_type_label,
    address_text = excluded.address_text,
    postnummer = excluded.postnummer,
    kommunenummer = excluded.kommunenummer,
    address_key = excluded.address_key,
    lat = CASE
      WHEN excluded.address_key IS NOT organizations.address_key THEN NULL
      ELSE COALESCE(organizations.lat, excluded.lat)
    END,
    lng = CASE
      WHEN excluded.address_key IS NOT organizations.address_key THEN NULL
      ELSE COALESCE(organizations.lng, excluded.lng)
    END,
    konkurs = excluded.konkurs,
    under_avvikling = excluded.under_avvikling,
    vat_registered = excluded.vat_registered,
    deleted = excluded.deleted,
    updated_at = excluded.updated_at
`

export function upsertEntity(db: Database.Database, entity: BrregEntity, deleted = false) {
  const record = entityToRecord(entity, deleted)
  db.prepare(upsertStmt).run({ ...record, lat: null, lng: null })
}

export function markDeleted(db: Database.Database, orgnr: string) {
  db.prepare(
    `UPDATE organizations
     SET deleted = 1, updated_at = ?
     WHERE orgnr = ?`,
  ).run(new Date().toISOString(), orgnr)
}

export function applyCachedCoordinates(db: Database.Database, addressKey: string, lat: number, lng: number) {
  db.prepare(
    `UPDATE organizations
     SET lat = ?, lng = ?
     WHERE address_key = ? AND deleted = 0`,
  ).run(lat, lng, addressKey)
}

export function getCachedAddress(
  db: Database.Database,
  cacheKey: string,
): { lat: number; lng: number } | null | 'failed' {
  const row = db
    .prepare('SELECT lat, lng, failed FROM address_cache WHERE cache_key = ?')
    .get(cacheKey) as { lat: number | null; lng: number | null; failed: number } | undefined

  if (!row) return null
  if (row.failed) return 'failed'
  if (row.lat == null || row.lng == null) return 'failed'
  return { lat: row.lat, lng: row.lng }
}

export function saveAddressCache(
  db: Database.Database,
  cacheKey: string,
  coords: { lat: number; lng: number } | null,
) {
  db.prepare(
    `INSERT INTO address_cache (cache_key, lat, lng, geocoded_at, failed)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       lat = excluded.lat,
       lng = excluded.lng,
       geocoded_at = excluded.geocoded_at,
       failed = excluded.failed`,
  ).run(
    cacheKey,
    coords?.lat ?? null,
    coords?.lng ?? null,
    new Date().toISOString(),
    coords ? 0 : 1,
  )
}

export function pendingAddressKeys(db: Database.Database, limit: number): string[] {
  return db
    .prepare(
      `SELECT DISTINCT address_key AS key
       FROM organizations
       WHERE deleted = 0
         AND lat IS NULL
         AND address_key IS NOT NULL
         AND address_key NOT IN (
           SELECT cache_key FROM address_cache WHERE failed = 1
         )
       LIMIT ?`,
    )
    .all(limit)
    .map((row) => (row as { key: string }).key)
}

export function sampleAddressForKey(db: Database.Database, addressKey: string) {
  return db
    .prepare(
      `SELECT address_text, postnummer, kommunenummer
       FROM organizations
       WHERE address_key = ?
       LIMIT 1`,
    )
    .get(addressKey) as
    | { address_text: string; postnummer: string; kommunenummer: string }
    | undefined
}

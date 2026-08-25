import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type {
  BrregAddress,
  BrregEntity,
  BrregUnderenhet,
  EntityKind,
  GeocodeQuality,
} from './types.js'
import { addressCacheKey, pickAddressLine, type GeocodeResult } from './geocode.js'
import { employeeBand } from './employeeBands.js'

export function entityAddress(entity: BrregEntity | BrregUnderenhet): BrregAddress | null {
  if ('beliggenhetsadresse' in entity) {
    return entity.beliggenhetsadresse ?? entity.postadresse ?? null
  }
  return (
    ('forretningsadresse' in entity ? entity.forretningsadresse : null) ??
    entity.postadresse ??
    null
  )
}

export function entityKommunenummer(entity: BrregEntity | BrregUnderenhet): string | null {
  const address = entityAddress(entity)
  if (!address?.kommunenummer) return null
  return address.kommunenummer.padStart(4, '0')
}

function stableAddressPayload(address: BrregAddress | null) {
  if (!address) return null
  return {
    adresse: address.adresse ?? null,
    postnummer: address.postnummer ?? null,
    poststed: address.poststed ?? null,
    kommune: address.kommune ?? null,
    kommunenummer: address.kommunenummer ?? null,
    landkode: address.landkode ?? null,
  }
}

/** Stable hash of BRREG fields that affect import / geocoding. */
export function computeBrregContentHash(entity: BrregEntity | BrregUnderenhet): string {
  const isUnderenhet = 'beliggenhetsadresse' in entity
  const payload = {
    navn: entity.navn,
    organisasjonsform: entity.organisasjonsform ?? null,
    address: stableAddressPayload(entityAddress(entity)),
    naeringskode1: entity.naeringskode1 ?? null,
    antallAnsatte: entity.antallAnsatte ?? null,
    harRegistrertAntallAnsatte: entity.harRegistrertAntallAnsatte ?? false,
    erIKonsern: 'erIKonsern' in entity ? (entity.erIKonsern ?? false) : false,
    overordnetEnhet: isUnderenhet
      ? (entity as BrregUnderenhet).overordnetEnhet
      : ((entity as BrregEntity).overordnetEnhet ?? null),
    konkurs: entity.konkurs ?? false,
    underAvvikling: entity.underAvvikling ?? false,
    registrertIMvaregisteret: entity.registrertIMvaregisteret ?? false,
    slettedato: entity.slettedato ?? null,
    entityKind: isUnderenhet ? 'underenhet' : 'enhet',
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function loadBrregHashIndex(db: Database.Database): Map<string, string | null> {
  const rows = db.prepare('SELECT orgnr, brreg_content_hash FROM organizations').all() as Array<{
    orgnr: string
    brreg_content_hash: string | null
  }>
  return new Map(rows.map((row) => [row.orgnr, row.brreg_content_hash]))
}

function baseRecord(
  entity: BrregEntity | BrregUnderenhet,
  entityKind: EntityKind,
  deleted: boolean,
  updatedAt = new Date().toISOString(),
) {
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
    updated_at: updatedAt,
    entity_kind: entityKind,
    overordnet_enhet:
      entityKind === 'underenhet'
        ? (entity as BrregUnderenhet).overordnetEnhet
        : ((entity as BrregEntity).overordnetEnhet ?? null),
    naeringskode: entity.naeringskode1?.kode ?? null,
    naeringskode_label: entity.naeringskode1?.beskrivelse ?? null,
    antall_ansatte: entity.antallAnsatte ?? null,
    har_registrert_antall_ansatte: entity.harRegistrertAntallAnsatte ? 1 : 0,
    er_i_konsern: 'erIKonsern' in entity && entity.erIKonsern ? 1 : 0,
    adresse_id: null as string | null,
    matrikkel_key: null as string | null,
    kommunenummer_geo: null as string | null,
    geocode_quality: null as GeocodeQuality | null,
    employee_band: employeeBand(
      entity.antallAnsatte ?? null,
      entity.harRegistrertAntallAnsatte ?? false,
    ),
    naeringskode_section: entity.naeringskode1?.kode?.slice(0, 2) ?? null,
  }
}

export type OrganizationUpsertRecord = ReturnType<typeof baseRecord> & {
  brreg_content_hash: string
}

export function entityToRecord(entity: BrregEntity, deleted = false, updatedAt?: string) {
  return baseRecord(entity, 'enhet', deleted, updatedAt)
}

export function underenhetToRecord(entity: BrregUnderenhet, deleted = false, updatedAt?: string) {
  return baseRecord(entity, 'underenhet', deleted, updatedAt)
}

export function prepareEntityRecord(
  entity: BrregEntity,
  deleted: boolean,
  updatedAt: string,
): OrganizationUpsertRecord {
  return {
    ...entityToRecord(entity, deleted, updatedAt),
    brreg_content_hash: computeBrregContentHash(entity),
  }
}

export function prepareUnderenhetRecord(
  entity: BrregUnderenhet,
  deleted: boolean,
  updatedAt: string,
): OrganizationUpsertRecord {
  return {
    ...underenhetToRecord(entity, deleted, updatedAt),
    brreg_content_hash: computeBrregContentHash(entity),
  }
}

function existingOrgnr(db: Database.Database, orgnr: string | null | undefined): string | null {
  if (!orgnr) return null
  return db.prepare('SELECT 1 FROM organizations WHERE orgnr = ?').get(orgnr) ? orgnr : null
}

/** Clear parent links that do not resolve to an imported organization row. */
export function nullOrphanOverordnetEnhet(db: Database.Database): number {
  return db
    .prepare(
      `UPDATE organizations
       SET overordnet_enhet = NULL
       WHERE overordnet_enhet IS NOT NULL
         AND overordnet_enhet NOT IN (SELECT orgnr FROM organizations)`,
    )
    .run().changes
}

export interface UpsertOrganizationOptions {
  /** Keep BRREG parent orgnr during bulk import; resolve dangling links after commit. */
  deferParentLink?: boolean
}

const upsertStmt = `
  INSERT INTO organizations (
    orgnr, navn, org_type, org_type_label, address_text, postnummer,
    kommunenummer, address_key, lat, lng, konkurs, under_avvikling,
    vat_registered, deleted, updated_at, entity_kind, overordnet_enhet,
    naeringskode, naeringskode_label, antall_ansatte, har_registrert_antall_ansatte,
    er_i_konsern, adresse_id, matrikkel_key, kommunenummer_geo, geocode_quality,
    employee_band, naeringskode_section, brreg_content_hash
  ) VALUES (
    @orgnr, @navn, @org_type, @org_type_label, @address_text, @postnummer,
    @kommunenummer, @address_key, @lat, @lng, @konkurs, @under_avvikling,
    @vat_registered, @deleted, @updated_at, @entity_kind, @overordnet_enhet,
    @naeringskode, @naeringskode_label, @antall_ansatte, @har_registrert_antall_ansatte,
    @er_i_konsern, @adresse_id, @matrikkel_key, @kommunenummer_geo, @geocode_quality,
    @employee_band, @naeringskode_section, @brreg_content_hash
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
    updated_at = excluded.updated_at,
    entity_kind = excluded.entity_kind,
    overordnet_enhet = excluded.overordnet_enhet,
    naeringskode = excluded.naeringskode,
    naeringskode_label = excluded.naeringskode_label,
    antall_ansatte = excluded.antall_ansatte,
    har_registrert_antall_ansatte = excluded.har_registrert_antall_ansatte,
    er_i_konsern = excluded.er_i_konsern,
    adresse_id = CASE
      WHEN excluded.address_key IS NOT organizations.address_key THEN NULL
      ELSE COALESCE(organizations.adresse_id, excluded.adresse_id)
    END,
    matrikkel_key = CASE
      WHEN excluded.address_key IS NOT organizations.address_key THEN NULL
      ELSE COALESCE(organizations.matrikkel_key, excluded.matrikkel_key)
    END,
    kommunenummer_geo = CASE
      WHEN excluded.address_key IS NOT organizations.address_key THEN NULL
      ELSE COALESCE(organizations.kommunenummer_geo, excluded.kommunenummer_geo)
    END,
    geocode_quality = CASE
      WHEN excluded.address_key IS NOT organizations.address_key THEN NULL
      ELSE COALESCE(organizations.geocode_quality, excluded.geocode_quality)
    END,
    employee_band = excluded.employee_band,
    naeringskode_section = excluded.naeringskode_section,
    brreg_content_hash = excluded.brreg_content_hash
`

const upsertPrepared = new WeakMap<Database.Database, Database.Statement>()

function getUpsertStatement(db: Database.Database): Database.Statement {
  let stmt = upsertPrepared.get(db)
  if (!stmt) {
    stmt = db.prepare(upsertStmt)
    upsertPrepared.set(db, stmt)
  }
  return stmt
}

export function upsertManyOrganizations(
  db: Database.Database,
  records: OrganizationUpsertRecord[],
  options: UpsertOrganizationOptions = {},
): void {
  if (records.length === 0) return

  const insertMany = db.transaction((rows: OrganizationUpsertRecord[]) => {
    const stmt = getUpsertStatement(db)
    for (const record of rows) {
      if (!options.deferParentLink) {
        record.overordnet_enhet = existingOrgnr(db, record.overordnet_enhet)
      }
      stmt.run({ ...record, lat: null, lng: null })
    }
  })

  insertMany(records)
}

export function upsertEntity(
  db: Database.Database,
  entity: BrregEntity,
  deleted = false,
  options: UpsertOrganizationOptions = {},
) {
  upsertManyOrganizations(
    db,
    [prepareEntityRecord(entity, deleted, new Date().toISOString())],
    options,
  )
}

export function upsertUnderenhet(
  db: Database.Database,
  entity: BrregUnderenhet,
  deleted = false,
  options: UpsertOrganizationOptions = {},
) {
  upsertManyOrganizations(
    db,
    [prepareUnderenhetRecord(entity, deleted, new Date().toISOString())],
    options,
  )
}

export function markDeleted(db: Database.Database, orgnr: string) {
  db.prepare(
    `UPDATE organizations
     SET deleted = 1, updated_at = ?
     WHERE orgnr = ?`,
  ).run(new Date().toISOString(), orgnr)
}

export function applyGeocodeResult(
  db: Database.Database,
  addressKey: string,
  result: GeocodeResult,
) {
  db.prepare(
    `UPDATE organizations
     SET lat = ?, lng = ?,
         adresse_id = ?, matrikkel_key = ?,
         kommunenummer_geo = ?, geocode_quality = ?
     WHERE address_key = ? AND deleted = 0`,
  ).run(
    result.lat,
    result.lng,
    result.adresseId ?? null,
    result.matrikkelKey ?? null,
    result.kommunenummer ?? null,
    result.quality,
    addressKey,
  )
}

export function getCachedAddress(
  db: Database.Database,
  cacheKey: string,
): GeocodeResult | null | 'failed' {
  const row = db
    .prepare(
      `SELECT lat, lng, failed, adresse_id, matrikkel_key, kommunenummer_geo, geocode_quality
       FROM address_cache WHERE cache_key = ?`,
    )
    .get(cacheKey) as
    | {
        lat: number | null
        lng: number | null
        failed: number
        adresse_id: string | null
        matrikkel_key: string | null
        kommunenummer_geo: string | null
        geocode_quality: GeocodeQuality | null
      }
    | undefined

  if (!row) return null
  if (row.failed || row.lat == null || row.lng == null) return 'failed'

  return {
    lat: row.lat,
    lng: row.lng,
    adresseId: row.adresse_id ?? undefined,
    matrikkelKey: row.matrikkel_key ?? undefined,
    kommunenummer: row.kommunenummer_geo ?? undefined,
    quality: row.geocode_quality ?? 'fallback',
    method: row.geocode_quality === 'verified' ? 'structured' : 'freeText',
  }
}

export function saveAddressCache(
  db: Database.Database,
  cacheKey: string,
  result: GeocodeResult | null,
) {
  db.prepare(
    `INSERT INTO address_cache (
       cache_key, lat, lng, geocoded_at, failed,
       adresse_id, matrikkel_key, kommunenummer_geo, geocode_quality
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       lat = excluded.lat,
       lng = excluded.lng,
       geocoded_at = excluded.geocoded_at,
       failed = excluded.failed,
       adresse_id = excluded.adresse_id,
       matrikkel_key = excluded.matrikkel_key,
       kommunenummer_geo = excluded.kommunenummer_geo,
       geocode_quality = excluded.geocode_quality`,
  ).run(
    cacheKey,
    result?.lat ?? null,
    result?.lng ?? null,
    new Date().toISOString(),
    result ? 0 : 1,
    result?.adresseId ?? null,
    result?.matrikkelKey ?? null,
    result?.kommunenummer ?? null,
    result?.quality ?? null,
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

/** Geocoded addresses that lack Kartverket metadata (quality, geo kommune, etc.). */
export function pendingMetadataAddressKeys(db: Database.Database, limit: number): string[] {
  return db
    .prepare(
      `SELECT DISTINCT address_key AS key
       FROM organizations
       WHERE deleted = 0
         AND lat IS NOT NULL
         AND geocode_quality IS NULL
         AND address_key IS NOT NULL
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
    { address_text: string; postnummer: string; kommunenummer: string } | undefined
}

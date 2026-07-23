import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { openDatabase, DEFAULT_DB_PATH, effectiveKommunenummerExpr } from './lib/db.js'
import { employeeBand, naeringskodeSection } from './lib/employeeBands.js'
import { exportDistrictColorAssets } from './lib/district-color-export.js'

const outputDir = process.env.STATIC_API_DIR ?? 'public/data/api'

function writeJson(name: string, data: unknown, gzip = false) {
  const json = `${JSON.stringify(data)}\n`
  writeFileSync(join(outputDir, name), json)
  if (gzip) {
    writeFileSync(join(outputDir, `${name}.gz`), gzipSync(json))
  }
}

const db = openDatabase(DEFAULT_DB_PATH)
mkdirSync(outputDir, { recursive: true })

writeJson('health.json', { ok: true })

const orgForms = db
  .prepare(
    `SELECT org_type AS kode, MIN(org_type_label) AS beskrivelse, COUNT(*) AS count
     FROM organizations
     WHERE deleted = 0
     GROUP BY org_type
     ORDER BY beskrivelse`,
  )
  .all() as Array<{ kode: string; beskrivelse: string; count: number }>

writeJson('organisasjonsformer.json', {
  organisasjonsformer: orgForms.map(({ kode, beskrivelse }) => ({ kode, beskrivelse })),
})

const kommuner = db
  .prepare(
    `SELECT kommunenummer AS nummer, COUNT(*) AS count
     FROM organizations
     WHERE deleted = 0 AND kommunenummer IS NOT NULL
     GROUP BY kommunenummer
     ORDER BY kommunenummer`,
  )
  .all()

writeJson('kommuner.json', { kommuner })

const kommuneExpr = effectiveKommunenummerExpr()
const municipalityBreakdown = db
  .prepare(
    `SELECT ${kommuneExpr} AS kommunenummer, org_type, konkurs, under_avvikling, vat_registered,
            substr(naeringskode, 1, 2) AS naeringskode_section,
            CASE
              WHEN har_registrert_antall_ansatte = 0 OR antall_ansatte IS NULL THEN 'unknown'
              WHEN antall_ansatte = 0 THEN '0'
              WHEN antall_ansatte <= 4 THEN '1-4'
              WHEN antall_ansatte <= 19 THEN '5-19'
              ELSE '20+'
            END AS employee_band,
            entity_kind,
            COUNT(*) AS count
     FROM organizations
     WHERE deleted = 0 AND ${kommuneExpr} IS NOT NULL
     GROUP BY kommunenummer, org_type, konkurs, under_avvikling, vat_registered,
              naeringskode_section, employee_band, entity_kind`,
  )
  .all()

writeJson('municipality-breakdown.json', { rows: municipalityBreakdown })

type OrgRow = {
  orgnr: string
  navn: string
  org_type: string
  org_type_label: string
  address_text: string
  postnummer: string
  kommunenummer: string
  lat: number | null
  lng: number | null
  naeringskode: string | null
  naeringskode_label: string | null
  antall_ansatte: number | null
  har_registrert_antall_ansatte: number
  entity_kind: string
  overordnet_enhet: string | null
  er_i_konsern: number
  geocode_quality: string | null
  matrikkel_key: string | null
}

const organizations: Record<string, ReturnType<typeof mapOrganization>> = {}
const searchIndex: Array<
  [string, string, string, string, string, number | null, number | null, string, string]
> = []

const orgRows = db
  .prepare(
    `SELECT orgnr, navn, org_type, org_type_label, address_text, postnummer,
            kommunenummer, lat, lng, naeringskode, naeringskode_label,
            antall_ansatte, har_registrert_antall_ansatte, entity_kind,
            overordnet_enhet, er_i_konsern, geocode_quality, matrikkel_key
     FROM organizations
     WHERE deleted = 0`,
  )
  .iterate() as Iterable<OrgRow>

function mapOrganization(row: OrgRow) {
  return {
    orgnr: row.orgnr,
    navn: row.navn,
    orgType: row.org_type,
    orgTypeLabel: row.org_type_label,
    addressText: row.address_text,
    postnummer: row.postnummer,
    kommunenummer: row.kommunenummer,
    lat: row.lat,
    lng: row.lng,
    naeringskode: row.naeringskode,
    naeringskodeLabel: row.naeringskode_label,
    antallAnsatte: row.antall_ansatte,
    employeeBand: employeeBand(row.antall_ansatte, row.har_registrert_antall_ansatte === 1),
    entityKind: row.entity_kind,
    overordnetEnhet: row.overordnet_enhet,
    erIKonsern: row.er_i_konsern === 1,
    geocodeQuality: row.geocode_quality,
    matrikkelKey: row.matrikkel_key,
  }
}

for (const row of orgRows) {
  organizations[row.orgnr] = mapOrganization(row)
  searchIndex.push([
    row.orgnr,
    row.navn,
    row.org_type,
    row.org_type_label,
    row.kommunenummer,
    row.lat,
    row.lng,
    row.address_text ?? '',
    row.postnummer ?? '',
  ])
}

writeJson('organizations.json', { organizations })
writeJson('search-index.json', { rows: searchIndex }, true)

type GeocodedPointRow = [
  string,
  number,
  number,
  string,
  string,
  number,
  number,
  number,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
]
const geocodedPoints: GeocodedPointRow[] = []

const geocodedRows = db
  .prepare(
    `SELECT orgnr, lng, lat, org_type, org_type_label, navn, address_text, postnummer,
            kommunenummer, konkurs, under_avvikling, vat_registered,
            naeringskode, antall_ansatte, har_registrert_antall_ansatte, entity_kind, er_i_konsern
     FROM organizations
     WHERE deleted = 0 AND lat IS NOT NULL AND lng IS NOT NULL`,
  )
  .iterate() as Iterable<{
  orgnr: string
  lng: number
  lat: number
  org_type: string
  org_type_label: string
  navn: string
  address_text: string
  postnummer: string
  kommunenummer: string
  konkurs: number
  under_avvikling: number
  vat_registered: number
  naeringskode: string | null
  antall_ansatte: number | null
  har_registrert_antall_ansatte: number
  entity_kind: string
  er_i_konsern: number
}>

for (const row of geocodedRows) {
  geocodedPoints.push([
    row.orgnr,
    row.lng,
    row.lat,
    row.org_type,
    row.kommunenummer,
    row.konkurs,
    row.under_avvikling,
    row.vat_registered,
    row.navn,
    row.org_type_label,
    row.address_text ?? '',
    row.postnummer ?? '',
    naeringskodeSection(row.naeringskode) ?? '',
    employeeBand(row.antall_ansatte, row.har_registrert_antall_ansatte === 1),
    row.entity_kind,
  ])
}

writeJson('naeringskoder.json', {
  naeringskoder: db
    .prepare(
      `SELECT substr(naeringskode, 1, 2) AS section,
              MIN(naeringskode_label) AS label,
              COUNT(*) AS count
       FROM organizations
       WHERE deleted = 0
         AND naeringskode IS NOT NULL
         AND length(naeringskode) >= 2
       GROUP BY section
       ORDER BY section`,
    )
    .all(),
})

writeJson('geocoded-points.json', { rows: geocodedPoints }, true)

const districtsManifest = join(process.cwd(), 'public/data/districts/manifest.json')
const skipDistricts =
  process.env.DISTRICTS_SKIP_EXPORT === '1' && existsSync(districtsManifest)

let districtColorsPath = districtsManifest
if (skipDistricts) {
  console.log(`Skipping district color export (using prebuilt ${districtsManifest})`)
} else {
  const districtColors = exportDistrictColorAssets(db, 'public/data/districts')
  districtColorsPath = districtColors.manifestPath
}

console.log(`Exported static API to ${outputDir}`)
console.log(`  ${orgForms.length} org types, ${kommuner.length} kommuner`)
console.log(`  ${municipalityBreakdown.length} municipality breakdown rows`)
console.log(`  ${searchIndex.length.toLocaleString('nb-NO')} organizations`)
console.log(`  ${geocodedPoints.length.toLocaleString('nb-NO')} geocoded points`)
console.log(`  district colors → ${districtColorsPath}`)

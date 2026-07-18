import { mkdirSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { openDatabase, DEFAULT_DB_PATH } from './lib/db.js'

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

const municipalityBreakdown = db
  .prepare(
    `SELECT kommunenummer, org_type, konkurs, under_avvikling, vat_registered, COUNT(*) AS count
     FROM organizations
     WHERE deleted = 0 AND kommunenummer IS NOT NULL
     GROUP BY kommunenummer, org_type, konkurs, under_avvikling, vat_registered`,
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
}

const organizations: Record<string, ReturnType<typeof mapOrganization>> = {}
const searchIndex: Array<
  [string, string, string, string, string, number | null, number | null, string, string]
> = []

const orgRows = db
  .prepare(
    `SELECT orgnr, navn, org_type, org_type_label, address_text, postnummer,
            kommunenummer, lat, lng
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
]
const geocodedPoints: GeocodedPointRow[] = []

const geocodedRows = db
  .prepare(
    `SELECT orgnr, lng, lat, org_type, org_type_label, navn, address_text, postnummer,
            kommunenummer, konkurs, under_avvikling, vat_registered
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
  ])
}

writeJson('geocoded-points.json', { rows: geocodedPoints }, true)

console.log(`Exported static API to ${outputDir}`)
console.log(`  ${orgForms.length} org types, ${kommuner.length} kommuner`)
console.log(`  ${municipalityBreakdown.length} municipality breakdown rows`)
console.log(`  ${searchIndex.length.toLocaleString('nb-NO')} organizations`)
console.log(`  ${geocodedPoints.length.toLocaleString('nb-NO')} geocoded points`)

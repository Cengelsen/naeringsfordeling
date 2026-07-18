import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, DEFAULT_DB_PATH } from './lib/db.js'

const outputDir = process.env.STATIC_API_DIR ?? 'public/data/api'

function writeJson(name: string, data: unknown) {
  writeFileSync(join(outputDir, name), `${JSON.stringify(data)}\n`)
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
const searchIndex: Array<[string, string, string, string, string, number | null, number | null]> = []

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
  ])
}

writeJson('organizations.json', { organizations })
writeJson('search-index.json', { rows: searchIndex })

console.log(`Exported static API to ${outputDir}`)
console.log(`  ${orgForms.length} org types, ${kommuner.length} kommuner`)
console.log(`  ${municipalityBreakdown.length} municipality breakdown rows`)
console.log(`  ${searchIndex.length.toLocaleString('nb-NO')} organizations`)

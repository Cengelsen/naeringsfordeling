import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs'
import { createGzip, gzipSync, type Gzip } from 'node:zlib'
import { join } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import type { Writable } from 'node:stream'
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

function writeChunk(stream: Writable, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      stream.off('drain', onDrain)
      reject(err)
    }
    const onDrain = () => {
      stream.off('error', onError)
      resolve()
    }
    stream.on('error', onError)
    if (stream.write(chunk)) {
      stream.off('error', onError)
      resolve()
    } else {
      stream.once('drain', onDrain)
    }
  })
}

function endWritable(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })
}

/** Stream rows to JSON without holding the full dataset in memory. */
async function writeJsonRows(
  name: string,
  rows: Iterable<unknown>,
  options: { gzip?: boolean; gzipOnly?: boolean } = {},
): Promise<number> {
  const { gzip = false, gzipOnly = false } = options
  const jsonPath = join(outputDir, name)
  const gzPath = `${jsonPath}.gz`

  let stream: Writable
  let gzipStream: Gzip | null = null
  let fileStream: WriteStream | null = null

  if (gzipOnly) {
    gzipStream = createGzip({ level: 9 })
    fileStream = createWriteStream(gzPath)
    gzipStream.pipe(fileStream)
    stream = gzipStream
  } else {
    fileStream = createWriteStream(jsonPath)
    stream = fileStream
  }

  let count = 0
  let first = true

  try {
    await writeChunk(stream, '{"rows":[\n')
    for (const row of rows) {
      if (!first) await writeChunk(stream, ',\n')
      await writeChunk(stream, JSON.stringify(row))
      first = false
      count++
    }
    await writeChunk(stream, '\n]}\n')
    await endWritable(stream)
    if (gzipStream && fileStream) {
      await finished(fileStream)
    }
  } catch (err) {
    stream.destroy()
    fileStream?.destroy()
    throw err
  }

  if (!gzipOnly && gzip) {
    await pipeline(
      createReadStream(jsonPath),
      createGzip({ level: 9 }),
      createWriteStream(gzPath),
    )
  }

  return count
}

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

type SearchIndexRow = [
  string,
  string,
  string,
  string,
  string,
  number | null,
  number | null,
  string,
  string,
]

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

function* iterateSearchIndex(db: ReturnType<typeof openDatabase>): Generator<SearchIndexRow> {
  const orgRows = db
    .prepare(
      `SELECT orgnr, navn, org_type, org_type_label, address_text, postnummer,
              kommunenummer, lat, lng
       FROM organizations
       WHERE deleted = 0`,
    )
    .iterate() as Iterable<OrgRow>

  for (const row of orgRows) {
    yield [
      row.orgnr,
      row.navn,
      row.org_type,
      row.org_type_label,
      row.kommunenummer,
      row.lat,
      row.lng,
      row.address_text ?? '',
      row.postnummer ?? '',
    ]
  }
}

function* iterateGeocodedPoints(db: ReturnType<typeof openDatabase>): Generator<GeocodedPointRow> {
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
    yield [
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
    ]
  }
}

async function main() {
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

  const searchCount = await writeJsonRows('search-index.json', iterateSearchIndex(db), {
    gzipOnly: true,
  })

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

  const geocodedCount = await writeJsonRows('geocoded-points.json', iterateGeocodedPoints(db), {
    gzipOnly: true,
  })

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
  console.log(`  ${searchCount.toLocaleString('nb-NO')} organizations`)
  console.log(`  ${geocodedCount.toLocaleString('nb-NO')} geocoded points`)
  console.log(`  district colors → ${districtColorsPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

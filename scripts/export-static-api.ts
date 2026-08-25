import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createGzip, gzipSync, type Gzip } from 'node:zlib'
import { dirname, join } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import type { Writable } from 'node:stream'
import { openDatabase, DEFAULT_DB_PATH, effectiveKommunenummerExpr } from './lib/db.js'
import { employeeBand, naeringskodeSection } from './lib/employeeBands.js'
import { exportDistrictColorAssets } from './lib/district-color-export.js'

const scriptPath = fileURLToPath(import.meta.url)
const outputDir = process.env.STATIC_API_DIR ?? 'public/data/api'
const phase = process.argv[2]

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
  let fileStream: WriteStream | null = null // eslint-disable-line no-useless-assignment

  if (gzipOnly) {
    gzipStream = createGzip({ level: 6 })
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
      if (count % 250_000 === 0) {
        console.log(`  …${count.toLocaleString('nb-NO')} rows written to ${name}`)
      }
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
    await pipeline(createReadStream(jsonPath), createGzip({ level: 6 }), createWriteStream(gzPath))
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

type MunicipalityBreakdownRow = {
  kommunenummer: string
  org_type: string
  konkurs: number
  under_avvikling: number
  vat_registered: number
  naeringskode_section: string | null
  employee_band: string
  entity_kind: string
  count: number
}

function* iterateMunicipalityBreakdown(
  db: ReturnType<typeof openDatabase>,
): Generator<MunicipalityBreakdownRow> {
  const kommuneExpr = effectiveKommunenummerExpr()
  const rows = db
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
    .iterate() as Iterable<MunicipalityBreakdownRow>

  for (const row of rows) {
    yield row
  }
}

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

async function exportSearchIndexPhase(): Promise<number> {
  const db = openDatabase(DEFAULT_DB_PATH)
  mkdirSync(outputDir, { recursive: true })
  console.log('Exporting search-index.json…')
  const count = await writeJsonRows('search-index.json', iterateSearchIndex(db), { gzipOnly: true })
  db.close()
  return count
}

async function exportGeocodedPointsPhase(): Promise<number> {
  const db = openDatabase(DEFAULT_DB_PATH)
  mkdirSync(outputDir, { recursive: true })
  console.log('Exporting geocoded-points.json…')
  const count = await writeJsonRows('geocoded-points.json', iterateGeocodedPoints(db), {
    gzipOnly: true,
  })
  db.close()
  return count
}

const projectRoot = join(dirname(scriptPath), '..')

function runPhaseInChild(phaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('yarn', ['tsx', scriptPath, phaseName], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=6144',
      },
      cwd: projectRoot,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `export-static-api ${phaseName} failed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      )
    })
  })
}

async function main() {
  if (phase === 'search-index') {
    const count = await exportSearchIndexPhase()
    console.log(`search-index: ${count.toLocaleString('nb-NO')} organizations`)
    return
  }

  if (phase === 'geocoded-points') {
    const count = await exportGeocodedPointsPhase()
    console.log(`geocoded-points: ${count.toLocaleString('nb-NO')} points`)
    return
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

  console.log('Exporting municipality-breakdown.json…')
  const breakdownCount = await writeJsonRows(
    'municipality-breakdown.json',
    iterateMunicipalityBreakdown(db),
  )

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

  db.close()

  await runPhaseInChild('search-index')

  const skipGeocodedPoints =
    process.env.GEOCODED_POINTS_SKIP_EXPORT === '1' ||
    existsSync(join(outputDir, 'geocoded-points.json.gz'))
  if (skipGeocodedPoints) {
    console.log('Skipping geocoded-points export (GEOCODED_POINTS_SKIP_EXPORT=1)')
  } else {
    await runPhaseInChild('geocoded-points')
  }

  const districtsManifest = join(process.cwd(), 'public/data/districts/manifest.json')
  const skipDistricts = process.env.DISTRICTS_SKIP_EXPORT === '1' && existsSync(districtsManifest)

  let districtColorsPath = districtsManifest
  if (skipDistricts) {
    console.log(`Skipping district color export (using prebuilt ${districtsManifest})`)
  } else {
    const districtDb = openDatabase(DEFAULT_DB_PATH)
    const districtColors = exportDistrictColorAssets(districtDb, 'public/data/districts')
    districtDb.close()
    districtColorsPath = districtColors.manifestPath
  }

  console.log(`Exported static API to ${outputDir}`)
  console.log(`  ${orgForms.length} org types, ${kommuner.length} kommuner`)
  console.log(`  ${breakdownCount.toLocaleString('nb-NO')} municipality breakdown rows`)
  console.log(`  district colors → ${districtColorsPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

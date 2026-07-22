#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, DEFAULT_DB_PATH, effectiveKommunenummerExpr } from './lib/db.js'
import { employeeBand, naeringskodeSection } from './lib/employeeBands.js'

const TIPPECANOE_ARGS = [
  '-z14',
  '-P',
  '--drop-densest-as-needed',
  '--coalesce-densest-as-needed',
  '--extend-zooms-if-still-dropping',
  '--maximum-tile-bytes=2000000',
  '--no-tile-compression',
  '--force',
]

function runTippecanoe(outputPath: string, ndjsonPath: string, layerName: string) {
  return spawnSync(
    'tippecanoe',
    [...TIPPECANOE_ARGS, '-l', layerName, '-o', outputPath, ndjsonPath],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
}

function ensurePmtilesCli(): string {
  const fromPath = spawnSync('sh', ['-c', 'command -v pmtiles'], { encoding: 'utf8' })
  const existing = fromPath.stdout.trim()
  if (existing) return existing

  const binDir = join(process.cwd(), '.cache', 'bin')
  mkdirSync(binDir, { recursive: true })
  const localPath = join(binDir, 'pmtiles')

  if (existsSync(localPath)) return localPath

  console.log('Downloading PMTiles CLI…')
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  const platform = process.platform === 'linux' ? 'Linux' : process.platform === 'darwin' ? 'Darwin' : ''
  if (!platform) {
    throw new Error('PMTiles CLI not found. Install from https://github.com/protomaps/go-pmtiles')
  }

  const version = 'v1.31.1'
  const url = `https://github.com/protomaps/go-pmtiles/releases/download/${version}/go-pmtiles_1.31.1_${platform}_${arch}.tar.gz`
  const download = spawnSync('curl', ['-fsSL', url, '-o', '/tmp/pmtiles.tar.gz'], { encoding: 'utf8' })
  if (download.status !== 0) {
    throw new Error(download.stderr || 'Failed to download PMTiles CLI')
  }

  const extract = spawnSync('tar', ['-xzf', '/tmp/pmtiles.tar.gz', '-C', binDir, 'pmtiles'], {
    encoding: 'utf8',
  })
  if (extract.status !== 0) {
    throw new Error(extract.stderr || 'Failed to extract PMTiles CLI')
  }

  return localPath
}

function cleanupPartialOutputs(outputDir: string) {
  for (const name of ['points.pmtiles', 'points.mbtiles']) {
    rmSync(join(outputDir, name), { force: true })
    rmSync(join(outputDir, `${name}-journal`), { force: true })
  }
}

async function main() {
  const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH
  const outputDir = process.env.POINTS_OUTPUT_DIR ?? 'public/data'
  const pmtilesPath = join(outputDir, 'points.pmtiles')
  const mbtilesPath = join(outputDir, 'points.mbtiles')
  const manifestPath = join(outputDir, 'points', 'manifest.json')
  const layerName = 'organizations'

  cleanupPartialOutputs(outputDir)

  const db = openDatabase(dbPath)

  const rows = db
    .prepare(
      `SELECT orgnr, org_type, lat, lng, naeringskode, antall_ansatte,
              har_registrert_antall_ansatte, entity_kind
       FROM organizations
       WHERE deleted = 0
         AND konkurs = 0
         AND under_avvikling = 0
         AND lat IS NOT NULL
         AND lng IS NOT NULL`,
    )
    .iterate() as Iterable<{
    orgnr: string
    org_type: string
    lat: number
    lng: number
    naeringskode: string | null
    antall_ansatte: number | null
    har_registrert_antall_ansatte: number
    entity_kind: string
  }>

  mkdirSync(outputDir, { recursive: true })
  mkdirSync(join(outputDir, 'points'), { recursive: true })

  const ndjsonPath = join(tmpdir(), `naeringsfordeling-points-${Date.now()}.ndjson`)
  const ndjson = createWriteStream(ndjsonPath)

  let total = 0
  const orgTypes = new Set<string>()

  for (const row of rows) {
    orgTypes.add(row.org_type)
    ndjson.write(
      `${JSON.stringify({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [row.lng, row.lat],
        },
        properties: {
          orgnr: row.orgnr,
          orgType: row.org_type,
          naeringskode: naeringskodeSection(row.naeringskode) ?? '',
          employeeBand: employeeBand(row.antall_ansatte, row.har_registrert_antall_ansatte === 1),
          entityKind: row.entity_kind,
        },
      })}\n`,
    )
    total += 1
  }

  await new Promise<void>((resolve, reject) => {
    ndjson.end((error) => (error ? reject(error) : resolve()))
  })

  console.log(`Exported ${total.toLocaleString('nb-NO')} features to ${ndjsonPath}`)
  console.log('Running tippecanoe (mbtiles)…')

  const mbtiles = runTippecanoe(mbtilesPath, ndjsonPath, layerName)
  if (mbtiles.stdout) process.stdout.write(mbtiles.stdout)
  if (mbtiles.error || mbtiles.status !== 0) {
    if (mbtiles.stderr) process.stderr.write(mbtiles.stderr)
    cleanupPartialOutputs(outputDir)
    console.error('\nTippecanoe failed. Install from https://github.com/felt/tippecanoe')
    process.exit(1)
  }

  const pmtilesCli = ensurePmtilesCli()
  console.log('Converting mbtiles → PMTiles…')

  const convert = spawnSync(pmtilesCli, ['convert', mbtilesPath, pmtilesPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (convert.stdout) process.stdout.write(convert.stdout)
  if (convert.error || convert.status !== 0) {
    if (convert.stderr) process.stderr.write(convert.stderr)
    cleanupPartialOutputs(outputDir)
    console.error('\nPMTiles conversion failed.')
    process.exit(1)
  }

  rmSync(mbtilesPath, { force: true })
  rmSync(`${mbtilesPath}-journal`, { force: true })

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        total,
        layer: layerName,
        format: 'pmtiles',
        path: '/data/points.pmtiles',
        filters: {
          excludeKonkurs: true,
          excludeUnderAvvikling: true,
          vatRegisteredOnly: false,
        },
        orgTypes: [...orgTypes].sort(),
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )

  rmSync(ndjsonPath, { force: true })

  console.log(`Wrote ${pmtilesPath}`)
  console.log(`Wrote ${manifestPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

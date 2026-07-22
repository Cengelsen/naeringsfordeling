#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, DEFAULT_DB_PATH } from './lib/db.js'
import {
  collectOrgTypes,
  countGeocodedPoints,
  exportLodAggregateNdjson,
  exportPointsNdjson,
} from './lib/lod-aggregate.js'
import {
  LOD_BANDS,
  LOD_LAYER_NAMES,
  LOD_ZOOM_RANGES,
  layerNameForBand,
  type LodBand,
} from './lib/lod-grid.js'

const SHARED_TIPPECANOE_ARGS = ['-P', '--no-tile-compression', '--force', '--no-feature-limit']

function runTippecanoe(
  outputPath: string,
  ndjsonPath: string,
  layerName: string,
  minZoom: number,
  maxZoom: number,
  extraArgs: string[] = [],
) {
  return spawnSync(
    'tippecanoe',
    [
      ...SHARED_TIPPECANOE_ARGS,
      ...extraArgs,
      `-Z${minZoom}`,
      `-z${maxZoom}`,
      '-l',
      layerName,
      '-o',
      outputPath,
      ndjsonPath,
    ],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  )
}

function runTileJoin(outputPath: string, inputs: string[]) {
  return spawnSync('tile-join', ['-o', outputPath, '--force', ...inputs], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
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

async function writeNdjson(
  path: string,
  write: (stream: ReturnType<typeof createWriteStream>) => void | Promise<void>,
): Promise<void> {
  const stream = createWriteStream(path)
  await write(stream)
  await new Promise<void>((resolve, reject) => {
    stream.end((error) => (error ? reject(error) : resolve()))
  })
}

async function main() {
  const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH
  const outputDir = process.env.POINTS_OUTPUT_DIR ?? 'public/data'
  const pmtilesPath = join(outputDir, 'points.pmtiles')
  const mbtilesPath = join(outputDir, 'points.mbtiles')
  const manifestPath = join(outputDir, 'points', 'manifest.json')
  const tempPrefix = join(tmpdir(), `naeringsfordeling-lod-${Date.now()}`)

  cleanupPartialOutputs(outputDir)
  mkdirSync(outputDir, { recursive: true })
  mkdirSync(join(outputDir, 'points'), { recursive: true })

  const db = openDatabase(dbPath)
  const total = countGeocodedPoints(db)
  const orgTypes = collectOrgTypes(db)

  const bandMbtiles: string[] = []
  const tempFiles: string[] = []

  for (const band of LOD_BANDS) {
    const ndjsonPath = `${tempPrefix}-${band}.ndjson`
    tempFiles.push(ndjsonPath)
    const layerName = layerNameForBand(band)
    const { minZoom, maxZoom } = LOD_ZOOM_RANGES[band]

    console.log(`Exporting ${band} aggregate NDJSON…`)
    await writeNdjson(ndjsonPath, (stream) => {
      const stats = exportLodAggregateNdjson(db, stream, band)
      console.log(
        `  ${band}: ${stats.cells.toLocaleString('nb-NO')} cells, ${stats.features.toLocaleString('nb-NO')} features`,
      )
    })

    const bandMbtilesPath = `${tempPrefix}-${band}.mbtiles`
    tempFiles.push(bandMbtilesPath)
    console.log(`Running tippecanoe for ${layerName} (z${minZoom}-z${maxZoom})…`)

    const result = runTippecanoe(bandMbtilesPath, ndjsonPath, layerName, minZoom, maxZoom, [
      '--maximum-tile-bytes=2000000',
    ])
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.error || result.status !== 0) {
      if (result.stderr) process.stderr.write(result.stderr)
      throw new Error(`Tippecanoe failed for ${layerName}`)
    }
    bandMbtiles.push(bandMbtilesPath)
  }

  const pointsNdjsonPath = `${tempPrefix}-points.ndjson`
  tempFiles.push(pointsNdjsonPath)
  console.log('Exporting individual points NDJSON…')
  await writeNdjson(pointsNdjsonPath, (stream) => {
    const count = exportPointsNdjson(db, stream)
    console.log(`  ${count.toLocaleString('nb-NO')} point features`)
  })

  const pointsMbtilesPath = `${tempPrefix}-points.mbtiles`
  tempFiles.push(pointsMbtilesPath)
  const pointsRange = LOD_ZOOM_RANGES.points
  console.log(
    `Running tippecanoe for ${LOD_LAYER_NAMES.points} (z${pointsRange.minZoom}-z${pointsRange.maxZoom})…`,
  )

  const pointsResult = runTippecanoe(
    pointsMbtilesPath,
    pointsNdjsonPath,
    LOD_LAYER_NAMES.points,
    pointsRange.minZoom,
    pointsRange.maxZoom,
    [
      '--drop-densest-as-needed',
      '--coalesce-densest-as-needed',
      '--maximum-tile-bytes=2000000',
    ],
  )
  if (pointsResult.stdout) process.stdout.write(pointsResult.stdout)
  if (pointsResult.error || pointsResult.status !== 0) {
    if (pointsResult.stderr) process.stderr.write(pointsResult.stderr)
    throw new Error('Tippecanoe failed for organizations layer')
  }
  bandMbtiles.push(pointsMbtilesPath)

  console.log('Joining MBTiles layers…')
  const joinResult = runTileJoin(mbtilesPath, bandMbtiles)
  if (joinResult.stdout) process.stdout.write(joinResult.stdout)
  if (joinResult.error || joinResult.status !== 0) {
    if (joinResult.stderr) process.stderr.write(joinResult.stderr)
    throw new Error('tile-join failed. Install tippecanoe (includes tile-join).')
  }

  const pmtilesCli = ensurePmtilesCli()
  console.log('Converting mbtiles → PMTiles…')
  const convert = spawnSync(pmtilesCli, ['convert', mbtilesPath, pmtilesPath], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  if (convert.stdout) process.stdout.write(convert.stdout)
  if (convert.error || convert.status !== 0) {
    if (convert.stderr) process.stderr.write(convert.stderr)
    throw new Error('PMTiles conversion failed.')
  }

  rmSync(mbtilesPath, { force: true })
  rmSync(`${mbtilesPath}-journal`, { force: true })

  const layers = [
    ...LOD_BANDS.map((band: LodBand) => ({
      name: layerNameForBand(band),
      minZoom: LOD_ZOOM_RANGES[band].minZoom,
      maxZoom: LOD_ZOOM_RANGES[band].maxZoom,
    })),
    {
      name: LOD_LAYER_NAMES.points,
      minZoom: LOD_ZOOM_RANGES.points.minZoom,
      maxZoom: LOD_ZOOM_RANGES.points.maxZoom,
    },
  ]

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        total,
        layer: LOD_LAYER_NAMES.points,
        format: 'pmtiles',
        path: '/data/points.pmtiles',
        layers,
        filters: {
          excludeKonkurs: true,
          excludeUnderAvvikling: true,
          vatRegisteredOnly: false,
          entityKinds: ['enhet'],
        },
        orgTypes,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )

  for (const file of tempFiles) {
    rmSync(file, { force: true })
  }

  console.log(`Wrote ${pmtilesPath}`)
  console.log(`Wrote ${manifestPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

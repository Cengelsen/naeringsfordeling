#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, DEFAULT_DB_PATH } from './lib/db.js'
import {
  collectOrgTypes,
  countGeocodedPoints,
  exportPointsNdjson,
} from './lib/lod-aggregate.js'
import { exportDistrictPolyNdjson } from './lib/lod-districts.js'
import { exportGrunnkretsPolyNdjson } from './lib/lod-grunnkretser.js'
import { exportDistrictColorAssets } from './lib/district-color-export.js'
import { LOD_EXPORT_LAYERS, LOD_LAYER_NAMES, LOD_ZOOM_RANGES } from './lib/lod-grid.js'

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
  write: (stream: ReturnType<typeof createWriteStream>) => void,
): Promise<void> {
  const stream = createWriteStream(path)
  write(stream)
  await new Promise<void>((resolve, reject) => {
    stream.end((error) => (error ? reject(error) : resolve()))
  })
}

async function exportLayerMbtiles(
  tempPrefix: string,
  suffix: string,
  layerName: string,
  minZoom: number,
  maxZoom: number,
  writeNdjsonContent: (stream: ReturnType<typeof createWriteStream>) => void,
  extraArgs: string[] = [],
): Promise<{ ndjsonPath: string; mbtilesPath: string }> {
  const ndjsonPath = `${tempPrefix}-${suffix}.ndjson`
  const mbtilesPath = `${tempPrefix}-${suffix}.mbtiles`

  console.log(`Exporting ${layerName}…`)
  await writeNdjson(ndjsonPath, writeNdjsonContent)

  console.log(`Running tippecanoe for ${layerName} (z${minZoom}-z${maxZoom})…`)
  const result = runTippecanoe(mbtilesPath, ndjsonPath, layerName, minZoom, maxZoom, extraArgs)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.error || result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr)
    throw new Error(`Tippecanoe failed for ${layerName}`)
  }

  return { ndjsonPath, mbtilesPath }
}

async function main() {
  const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH
  console.log(`Database: ${dbPath}`)
  console.log('Output: hele landet (alle geokodede orgs i valgt database)')
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

  console.log('Exporting district color GeoJSON (predefined geography)…')
  const districtColors = exportDistrictColorAssets(db, join(outputDir, 'districts'))
  console.log(`  Wrote ${districtColors.manifestPath}`)

  const bandMbtiles: string[] = []
  const tempFiles: string[] = []

  for (const spec of LOD_EXPORT_LAYERS) {
    if (spec.kind === 'district') {
      const poly = await exportLayerMbtiles(
        tempPrefix,
        `${spec.level}-poly`,
        spec.polyLayer,
        spec.minZoom,
        spec.maxZoom,
        (stream) => {
          const stats = exportDistrictPolyNdjson(db, stream, spec.level)
          console.log(
            `  ${spec.polyLayer}: ${stats.polygonFeatures.toLocaleString('nb-NO')} polygon features`,
          )
        },
      )
      tempFiles.push(poly.ndjsonPath, poly.mbtilesPath)
      bandMbtiles.push(poly.mbtilesPath)
      continue
    }

    if (spec.kind === 'grunnkretser') {
      const layer = await exportLayerMbtiles(
        tempPrefix,
        'grunnkretser',
        spec.polyLayer,
        spec.minZoom,
        spec.maxZoom,
        (stream) => {
          const stats = exportGrunnkretsPolyNdjson(db, stream)
          console.log(
            `  ${spec.polyLayer}: ${stats.polygonFeatures.toLocaleString('nb-NO')} polygon features (${stats.grunnkretser.toLocaleString('nb-NO')} grunnkretser loaded)`,
          )
        },
        ['--maximum-tile-bytes=2000000'],
      )
      tempFiles.push(layer.ndjsonPath, layer.mbtilesPath)
      bandMbtiles.push(layer.mbtilesPath)
      continue
    }

    const points = await exportLayerMbtiles(
      tempPrefix,
      'organizations',
      spec.layer,
      spec.minZoom,
      spec.maxZoom,
      (stream) => {
        const count = exportPointsNdjson(db, stream)
        console.log(`  ${spec.layer}: ${count.toLocaleString('nb-NO')} individual addresses`)
      },
      ['--drop-densest-as-needed', '--coalesce-densest-as-needed', '--maximum-tile-bytes=2000000'],
    )
    tempFiles.push(points.ndjsonPath, points.mbtilesPath)
    bandMbtiles.push(points.mbtilesPath)
  }

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
    { name: LOD_LAYER_NAMES.fylkePoly, minZoom: LOD_ZOOM_RANGES.fylke.minZoom, maxZoom: LOD_ZOOM_RANGES.fylke.maxZoom },
    { name: LOD_LAYER_NAMES.kommunePoly, minZoom: LOD_ZOOM_RANGES.kommune.minZoom, maxZoom: LOD_ZOOM_RANGES.kommune.maxZoom },
    { name: LOD_LAYER_NAMES.grunnkretserPoly, minZoom: LOD_ZOOM_RANGES.grunnkretser.minZoom, maxZoom: LOD_ZOOM_RANGES.grunnkretser.maxZoom },
    { name: LOD_LAYER_NAMES.points, minZoom: LOD_ZOOM_RANGES.points.minZoom, maxZoom: LOD_ZOOM_RANGES.points.maxZoom },
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

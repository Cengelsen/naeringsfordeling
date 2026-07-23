import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import type { FeatureCollection } from 'geojson'
import type Database from 'better-sqlite3'
import { buildDistrictFeatures, loadOrgCountsByDistrict } from './lod-districts-export.js'
import { bakeAggregateProps } from './lod-color.js'
import { buildGrunnkretsColorGeoJson } from './grunnkretser-export.js'
import { LOD_ZOOM_RANGES } from './lod-grid.js'

function buildDistrictColorGeoJson(
  db: Database.Database,
  level: 'fylke' | 'kommune',
): FeatureCollection {
  const districts = buildDistrictFeatures(level)
  const countsByDistrict = loadOrgCountsByDistrict(db, level)
  const features: FeatureCollection['features'] = []

  for (const district of districts) {
    const typeCounts = countsByDistrict.get(district.districtId)
    if (!typeCounts || typeCounts.size === 0) continue
    const baked = bakeAggregateProps(typeCounts)
    if (!baked) continue

    features.push({
      type: 'Feature',
      geometry: district.geometry,
      properties: {
        color: baked.color,
        count: baked.count,
        total: baked.count,
        dominantOrgType: baked.dominantOrgType,
        orgTypeBreakdown: baked.orgTypeBreakdown,
        districtId: district.districtId,
        districtLevel: level,
        label: district.label,
      },
    })
  }

  return { type: 'FeatureCollection', features }
}

export function exportDistrictColorAssets(
  db: Database.Database,
  outputDir = 'public/data/districts',
): { total: number; manifestPath: string } {
  mkdirSync(outputDir, { recursive: true })

  const fylke = buildDistrictColorGeoJson(db, 'fylke')
  const kommune = buildDistrictColorGeoJson(db, 'kommune')
  console.log('Building grunnkrets district colors…')
  const grunnkretser = buildGrunnkretsColorGeoJson(db)
  const grunnkretserDir = join(outputDir, 'grunnkretser')
  mkdirSync(grunnkretserDir, { recursive: true })

  const byFylke = new Map<string, FeatureCollection['features']>()
  for (const feature of grunnkretser.features) {
    const kommunenummer = feature.properties?.kommunenummer as string | undefined
    if (!kommunenummer) continue
    const fylke = kommunenummer.slice(0, 2)
    const bucket = byFylke.get(fylke) ?? []
    bucket.push(feature)
    byFylke.set(fylke, bucket)
  }

  for (const [fylke, features] of byFylke.entries()) {
    const json = JSON.stringify({ type: 'FeatureCollection', features })
    writeFileSync(join(grunnkretserDir, `${fylke}.geojson.gz`), gzipSync(json))
  }

  writeFileSync(join(outputDir, 'fylke.geojson'), JSON.stringify(fylke))
  writeFileSync(join(outputDir, 'kommune.geojson'), JSON.stringify(kommune))

  const grunnkretserJson = JSON.stringify(grunnkretser)
  writeFileSync(join(outputDir, 'grunnkretser.geojson.gz'), gzipSync(grunnkretserJson))

  for (const stale of [
    'supercells-medium.geojson',
    'supercells-fine.geojson',
    'grunnkretser.geojson',
  ]) {
    rmSync(join(outputDir, stale), { force: true })
  }

  const total = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM organizations
       WHERE deleted = 0
         AND konkurs = 0
         AND under_avvikling = 0
         AND lat IS NOT NULL
         AND lng IS NOT NULL
         AND entity_kind = 'enhet'`,
    )
    .get() as { count: number }

  const orgTypes = db
    .prepare(
      `SELECT DISTINCT org_type AS org_type
       FROM organizations
       WHERE deleted = 0
         AND konkurs = 0
         AND under_avvikling = 0
         AND lat IS NOT NULL
         AND lng IS NOT NULL
         AND entity_kind = 'enhet'
       ORDER BY org_type`,
    )
    .all() as Array<{ org_type: string }>

  const manifest = {
    total: total.count,
    orgTypes: orgTypes.map((row) => row.org_type),
    layers: [
      {
        id: 'fylke',
        path: '/data/districts/fylke.geojson',
        minZoom: LOD_ZOOM_RANGES.fylke.minZoom,
        maxZoom: LOD_ZOOM_RANGES.fylke.maxZoom,
        features: fylke.features.length,
      },
      {
        id: 'kommune',
        path: '/data/districts/kommune.geojson',
        minZoom: LOD_ZOOM_RANGES.kommune.minZoom,
        maxZoom: LOD_ZOOM_RANGES.kommune.maxZoom,
        features: kommune.features.length,
      },
      {
        id: 'grunnkretser',
        path: '/data/districts/grunnkretser.geojson',
        byFylke: true,
        fylkePathTemplate: '/data/districts/grunnkretser/{fylke}.geojson',
        minZoom: LOD_ZOOM_RANGES.grunnkretser.minZoom,
        maxZoom: LOD_ZOOM_RANGES.grunnkretser.maxZoom,
        features: grunnkretser.features.length,
      },
    ],
    generatedAt: new Date().toISOString(),
  }

  const manifestPath = join(outputDir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  return { total: total.count, manifestPath }
}

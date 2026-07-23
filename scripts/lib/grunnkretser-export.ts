import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FeatureCollection } from 'geojson'
import type Database from 'better-sqlite3'
import {
  buildSpatialGridIndex,
  findItemAtLocation,
  geometryBounds,
  roundGeometryCoordinates,
  type AreaGeometry,
  type Bounds,
} from './geo-utils.js'
import { bakeAggregateProps } from './lod-color.js'

export type OrgTypeCounts = Map<string, number>

export interface GrunnkretsFeature {
  grunnkretsnummer: string
  grunnkretsnavn: string
  kommunenummer: string
  geometry: AreaGeometry
  bounds: Bounds
}

function loadGrunnkretserGeojson(): FeatureCollection {
  const geojsonPath = join(process.cwd(), 'public/data/grunnkretser.geojson')
  if (!existsSync(geojsonPath)) {
    throw new Error(`Missing ${geojsonPath}. Run yarn download-grunnkretser first.`)
  }

  const raw = JSON.parse(readFileSync(geojsonPath, 'utf8')) as
    | FeatureCollection
    | { Grunnkrets?: FeatureCollection }

  if ('Grunnkrets' in raw && raw.Grunnkrets?.features) {
    return raw.Grunnkrets
  }

  return raw as FeatureCollection
}

export function buildGrunnkretsFeatures(): GrunnkretsFeature[] {
  const geojson = loadGrunnkretserGeojson()
  const features: GrunnkretsFeature[] = []

  for (const feature of geojson.features) {
    const grunnkretsnummer = feature.properties?.grunnkretsnummer as string | undefined
    const kommunenummer = feature.properties?.kommunenummer as string | undefined
    if (!grunnkretsnummer || !kommunenummer || feature.geometry.type === 'GeometryCollection') {
      continue
    }

    const geometry = feature.geometry as AreaGeometry
    const bounds = geometryBounds(geometry)
    if (!bounds) continue

    features.push({
      grunnkretsnummer,
      grunnkretsnavn:
        (feature.properties?.grunnkretsnavn as string | undefined) ?? grunnkretsnummer,
      kommunenummer,
      geometry,
      bounds,
    })
  }

  return features.sort((a, b) => a.grunnkretsnummer.localeCompare(b.grunnkretsnummer))
}

export function loadOrgCountsByGrunnkrets(
  db: Database.Database,
  grunnkretser: GrunnkretsFeature[],
): Map<string, OrgTypeCounts> {
  const spatialIndex = buildSpatialGridIndex(grunnkretser)
  const byGrunnkrets = new Map<string, OrgTypeCounts>()

  const rows = db
    .prepare(
      `SELECT org_type, lat, lng
       FROM organizations
       WHERE deleted = 0
         AND konkurs = 0
         AND under_avvikling = 0
         AND lat IS NOT NULL
         AND lng IS NOT NULL
         AND entity_kind = 'enhet'`,
    )
    .iterate() as Iterable<{ org_type: string; lat: number; lng: number }>

  let matched = 0
  let total = 0
  for (const row of rows) {
    total += 1
    const grunnkrets = findItemAtLocation(spatialIndex, row.lat, row.lng)
    if (!grunnkrets) continue

    matched += 1
    let bucket = byGrunnkrets.get(grunnkrets.grunnkretsnummer)
    if (!bucket) {
      bucket = new Map()
      byGrunnkrets.set(grunnkrets.grunnkretsnummer, bucket)
    }
    bucket.set(row.org_type, (bucket.get(row.org_type) ?? 0) + 1)
  }

  console.log(
    `  Grunnkretser: matched ${matched.toLocaleString('nb-NO')} / ${total.toLocaleString('nb-NO')} geocoded orgs`,
  )

  return byGrunnkrets
}

export function buildGrunnkretsColorGeoJson(db: Database.Database): FeatureCollection {
  const grunnkretser = buildGrunnkretsFeatures()
  console.log(`  Loaded ${grunnkretser.length.toLocaleString('nb-NO')} grunnkretser boundaries`)
  const countsByGrunnkrets = loadOrgCountsByGrunnkrets(db, grunnkretser)
  const features: FeatureCollection['features'] = []

  for (const grunnkrets of grunnkretser) {
    const typeCounts = countsByGrunnkrets.get(grunnkrets.grunnkretsnummer)
    if (!typeCounts || typeCounts.size === 0) continue

    const baked = bakeAggregateProps(typeCounts)
    if (!baked) continue

    features.push({
      type: 'Feature',
      geometry: roundGeometryCoordinates(grunnkrets.geometry),
      properties: {
        color: baked.color,
        count: baked.count,
        total: baked.count,
        dominantOrgType: baked.dominantOrgType,
        orgTypeBreakdown: baked.orgTypeBreakdown,
        districtId: grunnkrets.grunnkretsnummer,
        districtLevel: 'grunnkrets',
        label: grunnkrets.grunnkretsnavn,
        kommunenummer: grunnkrets.kommunenummer,
      },
    })
  }

  return { type: 'FeatureCollection', features }
}

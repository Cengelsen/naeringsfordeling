import type { WriteStream } from 'node:fs'
import type Database from 'better-sqlite3'
import { bakeAggregateProps } from './lod-color.js'
import {
  buildDistrictFeatures,
  loadOrgCountsByDistrict,
  type DistrictLevel,
} from './lod-districts-export.js'

function aggregateProperties(
  typeCounts: Map<string, number>,
  extras: Record<string, string | number>,
): Record<string, string | number> | null {
  const baked = bakeAggregateProps(typeCounts)
  if (!baked) return null
  return {
    color: baked.color,
    count: baked.count,
    total: baked.count,
    dominantOrgType: baked.dominantOrgType,
    orgTypeBreakdown: baked.orgTypeBreakdown,
    ...extras,
  }
}

export function exportDistrictPolyNdjson(
  db: Database.Database,
  stream: WriteStream,
  level: DistrictLevel,
): { districts: number; polygonFeatures: number } {
  const districts = buildDistrictFeatures(level)
  const countsByDistrict = loadOrgCountsByDistrict(db, level)

  let polygonFeatures = 0

  for (const district of districts) {
    const typeCounts = countsByDistrict.get(district.districtId)
    if (!typeCounts || typeCounts.size === 0) continue

    const properties = aggregateProperties(typeCounts, {
      districtId: district.districtId,
      districtLevel: level,
      label: district.label,
    })
    if (!properties) continue

    stream.write(
      `${JSON.stringify({
        type: 'Feature',
        geometry: district.geometry,
        properties,
      })}\n`,
    )
    polygonFeatures += 1
  }

  return { districts: districts.length, polygonFeatures }
}

export function exportDistrictPointsNdjson(
  db: Database.Database,
  stream: WriteStream,
  level: DistrictLevel,
): { districts: number; pointFeatures: number } {
  const districts = buildDistrictFeatures(level)
  const countsByDistrict = loadOrgCountsByDistrict(db, level)

  let pointFeatures = 0

  for (const district of districts) {
    const typeCounts = countsByDistrict.get(district.districtId)
    if (!typeCounts || typeCounts.size === 0) continue

    const properties = aggregateProperties(typeCounts, {
      districtId: district.districtId,
      districtLevel: level,
      label: district.label,
    })
    if (!properties) continue

    const centerLng = (district.bounds.minLng + district.bounds.maxLng) / 2
    const centerLat = (district.bounds.minLat + district.bounds.maxLat) / 2
    stream.write(
      `${JSON.stringify({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [centerLng, centerLat] },
        properties,
      })}\n`,
    )
    pointFeatures += 1
  }

  return { districts: districts.length, pointFeatures }
}

/** @deprecated Use exportDistrictPolyNdjson + exportDistrictPointsNdjson */
export function exportDistrictNdjson(
  db: Database.Database,
  stream: WriteStream,
  level: DistrictLevel,
): { districts: number; polygonFeatures: number; pointFeatures: number } {
  const poly = exportDistrictPolyNdjson(db, stream, level)
  const points = exportDistrictPointsNdjson(db, stream, level)
  return {
    districts: poly.districts,
    polygonFeatures: poly.polygonFeatures,
    pointFeatures: points.pointFeatures,
  }
}

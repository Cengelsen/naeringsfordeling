import type { WriteStream } from 'node:fs'
import type Database from 'better-sqlite3'
import { bakeAggregateProps } from './lod-color.js'
import {
  buildGrunnkretsFeatures,
  loadOrgCountsByGrunnkrets,
} from './grunnkretser-export.js'

export function exportGrunnkretsPolyNdjson(
  db: Database.Database,
  stream: WriteStream,
): { grunnkretser: number; polygonFeatures: number } {
  const grunnkretser = buildGrunnkretsFeatures()
  const countsByGrunnkrets = loadOrgCountsByGrunnkrets(db, grunnkretser)
  let polygonFeatures = 0

  for (const grunnkrets of grunnkretser) {
    const typeCounts = countsByGrunnkrets.get(grunnkrets.grunnkretsnummer)
    if (!typeCounts || typeCounts.size === 0) continue

    const baked = bakeAggregateProps(typeCounts)
    if (!baked) continue

    stream.write(
      `${JSON.stringify({
        type: 'Feature',
        geometry: grunnkrets.geometry,
        properties: {
          color: baked.color,
          count: baked.count,
          dominantOrgType: baked.dominantOrgType,
          orgTypeBreakdown: baked.orgTypeBreakdown,
          districtId: grunnkrets.grunnkretsnummer,
          districtLevel: 'grunnkrets',
          label: grunnkrets.grunnkretsnavn,
          kommunenummer: grunnkrets.kommunenummer,
        },
      })}\n`,
    )
    polygonFeatures += 1
  }

  return { grunnkretser: grunnkretser.length, polygonFeatures }
}

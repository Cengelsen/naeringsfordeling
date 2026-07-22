import type { WriteStream } from 'node:fs'
import type Database from 'better-sqlite3'
import {
  cellDegForBand,
  gridCellCentroid,
  gridCellId,
  type LodBand,
} from './lod-grid.js'

type GeocodedOrgRow = {
  org_type: string
  lat: number
  lng: number
}

type CellAggregate = Map<string, Map<string, number>>

function aggregateBand(rows: Iterable<GeocodedOrgRow>, band: LodBand): CellAggregate {
  const cellDeg = cellDegForBand(band)
  const cells: CellAggregate = new Map()

  for (const row of rows) {
    const cellId = gridCellId(row.lat, row.lng, cellDeg)
    let bucket = cells.get(cellId)
    if (!bucket) {
      bucket = new Map()
      cells.set(cellId, bucket)
    }
    bucket.set(row.org_type, (bucket.get(row.org_type) ?? 0) + 1)
  }

  return cells
}

export function writeAggregateNdjson(
  stream: WriteStream,
  cells: CellAggregate,
  band: LodBand,
): number {
  const cellDeg = cellDegForBand(band)
  let features = 0

  for (const [cellId, orgTypes] of cells.entries()) {
    const [lng, lat] = gridCellCentroid(cellId, cellDeg)
    for (const [orgType, count] of orgTypes.entries()) {
      stream.write(
        `${JSON.stringify({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {
            orgType,
            count,
            cellId,
            band,
          },
        })}\n`,
      )
      features += 1
    }
  }

  return features
}

export function exportLodAggregateNdjson(
  db: Database.Database,
  stream: WriteStream,
  band: LodBand,
): { features: number; cells: number } {
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
    .iterate() as Iterable<GeocodedOrgRow>

  const cells = aggregateBand(rows, band)
  const features = writeAggregateNdjson(stream, cells, band)
  return { features, cells: cells.size }
}

export function exportPointsNdjson(
  db: Database.Database,
  stream: WriteStream,
  onRow?: () => void,
): number {
  const rows = db
    .prepare(
      `SELECT orgnr, org_type, lat, lng, naeringskode, antall_ansatte,
              har_registrert_antall_ansatte, entity_kind
       FROM organizations
       WHERE deleted = 0
         AND konkurs = 0
         AND under_avvikling = 0
         AND lat IS NOT NULL
         AND lng IS NOT NULL
         AND entity_kind = 'enhet'`,
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

  let total = 0
  for (const row of rows) {
    stream.write(
      `${JSON.stringify({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [row.lng, row.lat] },
        properties: {
          orgnr: row.orgnr,
          orgType: row.org_type,
        },
      })}\n`,
    )
    total += 1
    onRow?.()
  }

  return total
}

export function collectOrgTypes(db: Database.Database): string[] {
  const rows = db
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

  return rows.map((row) => row.org_type)
}

export function countGeocodedPoints(db: Database.Database): number {
  const row = db
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

  return row.count
}

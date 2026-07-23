import type { WriteStream } from 'node:fs'
import type Database from 'better-sqlite3'

export function exportPointsNdjson(
  db: Database.Database,
  stream: WriteStream,
  onRow?: () => void,
): number {
  const rows = db
    .prepare(
      `SELECT orgnr, org_type, lat, lng
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

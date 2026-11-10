import type { WriteStream } from 'node:fs'
import type Database from 'better-sqlite3'
import { employeeBand } from './employeeBands.js'

/** Match client `addressGroups.locationKey` precision. */
const LOCATION_PRECISION = 5

/**
 * Bit flags packed into the `f` property:
 *   bit 0 (1) = konkurs
 *   bit 1 (2) = under_avvikling
 *   bit 2 (4) = vat_registered
 *   bit 3 (8) = er_i_konsern
 */
function packFlags(row: {
  konkurs: number
  under_avvikling: number
  vat_registered: number
  er_i_konsern: number
}): number {
  return (
    (row.konkurs ? 1 : 0) |
    (row.under_avvikling ? 2 : 0) |
    (row.vat_registered ? 4 : 0) |
    (row.er_i_konsern ? 8 : 0)
  )
}

/**
 * Export one GeoJSON point per organisation with compact attributes.
 * Properties: o (orgnr int), t (org_type), s (NACE section), b (employee band),
 * k (entity kind e/u), f (bit flags).
 */
export function exportPointsNdjson(
  db: Database.Database,
  stream: WriteStream,
  onRow?: () => void,
): number {
  const rows = db
    .prepare(
      `SELECT orgnr, org_type, lat, lng,
              substr(naeringskode, 1, 2) AS nace_section,
              antall_ansatte, har_registrert_antall_ansatte,
              entity_kind, konkurs, under_avvikling, vat_registered, er_i_konsern
       FROM organizations
       WHERE deleted = 0
         AND lat IS NOT NULL
         AND lng IS NOT NULL`,
    )
    .iterate() as Iterable<{
    orgnr: string
    org_type: string
    lat: number
    lng: number
    nace_section: string | null
    antall_ansatte: number | null
    har_registrert_antall_ansatte: number
    entity_kind: string
    konkurs: number
    under_avvikling: number
    vat_registered: number
    er_i_konsern: number
  }>

  let features = 0

  for (const row of rows) {
    const lat = Number(row.lat.toFixed(LOCATION_PRECISION))
    const lng = Number(row.lng.toFixed(LOCATION_PRECISION))
    const properties: Record<string, string | number> = {
      o: Number(row.orgnr),
      t: row.org_type,
      f: packFlags(row),
    }
    if (row.nace_section) properties.s = row.nace_section
    const band = employeeBand(row.antall_ansatte, row.har_registrert_antall_ansatte === 1)
    if (band !== 'unknown') properties.b = band
    if (row.entity_kind !== 'enhet')
      properties.k = row.entity_kind === 'underenhet' ? 'u' : row.entity_kind

    stream.write(
      `${JSON.stringify({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties,
      })}\n`,
    )
    features += 1
    onRow?.()
  }

  return features
}

export function collectOrgTypes(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT org_type AS org_type
       FROM organizations
       WHERE deleted = 0
         AND lat IS NOT NULL
         AND lng IS NOT NULL
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
         AND lat IS NOT NULL
         AND lng IS NOT NULL`,
    )
    .get() as { count: number }

  return row.count
}

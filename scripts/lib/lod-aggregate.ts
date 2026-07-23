import type { WriteStream } from 'node:fs'
import type Database from 'better-sqlite3'

/** Match client `addressGroups.locationKey` precision. */
const LOCATION_PRECISION = 5

function locationKey(lat: number, lng: number): string {
  return `${lat.toFixed(LOCATION_PRECISION)}:${lng.toFixed(LOCATION_PRECISION)}`
}

/** Prefer Kartverket adresse_id; fall back to rounded lat/lng. */
function addressGroupKey(lat: number, lng: number, adresseId: string | null): string {
  const id = adresseId?.trim()
  if (id) return `id:${id}`
  return `ll:${locationKey(lat, lng)}`
}

interface AddressBucket {
  lat: number
  lng: number
  adresseId: string | null
  orgnrs: string[]
  typeCounts: Map<string, number>
  /** Primary org fields for instant single-org / address-header popups. */
  navn: string
  orgTypeLabel: string
  addressText: string
  postnummer: string
}

/**
 * Export one GeoJSON point per unique address (`adresse_id`, else rounded lat/lng).
 * Multi-org addresses get orgCount + orgnrs (circle markers; no split-square icons).
 * Primary org identity fields are baked for fast popup without an API round-trip.
 */
export function exportPointsNdjson(
  db: Database.Database,
  stream: WriteStream,
  onRow?: () => void,
): number {
  const rows = db
    .prepare(
      `SELECT orgnr, org_type, org_type_label, navn, address_text, postnummer, lat, lng, adresse_id
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
    org_type_label: string
    navn: string
    address_text: string
    postnummer: string
    lat: number
    lng: number
    adresse_id: string | null
  }>

  const buckets = new Map<string, AddressBucket>()

  for (const row of rows) {
    const adresseId = row.adresse_id?.trim() || null
    const key = addressGroupKey(row.lat, row.lng, adresseId)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        lat: Number(row.lat.toFixed(LOCATION_PRECISION)),
        lng: Number(row.lng.toFixed(LOCATION_PRECISION)),
        adresseId,
        orgnrs: [],
        typeCounts: new Map(),
        navn: row.navn,
        orgTypeLabel: row.org_type_label,
        addressText: row.address_text,
        postnummer: row.postnummer,
      }
      buckets.set(key, bucket)
    }
    bucket.orgnrs.push(row.orgnr)
    bucket.typeCounts.set(row.org_type, (bucket.typeCounts.get(row.org_type) ?? 0) + 1)
    onRow?.()
  }

  let features = 0
  for (const bucket of buckets.values()) {
    const orgCount = bucket.orgnrs.length
    const types = [...bucket.typeCounts.keys()]
    const orgType = types.length === 1 ? types[0]! : 'MIXED'
    const properties: Record<string, string | number> = {
      orgnr: bucket.orgnrs[0]!,
      orgType,
      orgCount,
      orgnrs: bucket.orgnrs.join(','),
      typeList: `,${[...bucket.typeCounts.keys()].sort().join(',')},`,
      navn: bucket.navn,
      orgTypeLabel: bucket.orgTypeLabel,
      addressText: bucket.addressText,
      postnummer: bucket.postnummer,
    }
    if (bucket.adresseId) {
      properties.adresseId = bucket.adresseId
    }

    stream.write(
      `${JSON.stringify({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [bucket.lng, bucket.lat] },
        properties,
      })}\n`,
    )
    features += 1
  }

  return features
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

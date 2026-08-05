export { LOCATION_PRECISION, locationKey, addressGroupKey } from '../shared/address-groups.js'
import { LOCATION_PRECISION, addressGroupKey } from '../shared/address-groups.js'

export interface AddressGroupedPoint {
  orgnr: string
  orgType: string
  orgTypeLabel: string
  navn: string
  addressText: string
  postnummer: string
  kommunenummer: string
  lat: number
  lng: number
  naeringskode: string | null
  employeeBand: string
  entityKind: string
  adresseId: string | null
  orgCount: number
  orgnrs: string
  typeList: string
}

export interface OrganizationPointLike {
  orgnr: string
  org_type: string
  org_type_label: string
  navn: string
  address_text: string
  postnummer: string
  kommunenummer: string
  lat: number
  lng: number
  naeringskode: string | null
  employee_band: string
  entity_kind: string
  adresse_id?: string | null
}

/**
 * Collapse org rows into one marker feature per address (adresse_id or lat/lng).
 */
export function groupOrganizationPointsByAddress(
  rows: OrganizationPointLike[],
): AddressGroupedPoint[] {
  type Bucket = {
    lat: number
    lng: number
    adresseId: string | null
    orgnrs: string[]
    typeCounts: Map<string, number>
    primary: OrganizationPointLike
  }

  const buckets = new Map<string, Bucket>()

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
        primary: row,
      }
      buckets.set(key, bucket)
    }
    bucket.orgnrs.push(row.orgnr)
    bucket.typeCounts.set(row.org_type, (bucket.typeCounts.get(row.org_type) ?? 0) + 1)
  }

  const points: AddressGroupedPoint[] = []
  for (const bucket of buckets.values()) {
    const orgCount = bucket.orgnrs.length
    const types = [...bucket.typeCounts.keys()].sort()
    const orgType = types.length === 1 ? types[0]! : 'MIXED'
    const primary = bucket.primary
    const point: AddressGroupedPoint = {
      orgnr: bucket.orgnrs[0]!,
      orgType,
      orgTypeLabel: orgType === 'MIXED' ? 'Blandet' : primary.org_type_label,
      navn: primary.navn,
      addressText: primary.address_text ?? '',
      postnummer: primary.postnummer ?? '',
      kommunenummer: primary.kommunenummer,
      lat: bucket.lat,
      lng: bucket.lng,
      naeringskode: primary.naeringskode,
      employeeBand: primary.employee_band,
      entityKind: primary.entity_kind,
      adresseId: bucket.adresseId,
      orgCount,
      orgnrs: bucket.orgnrs.join(','),
      typeList: `,${types.join(',')},`,
    }
    points.push(point)
  }

  return points
}

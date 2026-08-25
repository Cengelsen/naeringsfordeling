import type Database from 'better-sqlite3'
import { employeeBand } from '../scripts/lib/employeeBands.js'
import { addressGroupKey } from '../shared/address-groups.js'
import type { ApiFilters } from './filters.js'
import { SpatialCountIndex, type Point2D } from './spatialCountIndex.js'

export const INDEX_CACHE_MAX = 12

export const DEFAULT_SPATIAL_FILTERS: ApiFilters = {
  orgTypes: [],
  excludeKonkurs: true,
  excludeUnderAvvikling: true,
  vatRegisteredOnly: false,
  naeringskodeSections: [],
  employeeBands: [],
  entityKinds: ['enhet'],
  konsernMode: false,
  konsernMembersOnly: false,
}

export function filterFingerprint(filters: ApiFilters): string {
  return JSON.stringify({
    orgTypes: [...filters.orgTypes].sort(),
    excludeKonkurs: filters.excludeKonkurs,
    excludeUnderAvvikling: filters.excludeUnderAvvikling,
    vatRegisteredOnly: filters.vatRegisteredOnly,
    naeringskodeSections: [...filters.naeringskodeSections].sort(),
    employeeBands: [...filters.employeeBands].sort(),
    entityKinds: [...filters.entityKinds].sort(),
    konsernMembersOnly: filters.konsernMembersOnly,
    kommunenummer: filters.kommunenummer ?? '',
    fylke: filters.fylke ?? '',
  })
}

export interface OrgRow {
  orgnr: string
  org_type: string
  lat: number
  lng: number
  adresse_id: string | null
  konkurs: number
  under_avvikling: number
  vat_registered: number
  naeringskode: string | null
  antall_ansatte: number | null
  har_registrert_antall_ansatte: number
  entity_kind: string
  er_i_konsern: number
  kommunenummer: string | null
}

export function rowMatchesFilters(row: OrgRow, filters: ApiFilters): boolean {
  if (filters.excludeKonkurs && row.konkurs !== 0) return false
  if (filters.excludeUnderAvvikling && row.under_avvikling !== 0) return false
  if (filters.vatRegisteredOnly && row.vat_registered !== 1) return false
  if (filters.orgTypes.length > 0 && !filters.orgTypes.includes(row.org_type)) return false
  if (
    filters.entityKinds.length > 0 &&
    !filters.entityKinds.includes(row.entity_kind as 'enhet' | 'underenhet')
  ) {
    return false
  }
  if (filters.konsernMembersOnly && row.er_i_konsern !== 1) return false
  if (filters.naeringskodeSections.length > 0) {
    const section = row.naeringskode?.slice(0, 2) ?? ''
    if (!filters.naeringskodeSections.includes(section)) return false
  }
  if (filters.employeeBands.length > 0) {
    const band = employeeBand(row.antall_ansatte, row.har_registrert_antall_ansatte === 1)
    if (!filters.employeeBands.includes(band)) return false
  }
  if (filters.kommunenummer) {
    const allowed = new Set(
      filters.kommunenummer
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    )
    if (!row.kommunenummer || !allowed.has(row.kommunenummer)) return false
  }
  if (filters.fylke) {
    const fylker = new Set(
      filters.fylke
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    )
    const fylke = row.kommunenummer?.slice(0, 2) ?? ''
    if (!fylker.has(fylke)) return false
  }
  return true
}

export interface BuiltIndexes {
  addresses: SpatialCountIndex
  organizations: SpatialCountIndex
}

export function buildIndexes(rows: OrgRow[], filters: ApiFilters): BuiltIndexes {
  const addressPoints = new Map<string, Point2D>()
  const orgPoints: Point2D[] = []

  for (const row of rows) {
    if (!rowMatchesFilters(row, filters)) continue

    orgPoints.push({ x: row.lng, y: row.lat })

    const key = addressGroupKey(row.lat, row.lng, row.adresse_id)
    if (!addressPoints.has(key)) {
      addressPoints.set(key, { x: row.lng, y: row.lat })
    }
  }

  return {
    addresses: new SpatialCountIndex([...addressPoints.values()]),
    organizations: new SpatialCountIndex(orgPoints),
  }
}

export function loadAllGeocodedRows(db: Database.Database): OrgRow[] {
  return db
    .prepare(
      `SELECT orgnr, org_type, lat, lng, adresse_id,
              konkurs, under_avvikling, vat_registered, naeringskode,
              antall_ansatte, har_registrert_antall_ansatte, entity_kind,
              er_i_konsern, kommunenummer
       FROM organizations
       WHERE deleted = 0
         AND lat IS NOT NULL
         AND lng IS NOT NULL`,
    )
    .all() as OrgRow[]
}

export type SpatialCountRequest = {
  type: 'count'
  id: number
  filters: ApiFilters
  bbox: [number, number, number, number]
}

export type SpatialPrefetchRequest = {
  type: 'prefetch'
  filters: ApiFilters
}

export type SpatialWorkerInbound = SpatialCountRequest | SpatialPrefetchRequest

export type SpatialCountHit = {
  type: 'countResult'
  id: number
  hit: true
  addressesInBbox: number
  geocodedInBbox: number
}

export type SpatialCountMiss = {
  type: 'countResult'
  id: number
  hit: false
}

export type SpatialWorkerOutbound =
  | { type: 'ready'; addressCount: number; ms: number }
  | SpatialCountHit
  | SpatialCountMiss
  | { type: 'error'; id?: number; message: string }

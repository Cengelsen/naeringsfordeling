import type Database from 'better-sqlite3'
import { employeeBand } from '../scripts/lib/employeeBands.js'
import type { ApiFilters } from './filters.js'
import { SpatialCountIndex, type Point2D } from './spatialCountIndex.js'

const LOCATION_PRECISION = 5
const INDEX_CACHE_MAX = 12

function addressKey(lat: number, lng: number, adresseId: string | null): string {
  const id = adresseId?.trim()
  if (id) return `id:${id}`
  return `ll:${lat.toFixed(LOCATION_PRECISION)}:${lng.toFixed(LOCATION_PRECISION)}`
}

function filterFingerprint(filters: ApiFilters): string {
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

interface OrgRow {
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

function rowMatchesFilters(row: OrgRow, filters: ApiFilters): boolean {
  if (filters.excludeKonkurs && row.konkurs !== 0) return false
  if (filters.excludeUnderAvvikling && row.under_avvikling !== 0) return false
  if (filters.vatRegisteredOnly && row.vat_registered !== 1) return false
  if (filters.orgTypes.length > 0 && !filters.orgTypes.includes(row.org_type)) return false
  if (filters.entityKinds.length > 0 && !filters.entityKinds.includes(row.entity_kind as 'enhet' | 'underenhet')) {
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

interface BuiltIndexes {
  addresses: SpatialCountIndex
  organizations: SpatialCountIndex
}

function buildIndexes(rows: OrgRow[], filters: ApiFilters): BuiltIndexes {
  const addressPoints = new Map<string, Point2D>()
  const orgPoints: Point2D[] = []

  for (const row of rows) {
    if (!rowMatchesFilters(row, filters)) continue

    orgPoints.push({ x: row.lng, y: row.lat })

    const key = addressKey(row.lat, row.lng, row.adresse_id)
    if (!addressPoints.has(key)) {
      // Use raw geocode coords so bbox membership matches float64 SQL filters.
      addressPoints.set(key, { x: row.lng, y: row.lat })
    }
  }

  return {
    addresses: new SpatialCountIndex([...addressPoints.values()]),
    organizations: new SpatialCountIndex(orgPoints),
  }
}

let allRows: OrgRow[] | null = null
const indexCache = new Map<string, BuiltIndexes>()

function loadAllGeocodedRows(db: Database.Database): OrgRow[] {
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

function getIndexes(db: Database.Database, filters: ApiFilters): BuiltIndexes {
  if (!allRows) {
    allRows = loadAllGeocodedRows(db)
  }

  const key = filterFingerprint(filters)
  const cached = indexCache.get(key)
  if (cached) {
    // LRU bump
    indexCache.delete(key)
    indexCache.set(key, cached)
    return cached
  }

  const built = buildIndexes(allRows, filters)
  indexCache.set(key, built)
  while (indexCache.size > INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next().value
    if (oldest == null) break
    indexCache.delete(oldest)
  }
  return built
}

/** Load geocoded rows once; build default address index in the background. */
export function warmAddressSpatialIndex(db: Database.Database) {
  const started = performance.now()
  // Prefetch rows immediately so the first filtered rebuild is cheaper.
  allRows = loadAllGeocodedRows(db)
  getIndexes(db, {
    orgTypes: [],
    excludeKonkurs: true,
    excludeUnderAvvikling: true,
    vatRegisteredOnly: false,
    naeringskodeSections: [],
    employeeBands: [],
    entityKinds: ['enhet'],
    konsernMembersOnly: false,
  })
  const ms = Math.round(performance.now() - started)
  const size = indexCache.values().next().value?.addresses.size ?? 0
  console.log(`Address spatial index ready: ${size.toLocaleString('nb-NO')} addresses (${ms} ms)`)
}

export function countViewportSpatial(
  db: Database.Database,
  filters: ApiFilters,
  bbox: [number, number, number, number],
): {
  addressesInBbox: number
  geocodedInBbox: number
  byOrgType: Record<string, number>
} {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const indexes = getIndexes(db, filters)

  return {
    addressesInBbox: indexes.addresses.countBbox(minLng, minLat, maxLng, maxLat),
    geocodedInBbox: indexes.organizations.countBbox(minLng, minLat, maxLng, maxLat),
    byOrgType: {},
  }
}

import type { FeatureCollection } from 'geojson'
import type {
  Kommune,
  Konsernstruktur,
  MapFilters,
  MunicipalityCount,
  Organization,
  OrganizationLocation,
  OrganizationPoint,
  OrganizationSearchHit,
  Organisasjonsform,
  ViewportSummary,
} from '../types'
import { bandMatchesFilter } from '../utils/employeeBands'
import { sectionMatchesFilter } from '../utils/naeringskode'
import {
  filterPointsInBbox,
  normalizeOrgnr,
  parsePointsResponse,
  type CompactPoint,
} from '../map/points'
import { assetUrl } from '../utils/assets'
import { isDetailZoom } from '../lodConfig'
import { fetchStaticJson } from '../utils/staticJson'
import {
  buildOrgSearchIndex,
  searchOrgSearchIndex,
  type OrgSearchIndex,
} from '../search/orgSearchIndex'

const API_BASE = import.meta.env.VITE_API_URL ?? ''
const STATIC_API = import.meta.env.VITE_STATIC_API === 'true'
const STATIC_API_BASE = assetUrl('data/api')

interface MunicipalityBreakdownRow {
  kommunenummer: string
  org_type: string
  konkurs: number
  under_avvikling: number
  vat_registered: number
  naeringskode_section?: string | null
  employee_band?: string
  entity_kind?: string
  count: number
}

type SearchIndexRow = [
  string,
  string,
  string,
  string,
  string,
  number | null,
  number | null,
  string?,
  string?,
]
type GeocodedPointRow = [
  string,
  number,
  number,
  string,
  string,
  number,
  number,
  number,
  string,
  string,
  string,
  string,
  string?,
  string?,
  string?,
]

let municipalityBreakdownPromise: Promise<MunicipalityBreakdownRow[]> | null = null
let searchIndexPromise: Promise<OrganizationSearchHit[]> | null = null
let orgSearchIndexPromise: Promise<OrgSearchIndex> | null = null
let geocodedPointsPromise: Promise<GeocodedPointRow[] | null> | null = null
let geocodedPointsByKommunePromise: Promise<Map<string, GeocodedPointRow[]> | null> | null = null

async function staticFetch<T>(file: string): Promise<T> {
  const response = await fetch(`${STATIC_API_BASE}/${file}`)
  if (!response.ok) {
    throw new ApiError(`Statisk data mangler (${file})`)
  }
  return response.json() as Promise<T>
}

async function loadGeocodedPointsOptional(): Promise<GeocodedPointRow[] | null> {
  // Used for address stats and GeoJSON fallback when PMTiles/WebGL cannot paint.
  geocodedPointsPromise ??= fetchStaticJson<{ rows: GeocodedPointRow[] }>(
    `${STATIC_API_BASE}/geocoded-points.json`,
  )
    .then((data) => data.rows)
    .catch(() => null)
  return geocodedPointsPromise
}

async function loadGeocodedPoints(): Promise<GeocodedPointRow[]> {
  const rows = await loadGeocodedPointsOptional()
  if (!rows) {
    throw new ApiError('Geokodede punkter mangler')
  }
  return rows
}

async function loadGeocodedPointsByKommune(): Promise<Map<string, GeocodedPointRow[]> | null> {
  geocodedPointsByKommunePromise ??= loadGeocodedPointsOptional().then((rows) => {
    if (!rows) return null

    const byKommune = new Map<string, GeocodedPointRow[]>()
    for (const row of rows) {
      const kommunenummer = row[4]
      const bucket = byKommune.get(kommunenummer)
      if (bucket) {
        bucket.push(row)
      } else {
        byKommune.set(kommunenummer, [row])
      }
    }
    return byKommune
  })
  return geocodedPointsByKommunePromise
}

function geocodedPointMatchesFilters(row: GeocodedPointRow, filters: MapFilters): boolean {
  const [, , , orgType, , konkurs, underAvvikling, vatRegistered] = row
  const naeringskodeSection = row[12] ?? null
  const employeeBand = (row[13] ?? 'unknown') as import('../utils/employeeBands').EmployeeBand
  const entityKind = (row[14] ?? 'enhet') as 'enhet' | 'underenhet'

  if (filters.orgTypes.length > 0 && !filters.orgTypes.includes(orgType)) return false
  if (filters.excludeKonkurs && konkurs !== 0) return false
  if (filters.excludeUnderAvvikling && underAvvikling !== 0) return false
  if (filters.vatRegisteredOnly && vatRegistered !== 1) return false
  if (!sectionMatchesFilter(naeringskodeSection, filters.naeringskodeSections)) return false
  if (!bandMatchesFilter(employeeBand, filters.employeeBands)) return false
  if (filters.entityKinds.length > 0 && !filters.entityKinds.includes(entityKind)) return false
  return true
}

function geocodedPointInBbox(
  row: GeocodedPointRow,
  bbox: [number, number, number, number],
): boolean {
  const [, lng, lat] = row
  const [minLng, minLat, maxLng, maxLat] = bbox
  return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat
}

async function fetchOrganizationPointsFromStatic(
  filters: MapFilters,
  options: FetchPointsOptions = {},
): Promise<{ points: OrganizationPoint[]; truncated: boolean }> {
  const limit = options.limit ?? (options.zoom != null ? limitForZoom(options.zoom) : 50000)
  const points: OrganizationPoint[] = []

  const byKommune = options.kommunenumre?.length ? await loadGeocodedPointsByKommune() : null
  const allRows = byKommune ? null : await loadGeocodedPointsOptional()
  if (!byKommune && !allRows) {
    return { points: [], truncated: false }
  }

  const candidates: GeocodedPointRow[] = byKommune
    ? options.kommunenumre!.flatMap((kommunenummer) => byKommune.get(kommunenummer) ?? [])
    : allRows!

  for (const row of candidates) {
    if (!geocodedPointMatchesFilters(row, filters)) continue

    const [, lng, lat, orgType, kommunenummer] = row
    if (options.bbox && !geocodedPointInBbox(row, options.bbox)) continue

    points.push({
      orgnr: row[0],
      lng,
      lat,
      orgType,
      kommunenummer,
      navn: row[8],
      orgTypeLabel: row[9],
      addressText: row[10],
      postnummer: row[11],
      naeringskode: row[12] ?? null,
      employeeBand: (row[13] ?? 'unknown') as import('../utils/employeeBands').EmployeeBand,
      entityKind: (row[14] ?? 'enhet') as 'enhet' | 'underenhet',
    })

    if (points.length >= limit) {
      return { points, truncated: true }
    }
  }

  return { points, truncated: false }
}

async function loadMunicipalityBreakdown(): Promise<MunicipalityBreakdownRow[]> {
  municipalityBreakdownPromise ??= staticFetch<{ rows: MunicipalityBreakdownRow[] }>(
    'municipality-breakdown.json',
  ).then((data) => data.rows)
  return municipalityBreakdownPromise
}

function mapSearchIndexRow(row: SearchIndexRow): OrganizationSearchHit {
  return {
    orgnr: row[0],
    navn: row[1],
    orgType: row[2],
    orgTypeLabel: row[3],
    kommunenummer: row[4],
    lat: row[5],
    lng: row[6],
    addressText: row[7] ?? '',
    postnummer: row[8] ?? '',
  }
}

function organizationFromSearchHit(hit: OrganizationSearchHit): Organization {
  return {
    orgnr: hit.orgnr,
    navn: hit.navn,
    orgType: hit.orgType,
    orgTypeLabel: hit.orgTypeLabel,
    addressText: hit.addressText ?? '',
    postnummer: hit.postnummer ?? '',
    kommunenummer: hit.kommunenummer,
    lat: hit.lat,
    lng: hit.lng,
  }
}

async function loadSearchIndex(): Promise<OrganizationSearchHit[]> {
  searchIndexPromise ??= fetchStaticJson<{ rows: SearchIndexRow[] }>(
    `${STATIC_API_BASE}/search-index.json`,
  ).then((data) => data.rows.map(mapSearchIndexRow))
  return searchIndexPromise
}

async function loadOrgSearchIndex(): Promise<OrgSearchIndex> {
  orgSearchIndexPromise ??= loadSearchIndex().then(buildOrgSearchIndex)
  return orgSearchIndexPromise
}

async function loadSearchIndexByOrgnr(): Promise<Map<string, OrganizationSearchHit>> {
  return (await loadOrgSearchIndex()).byOrgnr
}

/** Warm the local search index (static deployment). */
export function prefetchLocalSearchIndex(): Promise<void> {
  if (!STATIC_API) return Promise.resolve()
  return loadOrgSearchIndex().then(() => undefined)
}

export async function lookupOrganizationLocal(orgnr: string): Promise<Organization | null> {
  if (!STATIC_API) return null
  const index = await loadSearchIndexByOrgnr()
  const hit = index.get(normalizeOrgnr(orgnr))
  return hit ? organizationFromSearchHit(hit) : null
}

function breakdownRowMatchesFilters(row: MunicipalityBreakdownRow, filters: MapFilters): boolean {
  if (filters.orgTypes.length > 0 && !filters.orgTypes.includes(row.org_type)) return false
  if (filters.excludeKonkurs && row.konkurs !== 0) return false
  if (filters.excludeUnderAvvikling && row.under_avvikling !== 0) return false
  if (filters.vatRegisteredOnly && row.vat_registered !== 1) return false
  if (!sectionMatchesFilter(row.naeringskode_section ?? null, filters.naeringskodeSections)) {
    return false
  }
  if (
    !bandMatchesFilter(
      (row.employee_band ?? 'unknown') as import('../utils/employeeBands').EmployeeBand,
      filters.employeeBands,
    )
  ) {
    return false
  }
  if (
    filters.entityKinds.length > 0 &&
    row.entity_kind &&
    !filters.entityKinds.includes(row.entity_kind as 'enhet' | 'underenhet')
  ) {
    return false
  }
  return true
}

function aggregateMunicipalityCounts(
  rows: MunicipalityBreakdownRow[],
  filters: MapFilters,
): MunicipalityCount[] {
  const totals = new Map<string, number>()

  for (const row of rows) {
    if (!breakdownRowMatchesFilters(row, filters)) continue
    totals.set(row.kommunenummer, (totals.get(row.kommunenummer) ?? 0) + row.count)
  }

  return [...totals.entries()]
    .map(([kommunenummer, count]) => ({ kommunenummer, count }))
    .sort((a, b) => a.kommunenummer.localeCompare(b.kommunenummer))
}

function aggregateDistrictStats(
  rows: MunicipalityBreakdownRow[],
  filters: MapFilters,
  level: 'fylke' | 'kommune',
  districtId: string,
): { total: number; byOrgType: Record<string, number> } {
  const byOrgType: Record<string, number> = {}
  let total = 0

  for (const row of rows) {
    if (!breakdownRowMatchesFilters(row, filters)) continue
    const rowDistrictId = level === 'fylke' ? row.kommunenummer.slice(0, 2) : row.kommunenummer
    if (rowDistrictId !== districtId) continue
    byOrgType[row.org_type] = (byOrgType[row.org_type] ?? 0) + row.count
    total += row.count
  }

  return { total, byOrgType }
}

export interface DistrictStats {
  total: number
  byOrgType: Record<string, number>
}

export async function fetchDistrictStats(
  level: 'fylke' | 'kommune',
  districtId: string,
  filters: MapFilters,
): Promise<DistrictStats> {
  if (STATIC_API) {
    const rows = await loadMunicipalityBreakdown()
    return aggregateDistrictStats(rows, filters, level, districtId)
  }

  const params = filtersToParams(filters)
  params.set('level', level)
  params.set('id', districtId)
  return apiFetch<DistrictStats>(`/api/district-stats?${params.toString()}`)
}

function searchStaticOrganizations(
  query: string,
  limit: number,
  index: OrgSearchIndex,
): OrganizationSearchHit[] {
  return searchOrgSearchIndex(index, query, limit)
}

export const MAX_VIEWPORT_DOTS = 50_000

class ApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Target point count for the current zoom (matches server-side sampling). */
export function limitForZoom(zoom: number): number {
  if (isDetailZoom(zoom)) {
    return MAX_VIEWPORT_DOTS
  }
  const z = Math.max(4, Math.min(18, zoom))
  return Math.min(MAX_VIEWPORT_DOTS, Math.round(250 * 1.38 ** (z - 4)))
}

async function apiFetch<T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  if (STATIC_API) {
    throw new ApiError('Live API er deaktivert i statisk modus')
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, signal })
  } catch {
    throw new ApiError(
      'Kan ikke nå databasen. Start API-et med yarn server og sørg for at organizations.db finnes.',
    )
  }

  if (!response.ok) {
    throw new ApiError(`Database-API feilet (${response.status})`)
  }

  return response.json() as Promise<T>
}

/** Filters that require server-side data reload (excludes orgTypes). */
export function dataFiltersToParams(filters: MapFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (!filters.excludeKonkurs) params.set('excludeKonkurs', 'false')
  if (!filters.excludeUnderAvvikling) params.set('excludeUnderAvvikling', 'false')
  if (filters.vatRegisteredOnly) params.set('vatRegisteredOnly', 'true')
  if (filters.naeringskodeSections.length > 0) {
    params.set('naeringskodeSections', filters.naeringskodeSections.join(','))
  }
  if (filters.employeeBands.length > 0) {
    params.set('employeeBands', filters.employeeBands.join(','))
  }
  if (filters.entityKinds.length > 0) {
    params.set('entityKinds', filters.entityKinds.join(','))
  }
  if (filters.konsernMembersOnly) params.set('konsernMembersOnly', 'true')
  return params
}

function filtersToParams(filters: MapFilters): URLSearchParams {
  const params = dataFiltersToParams(filters)
  if (filters.orgTypes.length > 0) params.set('orgTypes', filters.orgTypes.join(','))
  return params
}

export async function checkApiHealth(): Promise<void> {
  if (STATIC_API) {
    await staticFetch<{ ok: boolean }>('health.json')
    return
  }
  await apiFetch<{ ok: boolean }>('/api/health')
}

export async function fetchOrganisasjonsformer(): Promise<Organisasjonsform[]> {
  if (STATIC_API) {
    const data = await staticFetch<{ organisasjonsformer: Organisasjonsform[] }>(
      'organisasjonsformer.json',
    )
    return data.organisasjonsformer
  }
  const data = await apiFetch<{ organisasjonsformer: Organisasjonsform[] }>(
    '/api/organisasjonsformer',
  )
  return data.organisasjonsformer
}

export interface NaeringskodeOption {
  section: string
  label: string | null
  count: number
}

export async function fetchNaeringskoder(): Promise<NaeringskodeOption[]> {
  if (STATIC_API) {
    const data = await staticFetch<{ naeringskoder: NaeringskodeOption[] }>('naeringskoder.json')
    return data.naeringskoder
  }
  const data = await apiFetch<{ naeringskoder: NaeringskodeOption[] }>('/api/naeringskoder')
  return data.naeringskoder
}

export function applyKommuneNames(
  kommuner: Array<{ nummer: string }>,
  geojson: FeatureCollection | null,
): Kommune[] {
  const names = new Map<string, string>()

  for (const feature of geojson?.features ?? []) {
    const props = feature.properties as {
      kommunenummer?: string
      kommunenavn?: string
      name?: string
    } | null
    if (props?.kommunenummer) {
      names.set(props.kommunenummer, props.kommunenavn ?? props.name ?? props.kommunenummer)
    }
  }

  return kommuner.map((kommune) => ({
    nummer: kommune.nummer,
    navn: names.get(kommune.nummer) ?? kommune.nummer,
  }))
}

export async function fetchKommuner(geojson?: FeatureCollection | null): Promise<Kommune[]> {
  const data = STATIC_API
    ? await staticFetch<{ kommuner: Array<{ nummer: string; count: number }> }>('kommuner.json')
    : await apiFetch<{ kommuner: Array<{ nummer: string; count: number }> }>('/api/kommuner')
  return applyKommuneNames(data.kommuner, geojson ?? null)
}

export async function fetchMunicipalityCounts(filters: MapFilters): Promise<MunicipalityCount[]> {
  if (STATIC_API) {
    const rows = await loadMunicipalityBreakdown()
    return aggregateMunicipalityCounts(rows, filters)
  }

  const params = filtersToParams(filters)
  const data = await apiFetch<{ counts: MunicipalityCount[] }>(
    `/api/municipality-counts?${params.toString()}`,
  )
  return data.counts
}

export interface FetchPointsOptions {
  bbox?: [number, number, number, number]
  kommunenumre?: string[]
  selectedFylke?: string
  zoom?: number
  limit?: number
}

export interface FetchViewportSummaryOptions {
  bbox: [number, number, number, number]
  zoom?: number
  kommunenumre?: string[]
}

async function fetchViewportSummaryStatic(
  filters: MapFilters,
  options: FetchViewportSummaryOptions,
): Promise<ViewportSummary> {
  const rows = await loadMunicipalityBreakdown()
  const kommuneSet = new Set(options.kommunenumre ?? [])

  let totalInViewport = 0
  const byOrgType: Record<string, number> = {}

  for (const row of rows) {
    if (kommuneSet.size > 0 && !kommuneSet.has(row.kommunenummer)) continue
    if (!breakdownRowMatchesFilters(row, filters)) continue
    totalInViewport += row.count
  }

  let geocodedInBbox = 0
  const addressKeys = new Set<string>()
  const points = await loadGeocodedPointsOptional()
  if (points) {
    for (const row of points) {
      if (!geocodedPointMatchesFilters(row, filters)) continue
      if (options.bbox && !geocodedPointInBbox(row, options.bbox)) continue
      geocodedInBbox += 1
      const orgType = row[3]
      byOrgType[orgType] = (byOrgType[orgType] ?? 0) + 1
      // Compact points have no adresse_id — group by rounded lat/lng like the map.
      addressKeys.add(`${Number(row[2]).toFixed(5)}:${Number(row[1]).toFixed(5)}`)
    }
  } else {
    for (const row of rows) {
      if (kommuneSet.size > 0 && !kommuneSet.has(row.kommunenummer)) continue
      if (!breakdownRowMatchesFilters(row, filters)) continue
      geocodedInBbox += row.count
      byOrgType[row.org_type] = (byOrgType[row.org_type] ?? 0) + row.count
    }
  }

  const renderMode: ViewportSummary['renderMode'] = isDetailZoom(options.zoom)
    ? 'individual'
    : 'aggregate'

  return {
    totalInViewport,
    geocodedInBbox,
    addressesInBbox: addressKeys.size,
    ungeocodedInViewport: Math.max(0, totalInViewport - geocodedInBbox),
    byOrgType,
    renderMode,
    kommunerInViewport: kommuneSet.size,
  }
}

export async function fetchViewportSummary(
  filters: MapFilters,
  options: FetchViewportSummaryOptions,
  signal?: AbortSignal,
): Promise<{ summary: ViewportSummary; approximate: boolean }> {
  if (STATIC_API) {
    const summary = await fetchViewportSummaryStatic(filters, options)
    return { summary, approximate: true }
  }

  const params = dataFiltersToParams(filters)
  params.set('bbox', options.bbox.join(','))
  if (options.zoom != null) {
    params.set('zoom', String(options.zoom))
  }

  const data = await apiFetch<{ summary: ViewportSummary }>(
    `/api/viewport-summary?${params.toString()}`,
    undefined,
    signal,
  )
  return { summary: data.summary, approximate: false }
}

async function fetchOrganizationPointsFromApi(
  filters: MapFilters,
  options: FetchPointsOptions = {},
  signal?: AbortSignal,
): Promise<{ points: OrganizationPoint[]; truncated: boolean; summary?: ViewportSummary }> {
  if (STATIC_API) {
    return fetchOrganizationPointsFromStatic(filters, options)
  }

  const params = dataFiltersToParams(filters)

  if (options.bbox) {
    params.set('bbox', options.bbox.join(','))
  }

  if (options.zoom != null) {
    params.set('zoom', String(options.zoom))
    params.set('limit', String(options.limit ?? limitForZoom(options.zoom)))
  } else if (options.limit != null) {
    params.set('limit', String(options.limit))
  }

  if (options.kommunenumre?.length === 1) {
    params.set('kommunenummer', options.kommunenumre[0])
  } else if (options.kommunenumre && options.kommunenumre.length > 1) {
    params.set('kommunenummer', options.kommunenumre.join(','))
  } else if (options.selectedFylke) {
    params.set('fylke', options.selectedFylke)
  }

  const data = await apiFetch<{
    points: OrganizationPoint[] | CompactPoint[]
    truncated: boolean
    summary?: ViewportSummary
  }>(`/api/organizations/points?${params.toString()}`, undefined, signal)

  return {
    points: parsePointsResponse(data),
    truncated: data.truncated,
    summary: data.summary,
  }
}

export async function fetchOrganizationPoints(
  filters: MapFilters,
  options: FetchPointsOptions = {},
  signal?: AbortSignal,
): Promise<{ points: OrganizationPoint[]; truncated: boolean; summary?: ViewportSummary }> {
  return fetchOrganizationPointsFromApi(filters, options, signal)
}

const ORG_DETAIL_CACHE_MAX = 500
const orgDetailCache = new Map<string, Organization>()
const orgDetailInflight = new Map<string, Promise<Organization>>()
const BATCH_ORG_MAX = 100

function touchOrgDetailCache(org: Organization): Organization {
  const key = normalizeOrgnr(org.orgnr)
  if (orgDetailCache.has(key)) orgDetailCache.delete(key)
  orgDetailCache.set(key, org)
  while (orgDetailCache.size > ORG_DETAIL_CACHE_MAX) {
    const oldest = orgDetailCache.keys().next().value
    if (oldest == null) break
    orgDetailCache.delete(oldest)
  }
  return org
}

/** Seed cache from tile/API point props so popups can paint before a full fetch. */
export function seedOrganizationDetail(org: Organization): void {
  touchOrgDetailCache(org)
}

function getCachedOrganization(orgnr: string): Organization | null {
  const key = normalizeOrgnr(orgnr)
  const cached = orgDetailCache.get(key)
  if (!cached) return null
  // Refresh LRU order.
  orgDetailCache.delete(key)
  orgDetailCache.set(key, cached)
  return cached
}

export async function fetchOrganizationDetail(orgnr: string): Promise<Organization> {
  const cached = getCachedOrganization(orgnr)
  if (cached) return cached

  const key = normalizeOrgnr(orgnr)
  const inflight = orgDetailInflight.get(key)
  if (inflight) return inflight

  const promise = (async () => {
    if (STATIC_API) {
      const organization = await lookupOrganizationLocal(orgnr)
      if (!organization) {
        throw new ApiError('Organisasjon ikke funnet')
      }
      return touchOrgDetailCache(organization)
    }

    const data = await apiFetch<{ organization: Organization }>(`/api/organizations/${orgnr}`)
    return touchOrgDetailCache(data.organization)
  })()

  orgDetailInflight.set(key, promise)
  try {
    return await promise
  } finally {
    orgDetailInflight.delete(key)
  }
}

/**
 * Resolve many organisations in as few requests as possible (address popups).
 * Uses LRU cache, then one POST /batch per chunk of up to 100 orgnrs.
 */
export async function fetchOrganizationsBatch(
  orgnrs: string[],
  signal?: AbortSignal,
): Promise<Organization[]> {
  const unique = [...new Set(orgnrs.map(normalizeOrgnr).filter(Boolean))]
  if (unique.length === 0) return []

  const resolved = new Map<string, Organization>()
  const missing: string[] = []

  for (const orgnr of unique) {
    const cached = getCachedOrganization(orgnr)
    if (cached) {
      resolved.set(orgnr, cached)
      continue
    }
    if (STATIC_API) {
      const local = await lookupOrganizationLocal(orgnr)
      if (local) {
        resolved.set(orgnr, touchOrgDetailCache(local))
        continue
      }
    }
    missing.push(orgnr)
  }

  for (let i = 0; i < missing.length; i += BATCH_ORG_MAX) {
    signal?.throwIfAborted()
    const chunk = missing.slice(i, i + BATCH_ORG_MAX)
    if (STATIC_API) {
      for (const orgnr of chunk) {
        const local = await lookupOrganizationLocal(orgnr)
        if (local) resolved.set(normalizeOrgnr(orgnr), touchOrgDetailCache(local))
      }
      continue
    }

    const data = await apiFetch<{ organizations: Organization[] }>(
      '/api/organizations/batch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgnrs: chunk }),
      },
      signal,
    )
    for (const org of data.organizations) {
      resolved.set(normalizeOrgnr(org.orgnr), touchOrgDetailCache(org))
    }
  }

  return unique
    .map((orgnr) => resolved.get(orgnr))
    .filter((org): org is Organization => org != null)
}

export async function fetchKonsernstruktur(
  orgnr: string,
  signal?: AbortSignal,
): Promise<Konsernstruktur | null> {
  if (STATIC_API) return null

  let response: Response
  try {
    response = await fetch(`${API_BASE}/api/organizations/${orgnr}/konsern`, { signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError('Kan ikke nå databasen for konsernstruktur.')
  }

  if (response.status === 404) return null
  if (!response.ok) {
    throw new ApiError(`Konsern-API feilet (${response.status})`)
  }

  const data = (await response.json()) as { konsern: Konsernstruktur }
  return data.konsern
}

export async function fetchOrganizationLocation(orgnr: string): Promise<OrganizationLocation> {
  if (STATIC_API) {
    const hit = (await loadSearchIndexByOrgnr()).get(normalizeOrgnr(orgnr))
    if (!hit) {
      throw new ApiError('Organisasjon ikke funnet')
    }

    return {
      orgnr: hit.orgnr,
      lat: hit.lat,
      lng: hit.lng,
      kommunenummer: hit.kommunenummer,
      source: hit.lat != null && hit.lng != null ? 'database' : 'none',
    }
  }

  const data = await apiFetch<{ location: OrganizationLocation }>(
    `/api/organizations/${orgnr}/locate`,
  )
  return data.location
}

export async function searchOrganizations(
  query: string,
  limit = 8,
): Promise<OrganizationSearchHit[]> {
  if (STATIC_API) {
    const index = await loadOrgSearchIndex()
    return searchStaticOrganizations(query, limit, index)
  }

  const params = new URLSearchParams({ q: query, limit: String(limit) })
  const data = await apiFetch<{ results: OrganizationSearchHit[] }>(
    `/api/organizations/search?${params.toString()}`,
  )
  return data.results
}

import type { FeatureCollection } from 'geojson'
import type {
  Kommune,
  MapFilters,
  MunicipalityCount,
  Organization,
  OrganizationLocation,
  OrganizationPoint,
  OrganizationSearchHit,
  Organisasjonsform,
} from '../types'
import {
  canUseStaticTiles,
  filterPointsInBbox,
  parsePointsResponse,
  type CompactPoint,
} from '../map/points'
import { fetchViewportPointTiles } from '../map/pointTiles'
import { assetUrl } from '../utils/assets'
import { fetchStaticJson } from '../utils/staticJson'

const API_BASE = import.meta.env.VITE_API_URL ?? ''
const STATIC_API = import.meta.env.VITE_STATIC_API === 'true'
const STATIC_API_BASE = assetUrl('data/api')

interface MunicipalityBreakdownRow {
  kommunenummer: string
  org_type: string
  konkurs: number
  under_avvikling: number
  vat_registered: number
  count: number
}

type SearchIndexRow = [string, string, string, string, string, number | null, number | null]
type GeocodedPointRow = [string, number, number, string, string, number, number, number]

let municipalityBreakdownPromise: Promise<MunicipalityBreakdownRow[]> | null = null
let organizationsPromise: Promise<Record<string, Organization>> | null = null
let searchIndexPromise: Promise<OrganizationSearchHit[]> | null = null
let geocodedPointsPromise: Promise<GeocodedPointRow[]> | null = null
let geocodedPointsByKommunePromise: Promise<Map<string, GeocodedPointRow[]>> | null = null

async function staticFetch<T>(file: string): Promise<T> {
  const response = await fetch(`${STATIC_API_BASE}/${file}`)
  if (!response.ok) {
    throw new ApiError(`Statisk data mangler (${file})`)
  }
  return response.json() as Promise<T>
}

async function loadGeocodedPoints(): Promise<GeocodedPointRow[]> {
  geocodedPointsPromise ??= fetchStaticJson<{ rows: GeocodedPointRow[] }>(
    `${STATIC_API_BASE}/geocoded-points.json`,
  ).then((data) => data.rows)
  return geocodedPointsPromise
}

async function loadGeocodedPointsByKommune(): Promise<Map<string, GeocodedPointRow[]>> {
  geocodedPointsByKommunePromise ??= loadGeocodedPoints().then((rows) => {
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
  if (filters.orgTypes.length > 0 && !filters.orgTypes.includes(orgType)) return false
  if (filters.excludeKonkurs && konkurs !== 0) return false
  if (filters.excludeUnderAvvikling && underAvvikling !== 0) return false
  if (filters.vatRegisteredOnly && vatRegistered !== 1) return false
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

  const rows = options.kommunenumre?.length
    ? (await loadGeocodedPointsByKommune())
    : null

  const candidates: GeocodedPointRow[] = rows
    ? options.kommunenumre!.flatMap((kommunenummer) => rows.get(kommunenummer) ?? [])
    : await loadGeocodedPoints()

  for (const row of candidates) {
    if (!geocodedPointMatchesFilters(row, filters)) continue

    const [, lng, lat, orgType] = row
    if (options.bbox && !geocodedPointInBbox(row, options.bbox)) continue

    points.push({
      orgnr: row[0],
      lng,
      lat,
      orgType,
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

async function loadOrganizations(): Promise<Record<string, Organization>> {
  organizationsPromise ??= staticFetch<{ organizations: Record<string, Organization> }>(
    'organizations.json',
  ).then((data) => data.organizations)
  return organizationsPromise
}

async function loadSearchIndex(): Promise<OrganizationSearchHit[]> {
  searchIndexPromise ??= staticFetch<{ rows: SearchIndexRow[] }>('search-index.json').then((data) =>
    data.rows.map(([orgnr, navn, orgType, orgTypeLabel, kommunenummer, lat, lng]) => ({
      orgnr,
      navn,
      orgType,
      orgTypeLabel,
      kommunenummer,
      lat,
      lng,
    })),
  )
  return searchIndexPromise
}

function aggregateMunicipalityCounts(
  rows: MunicipalityBreakdownRow[],
  filters: MapFilters,
): MunicipalityCount[] {
  const totals = new Map<string, number>()

  for (const row of rows) {
    if (filters.orgTypes.length > 0 && !filters.orgTypes.includes(row.org_type)) continue
    if (filters.excludeKonkurs && row.konkurs !== 0) continue
    if (filters.excludeUnderAvvikling && row.under_avvikling !== 0) continue
    if (filters.vatRegisteredOnly && row.vat_registered !== 1) continue
    totals.set(row.kommunenummer, (totals.get(row.kommunenummer) ?? 0) + row.count)
  }

  return [...totals.entries()]
    .map(([kommunenummer, count]) => ({ kommunenummer, count }))
    .sort((a, b) => a.kommunenummer.localeCompare(b.kommunenummer))
}

function searchStaticOrganizations(query: string, limit: number, index: OrganizationSearchHit[]) {
  const raw = query.trim()
  if (raw.length < 2) return []

  const digits = raw.replace(/\D/g, '')
  if (digits.length === 9) {
    const hit = index.find((row) => row.orgnr === digits)
    return hit ? [hit] : []
  }

  const lower = raw.toLowerCase()
  return index
    .filter((row) => row.navn.toLowerCase().includes(lower))
    .sort((a, b) => {
      const aPrefix = a.navn.toLowerCase().startsWith(lower) ? 0 : 1
      const bPrefix = b.navn.toLowerCase().startsWith(lower) ? 0 : 1
      if (aPrefix !== bPrefix) return aPrefix - bPrefix
      return a.navn.length - b.navn.length || a.navn.localeCompare(b.navn, 'nb')
    })
    .slice(0, limit)
}

export const MIN_DOTS_ZOOM = 9
export const DOTS_DETAIL_MIN_ZOOM = 12
export const MAX_VIEWPORT_DOTS = 50000

class ApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (STATIC_API) {
    throw new ApiError('Live API er deaktivert i statisk modus')
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, init)
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

export function limitForZoom(zoom: number): number {
  if (zoom < 10) return 5000
  if (zoom < 12) return 15000
  if (zoom < 14) return 30000
  return 50000
}

/** Filters that require server-side data reload (excludes orgTypes). */
export function dataFiltersToParams(filters: MapFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (!filters.excludeKonkurs) params.set('excludeKonkurs', 'false')
  if (!filters.excludeUnderAvvikling) params.set('excludeUnderAvvikling', 'false')
  if (filters.vatRegisteredOnly) params.set('vatRegisteredOnly', 'true')
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
  const data = await apiFetch<{ organisasjonsformer: Organisasjonsform[] }>('/api/organisasjonsformer')
  return data.organisasjonsformer
}

export async function fetchKommuner(geojson: FeatureCollection | null): Promise<Kommune[]> {
  const data = STATIC_API
    ? await staticFetch<{ kommuner: Array<{ nummer: string; count: number }> }>('kommuner.json')
    : await apiFetch<{ kommuner: Array<{ nummer: string; count: number }> }>('/api/kommuner')
  const names = new Map<string, string>()

  for (const feature of geojson?.features ?? []) {
    const props = feature.properties as { kommunenummer?: string; kommunenavn?: string; name?: string } | null
    if (props?.kommunenummer) {
      names.set(props.kommunenummer, props.kommunenavn ?? props.name ?? props.kommunenummer)
    }
  }

  return data.kommuner.map((kommune) => ({
    nummer: kommune.nummer,
    navn: names.get(kommune.nummer) ?? kommune.nummer,
  }))
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

async function fetchOrganizationPointsFromApi(
  filters: MapFilters,
  options: FetchPointsOptions = {},
): Promise<{ points: OrganizationPoint[]; truncated: boolean }> {
  if (STATIC_API) {
    return fetchOrganizationPointsFromStatic(filters, options)
  }

  const params = dataFiltersToParams(filters)
  params.set('format', 'compact')

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
  }>(`/api/organizations/points?${params.toString()}`)

  return {
    points: parsePointsResponse(data),
    truncated: data.truncated,
  }
}

export async function fetchOrganizationPoints(
  filters: MapFilters,
  options: FetchPointsOptions = {},
): Promise<{ points: OrganizationPoint[]; truncated: boolean }> {
  const useTiles =
    !STATIC_API &&
    canUseStaticTiles(filters) &&
    options.kommunenumre &&
    options.kommunenumre.length > 0 &&
    options.bbox

  if (useTiles) {
    const tiled = await fetchViewportPointTiles(options.kommunenumre!, options.bbox!)
    if (tiled && tiled.length > 0) {
      return {
        points: tiled,
        truncated: false,
      }
    }
  }

  return fetchOrganizationPointsFromApi(filters, options)
}

export async function fetchOrganizationDetail(orgnr: string): Promise<Organization> {
  if (STATIC_API) {
    const organizations = await loadOrganizations()
    const organization = organizations[orgnr.replace(/\D/g, '')]
    if (!organization) {
      throw new ApiError('Organisasjon ikke funnet')
    }
    return organization
  }

  const data = await apiFetch<{ organization: Organization }>(`/api/organizations/${orgnr}`)
  return data.organization
}

export async function fetchOrganizationLocation(orgnr: string): Promise<OrganizationLocation> {
  if (STATIC_API) {
    const organizations = await loadOrganizations()
    const organization = organizations[orgnr.replace(/\D/g, '')]
    if (!organization) {
      throw new ApiError('Organisasjon ikke funnet')
    }

    return {
      orgnr: organization.orgnr,
      lat: organization.lat,
      lng: organization.lng,
      kommunenummer: organization.kommunenummer,
      source: organization.lat != null && organization.lng != null ? 'database' : 'none',
    }
  }

  const data = await apiFetch<{ location: OrganizationLocation }>(
    `/api/organizations/${orgnr}/locate`,
  )
  return data.location
}

export async function searchOrganizations(query: string, limit = 8): Promise<OrganizationSearchHit[]> {
  if (STATIC_API) {
    const index = await loadSearchIndex()
    return searchStaticOrganizations(query, limit, index)
  }

  const params = new URLSearchParams({ q: query, limit: String(limit) })
  const data = await apiFetch<{ results: OrganizationSearchHit[] }>(
    `/api/organizations/search?${params.toString()}`,
  )
  return data.results
}

/** @deprecated Use fetchOrganizationPoints for dots view */
export async function fetchOrganizations(
  kommunenumre: string[],
  filters: MapFilters,
  selectedFylke: string,
  limit = 50000,
): Promise<{ organizations: Organization[]; truncated: boolean }> {
  if (STATIC_API) {
    return { organizations: [], truncated: false }
  }

  const params = filtersToParams(filters)
  params.set('limit', String(limit))

  if (kommunenumre.length === 1) {
    params.set('kommunenummer', kommunenumre[0])
  } else if (kommunenumre.length > 1) {
    params.set('kommunenummer', kommunenumre.join(','))
  } else if (selectedFylke) {
    params.set('fylke', selectedFylke)
  }

  const data = await apiFetch<{ organizations: Organization[]; truncated: boolean }>(
    `/api/organizations?${params.toString()}`,
  )

  return {
    organizations: data.organizations,
    truncated: data.truncated,
  }
}

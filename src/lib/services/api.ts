import type { FeatureCollection } from 'geojson'
import type { Kommune, MapFilters, MunicipalityCount, Organization, Organisasjonsform } from '../types'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

export const MIN_DOTS_ZOOM = 9

class ApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
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

export async function checkApiHealth(): Promise<void> {
  await apiFetch<{ ok: boolean }>('/api/health')
}

export async function fetchOrganisasjonsformer(): Promise<Organisasjonsform[]> {
  const data = await apiFetch<{ organisasjonsformer: Organisasjonsform[] }>('/api/organisasjonsformer')
  return data.organisasjonsformer
}

export async function fetchKommuner(geojson: FeatureCollection | null): Promise<Kommune[]> {
  const data = await apiFetch<{ kommuner: Array<{ nummer: string; count: number }> }>('/api/kommuner')
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

function filtersToParams(filters: MapFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.orgTypes.length > 0) params.set('orgTypes', filters.orgTypes.join(','))
  if (!filters.excludeKonkurs) params.set('excludeKonkurs', 'false')
  if (!filters.excludeUnderAvvikling) params.set('excludeUnderAvvikling', 'false')
  if (filters.vatRegisteredOnly) params.set('vatRegisteredOnly', 'true')
  return params
}

export async function fetchMunicipalityCounts(filters: MapFilters): Promise<MunicipalityCount[]> {
  const params = filtersToParams(filters)
  const data = await apiFetch<{ counts: MunicipalityCount[] }>(
    `/api/municipality-counts?${params.toString()}`,
  )
  return data.counts
}

export async function fetchOrganizations(
  kommunenumre: string[],
  filters: MapFilters,
  selectedFylke: string,
  limit = 50000,
): Promise<{ organizations: Organization[]; truncated: boolean }> {
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

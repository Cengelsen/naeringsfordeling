import type { MapFilters, Organization, OrganizationPoint } from '../types'
import { bandMatchesFilter } from '../utils/employeeBands'
import { sectionMatchesFilter } from '../utils/naeringskode'
import { assetUrl } from '../utils/assets'

/** [orgnr, lng, lat, orgType] or extended with [navn, orgTypeLabel, addressText, postnummer] */
export type CompactPoint = [string, number, number, string, ...string[]]

export function fromCompactPoint(point: CompactPoint): OrganizationPoint {
  const base: OrganizationPoint = {
    orgnr: point[0],
    lng: point[1],
    lat: point[2],
    orgType: point[3],
  }
  if (point.length >= 8) {
    base.navn = point[4]
    base.orgTypeLabel = point[5]
    base.addressText = point[6]
    base.postnummer = point[7]
  }
  if (point.length >= 11) {
    base.naeringskode = point[8] || null
    base.employeeBand = (point[9] || 'unknown') as import('../utils/employeeBands').EmployeeBand
    base.entityKind = (point[10] || 'enhet') as 'enhet' | 'underenhet'
  }
  return base
}

export function organizationFromPoint(point: OrganizationPoint): Organization | null {
  if (!point.navn) return null
  return {
    orgnr: point.orgnr,
    navn: point.navn,
    orgType: point.orgType,
    orgTypeLabel: point.orgTypeLabel ?? point.orgType,
    addressText: point.addressText ?? '',
    postnummer: point.postnummer ?? '',
    kommunenummer: point.kommunenummer ?? '',
    lat: point.lat,
    lng: point.lng,
  }
}

export function normalizeOrgnr(orgnr: string): string {
  return orgnr.replace(/\D/g, '')
}

export function fromCompactPoints(points: CompactPoint[]): OrganizationPoint[] {
  return points.map(fromCompactPoint)
}

export function filterPointsInBbox(
  points: OrganizationPoint[],
  bbox: [number, number, number, number],
): OrganizationPoint[] {
  const [minLng, minLat, maxLng, maxLat] = bbox
  return points.filter(
    (point) =>
      point.lng >= minLng &&
      point.lng <= maxLng &&
      point.lat >= minLat &&
      point.lat <= maxLat,
  )
}

export function filterPointsByOrgTypes(
  points: OrganizationPoint[],
  orgTypes: string[],
): OrganizationPoint[] {
  if (orgTypes.length === 0) return points
  const allowed = new Set(orgTypes)
  return points.filter((point) => allowed.has(point.orgType))
}

export function filterPointsByMapFilters(
  points: OrganizationPoint[],
  filters: Pick<
    MapFilters,
    'orgTypes' | 'naeringskodeSections' | 'employeeBands' | 'entityKinds'
  >,
): OrganizationPoint[] {
  return points.filter((point) => {
    if (filters.orgTypes.length > 0 && !filters.orgTypes.includes(point.orgType)) return false
    if (!sectionMatchesFilter(point.naeringskode, filters.naeringskodeSections)) return false
    if (
      !bandMatchesFilter(point.employeeBand ?? 'unknown', filters.employeeBands)
    ) {
      return false
    }
    if (
      filters.entityKinds.length > 0 &&
      point.entityKind &&
      !filters.entityKinds.includes(point.entityKind)
    ) {
      return false
    }
    return true
  })
}

export function parsePointsResponse(data: {
  points: OrganizationPoint[] | CompactPoint[]
}): OrganizationPoint[] {
  if (data.points.length === 0) return []
  const first = data.points[0]
  if (Array.isArray(first)) {
    return fromCompactPoints(data.points as CompactPoint[])
  }
  return data.points as OrganizationPoint[]
}

export async function fetchKommunePointTile(
  kommunenummer: string,
  bbox?: [number, number, number, number],
): Promise<OrganizationPoint[] | null> {
  if (bbox) {
    const { fetchKommunePointsForViewport } = await import('./pointTiles')
    return fetchKommunePointsForViewport(kommunenummer, bbox)
  }

  try {
    const response = await fetch(assetUrl(`data/points/${kommunenummer}.json`))
    if (!response.ok) return null
    const data = (await response.json()) as { points: CompactPoint[] }
    return fromCompactPoints(data.points)
  } catch {
    return null
  }
}

/** @deprecated Use fetchViewportPointTiles */
export async function fetchKommunePointTiles(
  kommunenumre: string[],
  bbox?: [number, number, number, number],
): Promise<OrganizationPoint[] | null> {
  if (bbox) {
    const { fetchViewportPointTiles } = await import('./pointTiles')
    return fetchViewportPointTiles(kommunenumre, bbox)
  }

  if (kommunenumre.length === 0) return null

  const results = await Promise.all(kommunenumre.map((nr) => fetchKommunePointTile(nr)))
  if (results.every((result) => result == null)) return null

  return results.flatMap((result) => result ?? [])
}

export function canUseStaticTiles(filters: MapFilters): boolean {
  return (
    filters.excludeKonkurs &&
    filters.excludeUnderAvvikling &&
    !filters.vatRegisteredOnly &&
    filters.naeringskodeSections.length === 0 &&
    filters.employeeBands.length === 0 &&
    filters.entityKinds.length <= 1 &&
    filters.entityKinds.every((kind) => kind === 'enhet') &&
    !filters.konsernMembersOnly
  )
}

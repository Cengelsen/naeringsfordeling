export type CompactPoint = [string, number, number, string, ...string[]]

export interface OrganizationPointRow {
  orgnr: string
  orgType: string
  lat: number
  lng: number
}

export const COORD_PRECISION = 6

export function roundCoord(value: number): number {
  const factor = 10 ** COORD_PRECISION
  return Math.round(value * factor) / factor
}

export function toCompactPoint(
  orgnr: string,
  lng: number,
  lat: number,
  orgType: string,
  details?: {
    navn: string
    orgTypeLabel: string
    addressText: string
    postnummer: string
    naeringskode?: string
    employeeBand?: string
    entityKind?: string
  },
): CompactPoint {
  const base: CompactPoint = [orgnr, roundCoord(lng), roundCoord(lat), orgType]
  if (details) {
    base.push(
      details.navn,
      details.orgTypeLabel,
      details.addressText,
      details.postnummer,
      details.naeringskode ?? '',
      details.employeeBand ?? '',
      details.entityKind ?? 'enhet',
    )
  }
  return base
}

export function fromCompactPoint(point: CompactPoint): OrganizationPointRow {
  return {
    orgnr: point[0],
    lng: point[1],
    lat: point[2],
    orgType: point[3],
  }
}

export function fromCompactPoints(points: CompactPoint[]): OrganizationPointRow[] {
  return points.map(fromCompactPoint)
}

export function filterPointsInBbox(
  points: OrganizationPointRow[],
  bbox: [number, number, number, number],
): OrganizationPointRow[] {
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
  points: OrganizationPointRow[],
  orgTypes: string[],
): OrganizationPointRow[] {
  if (orgTypes.length === 0) return points
  const allowed = new Set(orgTypes)
  return points.filter((point) => allowed.has(point.orgType))
}

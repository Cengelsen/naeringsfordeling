export {
  type CompactPoint,
  COORD_PRECISION,
  roundCoord,
  toCompactPoint,
  filterPointsInBbox,
  filterPointsByOrgTypes,
} from '../../shared/points.js'

export interface OrganizationPointRow {
  orgnr: string
  orgType: string
  lat: number
  lng: number
}

export function fromCompactPoint(
  point: import('../../shared/points.js').CompactPoint,
): OrganizationPointRow {
  return {
    orgnr: point[0],
    lng: point[1],
    lat: point[2],
    orgType: point[3],
  }
}

export function fromCompactPoints(
  points: import('../../shared/points.js').CompactPoint[],
): OrganizationPointRow[] {
  return points.map(fromCompactPoint)
}

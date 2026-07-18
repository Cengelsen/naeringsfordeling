import type { OrganizationPoint } from '../types'

const LOCATION_PRECISION = 5

export function locationKey(lat: number, lng: number): string {
  return `${lat.toFixed(LOCATION_PRECISION)}:${lng.toFixed(LOCATION_PRECISION)}`
}

export interface LocationGroup {
  lat: number
  lng: number
  orgs: OrganizationPoint[]
  orgCount: number
  /** Single org type, or `MIXED` when several types share the address. */
  orgType: string
}

export function groupPointsByLocation(points: OrganizationPoint[]): LocationGroup[] {
  const groups = new Map<string, LocationGroup>()

  for (const point of points) {
    const key = locationKey(point.lat, point.lng)
    let group = groups.get(key)
    if (!group) {
      group = {
        lat: point.lat,
        lng: point.lng,
        orgs: [],
        orgCount: 0,
        orgType: point.orgType,
      }
      groups.set(key, group)
    }
    group.orgs.push(point)
    group.orgCount = group.orgs.length
  }

  for (const group of groups.values()) {
    const types = new Set(group.orgs.map((org) => org.orgType))
    group.orgType = types.size === 1 ? group.orgs[0]!.orgType : 'MIXED'
  }

  return [...groups.values()]
}

export function orgnrsFromGroup(group: LocationGroup): string[] {
  return group.orgs.map((org) => org.orgnr)
}

export interface OrgTypeSegment {
  orgType: string
  count: number
  fraction: number
}

export function orgTypeSegments(group: LocationGroup): OrgTypeSegment[] {
  const counts = new Map<string, number>()
  for (const org of group.orgs) {
    counts.set(org.orgType, (counts.get(org.orgType) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([orgType, count]) => ({
      orgType,
      count,
      fraction: count / group.orgCount,
    }))
}

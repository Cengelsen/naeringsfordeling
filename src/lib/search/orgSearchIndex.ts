import type { OrganizationSearchHit } from '../types'
import { normalizeOrgnr } from '../map/points'

export interface OrgSearchIndex {
  rows: OrganizationSearchHit[]
  navnLower: string[]
  orgnrSorted: OrganizationSearchHit[]
  byOrgnr: Map<string, OrganizationSearchHit>
  nameBuckets: Map<string, number[]>
}

function nameBucketKey(navnLower: string): string {
  return navnLower.slice(0, 3).padEnd(3, ' ')
}

export function buildOrgSearchIndex(rows: OrganizationSearchHit[]): OrgSearchIndex {
  const navnLower = new Array<string>(rows.length)
  const nameBuckets = new Map<string, number[]>()
  const byOrgnr = new Map<string, OrganizationSearchHit>()

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    const lower = row.navn.toLowerCase()
    navnLower[index] = lower
    byOrgnr.set(normalizeOrgnr(row.orgnr), row)

    const key = nameBucketKey(lower)
    const bucket = nameBuckets.get(key)
    if (bucket) {
      bucket.push(index)
    } else {
      nameBuckets.set(key, [index])
    }
  }

  return {
    rows,
    navnLower,
    orgnrSorted: [...rows].sort((left, right) => left.orgnr.localeCompare(right.orgnr)),
    byOrgnr,
    nameBuckets,
  }
}

function searchOrgnrPrefix(
  sorted: OrganizationSearchHit[],
  digits: string,
  limit: number,
): OrganizationSearchHit[] {
  let lo = 0
  let hi = sorted.length

  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid]!.orgnr < digits) lo = mid + 1
    else hi = mid
  }

  const results: OrganizationSearchHit[] = []
  for (let index = lo; index < sorted.length && results.length < limit; index++) {
    const row = sorted[index]!
    if (!row.orgnr.startsWith(digits)) break
    results.push(row)
  }

  return results
}

function nameBucketCandidates(index: OrgSearchIndex, lower: string): number[] {
  if (lower.length >= 3) {
    return index.nameBuckets.get(nameBucketKey(lower)) ?? []
  }

  const candidates: number[] = []
  for (const [key, indices] of index.nameBuckets) {
    if (key.startsWith(lower)) {
      candidates.push(...indices)
    }
  }
  return candidates
}

function collectNameMatches(
  index: OrgSearchIndex,
  candidateIndices: Iterable<number>,
  lower: string,
  limit: number,
): OrganizationSearchHit[] {
  const prefix: OrganizationSearchHit[] = []
  const other: OrganizationSearchHit[] = []
  const maxCollect = Math.max(limit * 6, 48)

  for (const rowIndex of candidateIndices) {
    const name = index.navnLower[rowIndex]!
    if (!name.includes(lower)) continue

    const hit = index.rows[rowIndex]!
    if (name.startsWith(lower)) prefix.push(hit)
    else other.push(hit)

    if (prefix.length + other.length >= maxCollect) break
  }

  const byName = (left: OrganizationSearchHit, right: OrganizationSearchHit) =>
    left.navn.length - right.navn.length || left.navn.localeCompare(right.navn, 'nb')

  prefix.sort(byName)
  other.sort(byName)
  return [...prefix, ...other].slice(0, limit)
}

export function searchOrgSearchIndex(
  index: OrgSearchIndex,
  query: string,
  limit: number,
): OrganizationSearchHit[] {
  const raw = query.trim()
  if (raw.length < 2) return []

  const digits = raw.replace(/\D/g, '')

  if (digits.length === 9) {
    const hit = index.byOrgnr.get(digits)
    return hit ? [hit] : []
  }

  if (digits.length >= 3 && /^[\d\s]+$/.test(raw)) {
    return searchOrgnrPrefix(index.orgnrSorted, digits, limit)
  }

  const lower = raw.toLowerCase()
  const candidates = nameBucketCandidates(index, lower)
  if (candidates.length === 0) return []

  return collectNameMatches(index, candidates, lower, limit)
}

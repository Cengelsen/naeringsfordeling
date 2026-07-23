import { isDetailZoom } from '../../src/lib/lodConfig.js'

/** Max points returned for a viewport request (aggregate zoom sampling). */
export const MAX_VIEWPORT_DOTS = 50_000

export const POINT_SAMPLE_OVERSAMPLE = 5

/** Target point count for a map zoom level (smooth scale, no hard cutoff). */
export function limitForZoom(zoom?: number, explicitLimit?: number): number {
  if (explicitLimit != null) {
    return Math.min(Math.max(1, explicitLimit), MAX_VIEWPORT_DOTS)
  }

  if (isDetailZoom(zoom)) {
    return MAX_VIEWPORT_DOTS
  }

  if (zoom == null || !Number.isFinite(zoom)) {
    return 5000
  }

  const z = Math.max(4, Math.min(18, zoom))
  return Math.min(MAX_VIEWPORT_DOTS, Math.round(250 * 1.38 ** (z - 4)))
}

export function fetchLimitForTarget(target: number, zoom?: number): number | null {
  if (isDetailZoom(zoom)) {
    return null
  }
  return Math.min(MAX_VIEWPORT_DOTS, Math.max(target, target * POINT_SAMPLE_OVERSAMPLE))
}

type Bbox = [number, number, number, number]

function bboxFromPoints<T>(points: T[], lat: (p: T) => number, lng: (p: T) => number): Bbox {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity

  for (const point of points) {
    minLng = Math.min(minLng, lng(point))
    maxLng = Math.max(maxLng, lng(point))
    minLat = Math.min(minLat, lat(point))
    maxLat = Math.max(maxLat, lat(point))
  }

  if (!Number.isFinite(minLng)) {
    return [0, 0, 0, 0]
  }

  return [minLng, minLat, maxLng, maxLat]
}

function allocateTypeTargets(typeTotals: Map<string, number>, maxCount: number): Map<string, number> {
  const types = [...typeTotals.keys()].sort()
  const total = [...typeTotals.values()].reduce((sum, count) => sum + count, 0)
  const targets = new Map<string, number>()

  if (types.length === 0 || maxCount <= 0) return targets

  if (maxCount <= types.length) {
    const sorted = [...typeTotals.entries()].sort((a, b) => b[1] - a[1])
    for (let index = 0; index < maxCount; index += 1) {
      targets.set(sorted[index]![0], 1)
    }
    return targets
  }

  let assigned = 0
  for (const type of types) {
    const count = typeTotals.get(type) ?? 0
    const share = Math.max(1, Math.round((count / total) * maxCount))
    targets.set(type, share)
    assigned += share
  }

  while (assigned > maxCount) {
    let largestType = types[0]!
    let largest = targets.get(largestType) ?? 0
    for (const type of types) {
      const value = targets.get(type) ?? 0
      if (value > largest) {
        largest = value
        largestType = type
      }
    }
    if (largest <= 1) break
    targets.set(largestType, largest - 1)
    assigned -= 1
  }

  while (assigned < maxCount) {
    let bestType = types[0]!
    let bestRatio = -1
    for (const type of types) {
      const target = targets.get(type) ?? 0
      const count = typeTotals.get(type) ?? 1
      const ratio = target / count
      if (ratio < bestRatio || bestRatio < 0) {
        bestRatio = ratio
        bestType = type
      }
    }
    targets.set(bestType, (targets.get(bestType) ?? 0) + 1)
    assigned += 1
  }

  return targets
}

/**
 * Thin points for low zoom while preserving org-type proportions and geographic spread.
 */
export function stratifiedSamplePoints<T>(
  points: T[],
  maxCount: number,
  bbox: Bbox | undefined,
  accessors: {
    orgType: (point: T) => string
    lat: (point: T) => number
    lng: (point: T) => number
  },
): T[] {
  if (points.length <= maxCount) return points
  if (maxCount <= 0) return []

  const typeTotals = new Map<string, number>()
  for (const point of points) {
    const type = accessors.orgType(point)
    typeTotals.set(type, (typeTotals.get(type) ?? 0) + 1)
  }

  const targets = allocateTypeTargets(typeTotals, maxCount)
  const bounds = bbox ?? bboxFromPoints(points, accessors.lat, accessors.lng)
  const [minLng, minLat, maxLng, maxLat] = bounds
  const width = Math.max(maxLng - minLng, 0.01)
  const height = Math.max(maxLat - minLat, 0.01)
  const gridCells = Math.max(4, Math.ceil(Math.sqrt(maxCount * 1.2)))

  const cells = new Map<string, Map<string, T[]>>()

  for (const point of points) {
    const gx = Math.min(
      gridCells - 1,
      Math.max(0, Math.floor(((accessors.lng(point) - minLng) / width) * gridCells)),
    )
    const gy = Math.min(
      gridCells - 1,
      Math.max(0, Math.floor(((accessors.lat(point) - minLat) / height) * gridCells)),
    )
    const cellKey = `${gx}:${gy}`
    const orgType = accessors.orgType(point)

    let bucket = cells.get(cellKey)
    if (!bucket) {
      bucket = new Map()
      cells.set(cellKey, bucket)
    }

    const list = bucket.get(orgType) ?? []
    list.push(point)
    bucket.set(orgType, list)
  }

  const picked: T[] = []
  const pickedPerType = new Map<string, number>()
  for (const type of typeTotals.keys()) {
    pickedPerType.set(type, 0)
  }

  const cellKeys = [...cells.keys()].sort()
  let progress = true

  while (picked.length < maxCount && progress) {
    progress = false
    for (const cellKey of cellKeys) {
      if (picked.length >= maxCount) break
      const bucket = cells.get(cellKey)
      if (!bucket) continue

      for (const [type, list] of bucket.entries()) {
        const target = targets.get(type) ?? 0
        if ((pickedPerType.get(type) ?? 0) >= target) continue
        if (list.length === 0) continue

        picked.push(list.shift()!)
        pickedPerType.set(type, (pickedPerType.get(type) ?? 0) + 1)
        progress = true
        if (picked.length >= maxCount) break
      }
    }
  }

  if (picked.length < maxCount) {
    const seen = new Set(picked)
    for (const point of points) {
      if (picked.length >= maxCount) break
      if (seen.has(point)) continue
      picked.push(point)
    }
  }

  return picked
}

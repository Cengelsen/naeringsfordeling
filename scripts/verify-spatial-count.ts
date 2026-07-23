/**
 * Verify SpatialCountIndex matches naive O(N) counts and stays exact.
 */
import { SpatialCountIndex } from '../server/spatialCountIndex.js'

function naiveCount(
  points: Array<{ x: number; y: number }>,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number {
  let count = 0
  for (const point of points) {
    if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) count += 1
  }
  return count
}

function assertEqual(label: string, got: number, expected: number) {
  if (got !== expected) {
    throw new Error(`${label}: got ${got}, expected ${expected}`)
  }
}

const points: Array<{ x: number; y: number }> = []
for (let i = 0; i < 5000; i += 1) {
  points.push({
    x: (i % 100) + (i % 7) * 0.01,
    y: Math.floor(i / 100) + (i % 5) * 0.01,
  })
}
// duplicates
points.push({ x: 10, y: 10 }, { x: 10, y: 10 })

const index = new SpatialCountIndex(points)

const queries: Array<[number, number, number, number]> = [
  [0, 0, 10, 10],
  [5.5, 12.2, 40.1, 48.9],
  [-1, -1, 200, 200],
  [50, 50, 49, 49], // empty inverted
  [10, 10, 10, 10],
  [0, 0, 0, 0],
  [99, 49, 99.9, 49.9],
]

for (const [minX, minY, maxX, maxY] of queries) {
  const expected =
    minX > maxX || minY > maxY ? 0 : naiveCount(points, minX, minY, maxX, maxY)
  const got = index.countBbox(minX, minY, maxX, maxY)
  assertEqual(`bbox ${minX},${minY},${maxX},${maxY}`, got, expected)
}

// Timing sanity: many queries should be near-instant vs naive.
const tight = [20, 20, 80, 40] as const
const rounds = 2000
const t0 = performance.now()
let sink = 0
for (let i = 0; i < rounds; i += 1) {
  sink += index.countBbox(tight[0], tight[1], tight[2], tight[3])
}
const indexedMs = performance.now() - t0

const t1 = performance.now()
for (let i = 0; i < rounds; i += 1) {
  sink += naiveCount(points, tight[0], tight[1], tight[2], tight[3])
}
const naiveMs = performance.now() - t1

if (sink === 0) throw new Error('unexpected empty sink')
console.log(
  `verify-spatial-count: ok (${rounds} queries; index ${indexedMs.toFixed(1)}ms vs naive ${naiveMs.toFixed(1)}ms)`,
)

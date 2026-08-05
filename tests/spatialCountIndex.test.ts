import { describe, it, expect } from 'vitest'
import { SpatialCountIndex } from '../server/spatialCountIndex'
import type { Point2D } from '../server/spatialCountIndex'

function bruteForceCount(
  points: Point2D[],
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
): number {
  return points.filter(
    (p) => p.x >= minLng && p.x <= maxLng && p.y >= minLat && p.y <= maxLat,
  ).length
}

describe('SpatialCountIndex', () => {
  it('matches brute-force counting with random points', () => {
    const points: Point2D[] = []
    for (let i = 0; i < 200; i++) {
      points.push({ x: Math.random() * 10, y: Math.random() * 10 })
    }

    const index = new SpatialCountIndex(points)
    expect(index.size).toBe(200)

    const bboxes: [number, number, number, number][] = [
      [2, 2, 8, 8],
      [0, 0, 5, 5],
      [5, 5, 10, 10],
      [3, 3, 7, 7],
    ]

    for (const [minLng, minLat, maxLng, maxLat] of bboxes) {
      const expected = bruteForceCount(points, minLng, minLat, maxLng, maxLat)
      const actual = index.countBbox(minLng, minLat, maxLng, maxLat)
      expect(actual).toBe(expected)
    }
  })

  it('handles empty set', () => {
    const index = new SpatialCountIndex([])
    expect(index.size).toBe(0)
    expect(index.countBbox(0, 0, 10, 10)).toBe(0)
  })

  it('handles single point', () => {
    const index = new SpatialCountIndex([{ x: 5, y: 5 }])
    expect(index.countBbox(0, 0, 10, 10)).toBe(1)
    expect(index.countBbox(6, 6, 10, 10)).toBe(0)
  })

  it('returns all points when bbox covers everything', () => {
    const points: Point2D[] = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]
    const index = new SpatialCountIndex(points)
    expect(index.countBbox(0, 0, 10, 10)).toBe(3)
  })

  it('returns 0 when no points in bbox', () => {
    const points: Point2D[] = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]
    const index = new SpatialCountIndex(points)
    expect(index.countBbox(5, 5, 10, 10)).toBe(0)
  })
})

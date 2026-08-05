import { describe, it, expect } from 'vitest'
import { colorForValue, kommuneScaleMax } from '../src/lib/utils/colors'
import { colorForOrgType } from '../src/lib/utils/orgTypeColors'

describe('colorForValue', () => {
  it('returns correct color at 0', () => {
    const color = colorForValue(0, 100, 'blues')
    expect(color).toBe('#e8e8e8')
  })

  it('returns correct color at max', () => {
    const color = colorForValue(100, 100, 'blues')
    expect(color).toBe('#08306b')
  })

  it('handles value beyond max', () => {
    const color = colorForValue(200, 100, 'blues')
    expect(color).toBe('#08306b')
  })

  it('returns a color string for mid-range values', () => {
    const color = colorForValue(50, 100, 'oranges')
    expect(color).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('kommuneScaleMax', () => {
  it('calculates reasonable percentile', () => {
    const counts = [1000, 2000, 3000, 5000, 10000, 50000, 100000]
    const max = kommuneScaleMax(counts)
    expect(max).toBeGreaterThanOrEqual(10_000)
    expect(max % 10_000).toBe(0)
  })

  it('returns 10000 for empty counts', () => {
    expect(kommuneScaleMax([])).toBe(10_000)
  })
})

describe('colorForOrgType', () => {
  it('returns consistent colors for same org type', () => {
    const color1 = colorForOrgType('AS')
    const color2 = colorForOrgType('AS')
    expect(color1).toBe(color2)
  })

  it('returns different colors for different org types', () => {
    const colorAS = colorForOrgType('AS')
    const colorENK = colorForOrgType('ENK')
    expect(colorAS).not.toBe(colorENK)
  })

  it('returns valid hex color strings', () => {
    expect(colorForOrgType('AS')).toMatch(/^#[0-9a-f]{6}$/)
    expect(colorForOrgType('ENK')).toMatch(/^#[0-9a-f]{6}$/)
    expect(colorForOrgType('UNKNOWN_TYPE')).toMatch(/^#[0-9a-f]{6}$/)
  })
})

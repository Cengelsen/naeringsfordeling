import { describe, it, expect } from 'vitest'
import {
  normalizeOrgnr,
  filterPointsByMapFilters,
  parsePointsResponse,
  fromCompactPoint,
} from '../src/lib/map/points'
import type { OrganizationPoint } from '../src/lib/types'

describe('normalizeOrgnr', () => {
  it('strips non-digit characters', () => {
    expect(normalizeOrgnr('123-456-789')).toBe('123456789')
  })

  it('preserves digit-only strings', () => {
    expect(normalizeOrgnr('987654321')).toBe('987654321')
  })

  it('handles empty string', () => {
    expect(normalizeOrgnr('')).toBe('')
  })
})

describe('filterPointsByMapFilters', () => {
  const points: OrganizationPoint[] = [
    { orgnr: '1', orgType: 'AS', lat: 60, lng: 5, naeringskode: '62.01', employeeBand: '5-19', entityKind: 'enhet' },
    { orgnr: '2', orgType: 'ENK', lat: 61, lng: 6, naeringskode: '47.01', employeeBand: '0', entityKind: 'enhet' },
    { orgnr: '3', orgType: 'AS', lat: 62, lng: 7, naeringskode: '68.01', employeeBand: '20+', entityKind: 'underenhet' },
  ]

  it('with no active filters returns all points', () => {
    const result = filterPointsByMapFilters(points, {
      orgTypes: [],
      naeringskodeSections: [],
      employeeBands: [],
      entityKinds: [],
    })
    expect(result).toHaveLength(3)
  })

  it('filters by orgType correctly', () => {
    const result = filterPointsByMapFilters(points, {
      orgTypes: ['AS'],
      naeringskodeSections: [],
      employeeBands: [],
      entityKinds: [],
    })
    expect(result).toHaveLength(2)
    expect(result.every((p) => p.orgType === 'AS')).toBe(true)
  })
})

describe('parsePointsResponse', () => {
  it('handles compact format', () => {
    const compact = [['123456789', 5.3, 60.4, 'AS']] as any
    const result = parsePointsResponse({ points: compact })
    expect(result).toHaveLength(1)
    expect(result[0].orgnr).toBe('123456789')
    expect(result[0].lng).toBe(5.3)
    expect(result[0].lat).toBe(60.4)
    expect(result[0].orgType).toBe('AS')
  })

  it('handles object format', () => {
    const objectPoints: OrganizationPoint[] = [
      { orgnr: '111', orgType: 'ENK', lat: 59, lng: 10 },
    ]
    const result = parsePointsResponse({ points: objectPoints })
    expect(result).toHaveLength(1)
    expect(result[0].orgnr).toBe('111')
  })

  it('handles empty array', () => {
    const result = parsePointsResponse({ points: [] })
    expect(result).toEqual([])
  })
})

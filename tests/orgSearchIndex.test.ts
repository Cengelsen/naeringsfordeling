import { describe, it, expect } from 'vitest'
import { buildOrgSearchIndex, searchOrgSearchIndex } from '../src/lib/search/orgSearchIndex'
import type { OrganizationSearchHit } from '../src/lib/types'

function makeHit(orgnr: string, navn: string): OrganizationSearchHit {
  return {
    orgnr,
    navn,
    orgType: 'AS',
    orgTypeLabel: 'Aksjeselskap',
    kommunenummer: '4601',
    lat: 60.39,
    lng: 5.32,
  }
}

describe('buildOrgSearchIndex', () => {
  it('creates an index', () => {
    const rows = [makeHit('123456789', 'Test AS')]
    const index = buildOrgSearchIndex(rows)
    expect(index.rows).toHaveLength(1)
    expect(index.byOrgnr.size).toBe(1)
  })
})

describe('searchOrgSearchIndex', () => {
  const rows = [
    makeHit('123456789', 'Bergen Fiskehandel AS'),
    makeHit('987654321', 'Stavanger IT Solutions'),
    makeHit('111222333', 'Bergen Bakeri'),
    makeHit('555666777', 'Oslo Consulting Group'),
  ]
  const index = buildOrgSearchIndex(rows)

  it('finds by name prefix', () => {
    const results = searchOrgSearchIndex(index, 'Bergen', 10)
    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results.every((r) => r.navn.toLowerCase().includes('bergen'))).toBe(true)
  })

  it('finds by orgnr', () => {
    const results = searchOrgSearchIndex(index, '123456789', 10)
    expect(results).toHaveLength(1)
    expect(results[0].orgnr).toBe('123456789')
  })

  it('returns empty for no match', () => {
    const results = searchOrgSearchIndex(index, 'xyznonexistent', 10)
    expect(results).toEqual([])
  })

  it('handles empty query', () => {
    const results = searchOrgSearchIndex(index, '', 10)
    expect(results).toEqual([])
  })

  it('handles single character query', () => {
    const results = searchOrgSearchIndex(index, 'B', 10)
    expect(results).toEqual([])
  })
})

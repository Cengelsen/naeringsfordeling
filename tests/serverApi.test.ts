import { describe, it, expect } from 'vitest'
import { parseFilters, buildFilterQuery, appendAreaFilters, appendBboxFilter } from '../server/filters'

function mockQuery(params: Record<string, string>) {
  return {
    query: (key: string) => params[key],
  }
}

describe('server API filter query building', () => {
  it('builds correct WHERE clause for default filters', () => {
    const filters = parseFilters(mockQuery({}))
    const { conditions, params } = buildFilterQuery(filters, true)

    expect(conditions).toContain('deleted = 0')
    expect(conditions.some((c) => c.includes('lat'))).toBe(true)
    expect(conditions.some((c) => c.includes('konkurs'))).toBe(true)
    expect(conditions.some((c) => c.includes('under_avvikling'))).toBe(true)
    expect(params.length).toBeGreaterThan(0)
  })

  it('builds correct clause with orgTypes filter', () => {
    const filters = parseFilters(mockQuery({ orgTypes: 'AS,ENK' }))
    const { conditions, params } = buildFilterQuery(filters, true)

    expect(conditions.some((c) => c.includes('org_type'))).toBe(true)
    expect(params).toContain('AS')
    expect(params).toContain('ENK')
  })

  it('includes naeringskode filter when provided', () => {
    const filters = parseFilters(mockQuery({ naeringskodeSections: '62,43' }))
    const { conditions, params } = buildFilterQuery(filters, true)

    expect(conditions.some((c) => c.includes('naeringskode'))).toBe(true)
    expect(params).toContain('62')
    expect(params).toContain('43')
  })

  it('includes employee band filter when provided', () => {
    const filters = parseFilters(mockQuery({ employeeBands: '5-19,20+' }))
    const { conditions, params } = buildFilterQuery(filters, true)

    expect(conditions.some((c) => c.includes('employee_band'))).toBe(true)
    expect(params).toContain('5-19')
    expect(params).toContain('20+')
  })

  it('appendAreaFilters adds kommunenummer condition', () => {
    const filters = parseFilters(mockQuery({ kommunenummer: '0301,1101' }))
    const conditions: string[] = ['o.deleted = 0']
    const params: (string | number)[] = []
    appendAreaFilters(filters, conditions, params)

    expect(conditions.some((c) => c.includes('kommunenummer'))).toBe(true)
    expect(params).toContain('0301')
    expect(params).toContain('1101')
  })

  it('appendAreaFilters adds fylke condition', () => {
    const filters = parseFilters(mockQuery({ fylke: '03' }))
    const conditions: string[] = ['deleted = 0']
    const params: (string | number)[] = []
    appendAreaFilters(filters, conditions, params)

    expect(conditions.some((c) => c.includes('kommunenummer'))).toBe(true)
    expect(params).toContain('03')
  })

  it('appendBboxFilter adds lat/lng bounds', () => {
    const conditions: string[] = []
    const params: (string | number)[] = []
    const bbox: [number, number, number, number] = [5.0, 60.0, 6.0, 61.0]
    appendBboxFilter(bbox, conditions, params, 'o')

    expect(conditions.length).toBe(4)
    expect(params).toEqual([60.0, 61.0, 5.0, 6.0])
  })

  it('vatRegisteredOnly adds correct condition', () => {
    const filters = parseFilters(mockQuery({ vatRegisteredOnly: 'true' }))
    const { conditions } = buildFilterQuery(filters, true)

    expect(conditions.some((c) => c.includes('vat_registered'))).toBe(true)
  })

  it('entityKinds filter defaults to enhet', () => {
    const filters = parseFilters(mockQuery({}))
    expect(filters.entityKinds).toEqual(['enhet'])
  })

  it('entityKinds filter accepts both', () => {
    const filters = parseFilters(mockQuery({ entityKinds: 'enhet,underenhet' }))
    expect(filters.entityKinds).toEqual(['enhet', 'underenhet'])
  })

  it('konsernMembersOnly adds er_i_konsern condition', () => {
    const filters = parseFilters(mockQuery({ konsernMembersOnly: 'true' }))
    const { conditions } = buildFilterQuery(filters, true)

    expect(conditions.some((c) => c.includes('er_i_konsern'))).toBe(true)
  })

  it('geocodedOnly=false omits lat/lng conditions', () => {
    const filters = parseFilters(mockQuery({}))
    const { conditions } = buildFilterQuery(filters, false)

    expect(conditions.some((c) => c.includes('lat IS NOT NULL'))).toBe(false)
  })
})

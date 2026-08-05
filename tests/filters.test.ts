import { describe, it, expect } from 'vitest'
import { parseFilters, buildFilterQuery } from '../server/filters'

function mockQuery(params: Record<string, string>) {
  return {
    query: (key: string) => params[key],
  }
}

describe('parseFilters', () => {
  it('returns defaults with empty query params', () => {
    const result = parseFilters(mockQuery({}))
    expect(result.orgTypes).toEqual([])
    expect(result.excludeKonkurs).toBe(true)
    expect(result.excludeUnderAvvikling).toBe(true)
    expect(result.vatRegisteredOnly).toBe(false)
    expect(result.naeringskodeSections).toEqual([])
    expect(result.employeeBands).toEqual([])
    expect(result.entityKinds).toEqual(['enhet'])
    expect(result.bbox).toBeUndefined()
  })

  it('handles bbox correctly', () => {
    const result = parseFilters(mockQuery({ bbox: '5.0,60.0,6.0,61.0' }))
    expect(result.bbox).toEqual([5.0, 60.0, 6.0, 61.0])
  })

  it('handles malformed bbox gracefully', () => {
    const result = parseFilters(mockQuery({ bbox: 'invalid,bbox,values' }))
    expect(result.bbox).toBeUndefined()
  })

  it('handles employee bands', () => {
    const result = parseFilters(mockQuery({ employeeBands: '0,1-4,20+' }))
    expect(result.employeeBands).toEqual(['0', '1-4', '20+'])
  })
})

describe('buildFilterQuery', () => {
  const baseFilters = {
    orgTypes: [] as string[],
    excludeKonkurs: false,
    excludeUnderAvvikling: false,
    vatRegisteredOnly: false,
    naeringskodeSections: [] as string[],
    employeeBands: [] as string[],
    entityKinds: [] as string[],
    konsernMode: false,
    konsernMembersOnly: false,
  }

  it('generates correct SQL for no filters (just defaults)', () => {
    const { conditions, params } = buildFilterQuery(baseFilters)
    expect(conditions).toContain('deleted = 0')
    expect(params).toEqual([])
  })

  it('generates correct conditions for excludeKonkurs', () => {
    const { conditions } = buildFilterQuery({ ...baseFilters, excludeKonkurs: true })
    expect(conditions).toContain('konkurs = 0')
  })

  it('generates correct conditions for naeringskode sections', () => {
    const { conditions, params } = buildFilterQuery({
      ...baseFilters,
      naeringskodeSections: ['62', '63'],
    })
    expect(conditions.some((c) => c.includes('naeringskode_section IN'))).toBe(true)
    expect(params).toContain('62')
    expect(params).toContain('63')
  })

  it('generates correct conditions for employee bands', () => {
    const { conditions, params } = buildFilterQuery({
      ...baseFilters,
      employeeBands: ['0', '1-4'],
    })
    expect(conditions.some((c) => c.includes('employee_band IN'))).toBe(true)
    expect(params).toContain('0')
    expect(params).toContain('1-4')
  })

  it('generates correct conditions for entity kinds', () => {
    const { conditions, params } = buildFilterQuery({
      ...baseFilters,
      entityKinds: ['enhet', 'underenhet'],
    })
    expect(conditions.some((c) => c.includes('entity_kind IN'))).toBe(true)
    expect(params).toContain('enhet')
    expect(params).toContain('underenhet')
  })

  it('populates params array correctly alongside conditions', () => {
    const { conditions, params } = buildFilterQuery({
      ...baseFilters,
      orgTypes: ['AS', 'ENK'],
      naeringskodeSections: ['62'],
      employeeBands: ['20+'],
      entityKinds: ['enhet'],
    })
    expect(conditions.length).toBeGreaterThan(1)
    expect(params).toEqual(['AS', 'ENK', '62', '20+', 'enhet'])
  })
})

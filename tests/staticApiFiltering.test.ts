import { describe, it, expect } from 'vitest'

/**
 * Tests the static API filtering logic that runs client-side when VITE_STATIC_API=true.
 * These tests verify the filter functions match the same semantics as the server.
 */

type EmployeeBand = '0' | '1-4' | '5-19' | '20+' | 'unknown'

interface MunicipalityBreakdownRow {
  kommunenummer: string
  org_type: string
  konkurs: number
  under_avvikling: number
  vat_registered: number
  naeringskode_section?: string | null
  employee_band?: string
  entity_kind?: string
  count: number
}

interface MapFilters {
  orgTypes: string[]
  excludeKonkurs: boolean
  excludeUnderAvvikling: boolean
  vatRegisteredOnly: boolean
  naeringskodeSections: string[]
  employeeBands: EmployeeBand[]
  entityKinds: Array<'enhet' | 'underenhet'>
  konsernMembersOnly: boolean
}

function sectionMatchesFilter(
  section: string | null | undefined,
  selected: string[],
): boolean {
  if (selected.length === 0) return true
  if (!section) return false
  return selected.includes(section)
}

function bandMatchesFilter(band: EmployeeBand, selected: EmployeeBand[]): boolean {
  if (selected.length === 0) return true
  return selected.includes(band)
}

function breakdownRowMatchesFilters(
  row: MunicipalityBreakdownRow,
  filters: MapFilters,
): boolean {
  if (filters.orgTypes.length > 0 && !filters.orgTypes.includes(row.org_type)) return false
  if (filters.excludeKonkurs && row.konkurs !== 0) return false
  if (filters.excludeUnderAvvikling && row.under_avvikling !== 0) return false
  if (filters.vatRegisteredOnly && row.vat_registered !== 1) return false
  if (!sectionMatchesFilter(row.naeringskode_section ?? null, filters.naeringskodeSections)) {
    return false
  }
  if (
    !bandMatchesFilter(
      (row.employee_band ?? 'unknown') as EmployeeBand,
      filters.employeeBands,
    )
  ) {
    return false
  }
  if (
    filters.entityKinds.length > 0 &&
    row.entity_kind &&
    !filters.entityKinds.includes(row.entity_kind as 'enhet' | 'underenhet')
  ) {
    return false
  }
  return true
}

const defaultFilters: MapFilters = {
  orgTypes: [],
  excludeKonkurs: true,
  excludeUnderAvvikling: true,
  vatRegisteredOnly: false,
  naeringskodeSections: [],
  employeeBands: [],
  entityKinds: [],
  konsernMembersOnly: false,
}

const sampleRows: MunicipalityBreakdownRow[] = [
  { kommunenummer: '0301', org_type: 'AS', konkurs: 0, under_avvikling: 0, vat_registered: 1, naeringskode_section: '62', employee_band: '5-19', entity_kind: 'enhet', count: 100 },
  { kommunenummer: '0301', org_type: 'ENK', konkurs: 0, under_avvikling: 0, vat_registered: 0, naeringskode_section: '47', employee_band: '0', entity_kind: 'enhet', count: 50 },
  { kommunenummer: '0301', org_type: 'AS', konkurs: 1, under_avvikling: 0, vat_registered: 1, naeringskode_section: '62', employee_band: '1-4', entity_kind: 'enhet', count: 10 },
  { kommunenummer: '1101', org_type: 'AS', konkurs: 0, under_avvikling: 1, vat_registered: 1, naeringskode_section: '43', employee_band: '20+', entity_kind: 'enhet', count: 20 },
  { kommunenummer: '1101', org_type: 'NUF', konkurs: 0, under_avvikling: 0, vat_registered: 1, naeringskode_section: '68', employee_band: 'unknown', entity_kind: 'underenhet', count: 5 },
]

describe('static API breakdown filtering', () => {
  it('default filters exclude konkurs and under_avvikling', () => {
    const matching = sampleRows.filter((row) => breakdownRowMatchesFilters(row, defaultFilters))
    expect(matching.map((r) => r.count)).toEqual([100, 50, 5])
  })

  it('orgTypes filter narrows to specific types', () => {
    const filters: MapFilters = { ...defaultFilters, orgTypes: ['AS'] }
    const matching = sampleRows.filter((row) => breakdownRowMatchesFilters(row, filters))
    expect(matching).toHaveLength(1)
    expect(matching[0].count).toBe(100)
  })

  it('vatRegisteredOnly excludes non-VAT orgs', () => {
    const filters: MapFilters = { ...defaultFilters, vatRegisteredOnly: true }
    const matching = sampleRows.filter((row) => breakdownRowMatchesFilters(row, filters))
    expect(matching.every((r) => r.vat_registered === 1)).toBe(true)
    expect(matching.map((r) => r.count)).toEqual([100, 5])
  })

  it('naeringskodeSections filter narrows correctly', () => {
    const filters: MapFilters = { ...defaultFilters, naeringskodeSections: ['62'] }
    const matching = sampleRows.filter((row) => breakdownRowMatchesFilters(row, filters))
    expect(matching).toHaveLength(1)
    expect(matching[0].count).toBe(100)
  })

  it('employeeBands filter narrows correctly', () => {
    const filters: MapFilters = { ...defaultFilters, employeeBands: ['5-19', '20+'] }
    const matching = sampleRows.filter((row) => breakdownRowMatchesFilters(row, filters))
    expect(matching).toHaveLength(1)
    expect(matching[0].count).toBe(100)
  })

  it('entityKinds filter narrows to underenhet', () => {
    const filters: MapFilters = { ...defaultFilters, entityKinds: ['underenhet'] }
    const matching = sampleRows.filter((row) => breakdownRowMatchesFilters(row, filters))
    expect(matching).toHaveLength(1)
    expect(matching[0].entity_kind).toBe('underenhet')
  })

  it('including konkurs shows konkurs rows', () => {
    const filters: MapFilters = { ...defaultFilters, excludeKonkurs: false }
    const matching = sampleRows.filter((row) => breakdownRowMatchesFilters(row, filters))
    expect(matching.map((r) => r.count).sort((a, b) => a - b)).toEqual([5, 10, 50, 100])
  })

  it('combined filters work correctly', () => {
    const filters: MapFilters = {
      ...defaultFilters,
      orgTypes: ['AS', 'NUF'],
      excludeKonkurs: false,
      excludeUnderAvvikling: false,
      vatRegisteredOnly: true,
      naeringskodeSections: ['62', '43', '68'],
      employeeBands: [],
      entityKinds: [],
    }
    const matching = sampleRows.filter((row) => breakdownRowMatchesFilters(row, filters))
    expect(matching.map((r) => r.count).sort((a, b) => a - b)).toEqual([5, 10, 20, 100])
  })
})

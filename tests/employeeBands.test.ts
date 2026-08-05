import { describe, it, expect } from 'vitest'
import { employeeBand, bandMatchesFilter } from '../shared/employeeBands'

describe('employeeBand', () => {
  it('returns unknown when antallAnsatte is null', () => {
    expect(employeeBand(null, true)).toBe('unknown')
  })

  it('returns unknown when harRegistrert is false', () => {
    expect(employeeBand(5, false)).toBe('unknown')
  })

  it('returns 0 when antallAnsatte is 0 and harRegistrert is true', () => {
    expect(employeeBand(0, true)).toBe('0')
  })

  it('returns 1-4 for values 1-4', () => {
    expect(employeeBand(1, true)).toBe('1-4')
    expect(employeeBand(4, true)).toBe('1-4')
  })

  it('returns 5-19 for values 5-19', () => {
    expect(employeeBand(5, true)).toBe('5-19')
    expect(employeeBand(19, true)).toBe('5-19')
  })

  it('returns 20+ for values >= 20', () => {
    expect(employeeBand(20, true)).toBe('20+')
    expect(employeeBand(100, true)).toBe('20+')
  })
})

describe('bandMatchesFilter', () => {
  it('returns true when filter is empty', () => {
    expect(bandMatchesFilter('5-19', [])).toBe(true)
  })

  it('returns true when band is in filter', () => {
    expect(bandMatchesFilter('5-19', ['1-4', '5-19'])).toBe(true)
  })

  it('returns false when band is not in filter', () => {
    expect(bandMatchesFilter('20+', ['0', '1-4'])).toBe(false)
  })
})

describe('employeeBand SQL/TS consistency', () => {
  /**
   * Mirrors the SQL CASE from scripts/lib/db.ts:
   *   WHEN har_registrert_antall_ansatte = 0 OR antall_ansatte IS NULL THEN 'unknown'
   *   WHEN antall_ansatte = 0 THEN '0'
   *   WHEN antall_ansatte <= 4 THEN '1-4'
   *   WHEN antall_ansatte <= 19 THEN '5-19'
   *   ELSE '20+'
   */
  function sqlBand(antallAnsatte: number | null, harRegistrert: number): string {
    if (harRegistrert === 0 || antallAnsatte === null) return 'unknown'
    if (antallAnsatte === 0) return '0'
    if (antallAnsatte <= 4) return '1-4'
    if (antallAnsatte <= 19) return '5-19'
    return '20+'
  }

  const testCases: Array<[number | null, boolean]> = [
    [null, true],
    [null, false],
    [0, true],
    [0, false],
    [1, true],
    [4, true],
    [5, true],
    [19, true],
    [20, true],
    [100, true],
    [1000, true],
    [1, false],
    [20, false],
  ]

  it.each(testCases)(
    'TS matches SQL for antallAnsatte=%s harRegistrert=%s',
    (antallAnsatte, harRegistrert) => {
      const tsResult = employeeBand(antallAnsatte, harRegistrert)
      const sqlResult = sqlBand(antallAnsatte, harRegistrert ? 1 : 0)
      expect(tsResult).toBe(sqlResult)
    },
  )
})

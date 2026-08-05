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

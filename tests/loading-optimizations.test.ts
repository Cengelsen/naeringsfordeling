import { describe, it, expect } from 'vitest'
import { snapBboxToTileGrid } from '../shared/tiles'
import { dotsCacheKey } from '../src/lib/map/dotsCache'
import { filterFingerprint } from '../server/addressSpatialCore'
import { weakEtag } from '../server/httpCache'
import type { ApiFilters } from '../server/filters'

describe('snapBboxToTileGrid', () => {
  it('is idempotent at a given zoom', () => {
    const bbox: [number, number, number, number] = [5.31, 60.38, 5.35, 60.41]
    const snapped = snapBboxToTileGrid(bbox, 15)
    expect(snapBboxToTileGrid(snapped, 15)).toEqual(snapped)
  })

  it('covers the original viewport', () => {
    const bbox: [number, number, number, number] = [5.31, 60.38, 5.35, 60.41]
    const [minLng, minLat, maxLng, maxLat] = snapBboxToTileGrid(bbox, 15)
    expect(minLng).toBeLessThanOrEqual(bbox[0])
    expect(minLat).toBeLessThanOrEqual(bbox[1])
    expect(maxLng).toBeGreaterThanOrEqual(bbox[2])
    expect(maxLat).toBeGreaterThanOrEqual(bbox[3])
  })
})

describe('dotsCacheKey', () => {
  it('uses the same key for slightly different bboxes in the same tile', () => {
    const filters = 'true|true|false||||'
    const snapped = snapBboxToTileGrid([5.322, 60.392, 5.323, 60.393], 15)
    const [minLng, minLat, maxLng, maxLat] = snapped
    const a = dotsCacheKey({
      bbox: [minLng + 0.0001, minLat + 0.0001, maxLng - 0.0001, maxLat - 0.0001],
      kommunenumre: ['4601'],
      filters,
      zoom: 15,
      clustering: false,
    })
    const b = dotsCacheKey({
      bbox: [minLng + 0.0002, minLat + 0.0002, maxLng - 0.0002, maxLat - 0.0002],
      kommunenumre: ['4601'],
      filters,
      zoom: 15,
      clustering: false,
    })
    expect(a).toBe(b)
  })
})

describe('filterFingerprint', () => {
  it('is stable for identical filters regardless of array order', () => {
    const base: ApiFilters = {
      orgTypes: ['ENK', 'AS'],
      excludeKonkurs: true,
      excludeUnderAvvikling: true,
      vatRegisteredOnly: false,
      naeringskodeSections: ['62', '43'],
      employeeBands: [],
      entityKinds: ['enhet'],
      konsernMode: false,
      konsernMembersOnly: false,
    }
    const flipped: ApiFilters = {
      ...base,
      orgTypes: ['AS', 'ENK'],
      naeringskodeSections: ['43', '62'],
    }
    expect(filterFingerprint(base)).toBe(filterFingerprint(flipped))
  })
})

describe('weakEtag', () => {
  it('is stable for the same parts', () => {
    expect(weakEtag('a', 'b')).toBe(weakEtag('a', 'b'))
    expect(weakEtag('a', 'b')).not.toBe(weakEtag('a', 'c'))
    expect(weakEtag('x')).toMatch(/^W\/"[0-9a-f]{16}"$/)
  })
})

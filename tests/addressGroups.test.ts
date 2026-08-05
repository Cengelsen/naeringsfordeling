import { describe, it, expect } from 'vitest'
import { locationKey, addressGroupKey } from '../shared/address-groups'
import { groupOrganizationPointsByAddress } from '../server/addressGroups'
import type { OrganizationPointLike } from '../server/addressGroups'

describe('locationKey', () => {
  it('returns consistent keys for same coordinates', () => {
    const key1 = locationKey(60.12345, 5.67890)
    const key2 = locationKey(60.12345, 5.67890)
    expect(key1).toBe(key2)
  })

  it('produces different keys for different coordinates', () => {
    const key1 = locationKey(60.0, 5.0)
    const key2 = locationKey(61.0, 6.0)
    expect(key1).not.toBe(key2)
  })
})

describe('addressGroupKey', () => {
  it('uses adresse_id when available', () => {
    const key = addressGroupKey(60.0, 5.0, 'addr-123')
    expect(key).toBe('id:addr-123')
  })

  it('falls back to lat/lng when no adresse_id', () => {
    const key = addressGroupKey(60.12345, 5.67890, null)
    expect(key.startsWith('ll:')).toBe(true)
    expect(key).toContain('60.12345')
    expect(key).toContain('5.67890')
  })

  it('falls back to lat/lng when adresse_id is undefined', () => {
    const key = addressGroupKey(60.12345, 5.67890, undefined)
    expect(key.startsWith('ll:')).toBe(true)
  })
})

describe('groupOrganizationPointsByAddress', () => {
  function makeRow(overrides: Partial<OrganizationPointLike> = {}): OrganizationPointLike {
    return {
      orgnr: '123456789',
      org_type: 'AS',
      org_type_label: 'Aksjeselskap',
      navn: 'Test AS',
      address_text: 'Testveien 1',
      postnummer: '5000',
      kommunenummer: '4601',
      lat: 60.39,
      lng: 5.32,
      naeringskode: '62.01',
      employee_band: '5-19',
      entity_kind: 'enhet',
      adresse_id: null,
      ...overrides,
    }
  }

  it('groups by same address correctly', () => {
    const rows = [
      makeRow({ orgnr: '100', adresse_id: 'addr-1' }),
      makeRow({ orgnr: '200', adresse_id: 'addr-1' }),
      makeRow({ orgnr: '300', adresse_id: 'addr-2' }),
    ]
    const groups = groupOrganizationPointsByAddress(rows)
    expect(groups).toHaveLength(2)

    const group1 = groups.find((g) => g.orgnrs.includes('100'))!
    expect(group1.orgCount).toBe(2)
    expect(group1.orgnrs).toContain('200')

    const group2 = groups.find((g) => g.orgnrs.includes('300'))!
    expect(group2.orgCount).toBe(1)
  })

  it('groups by lat/lng when no adresse_id', () => {
    const rows = [
      makeRow({ orgnr: '100', lat: 60.0, lng: 5.0, adresse_id: null }),
      makeRow({ orgnr: '200', lat: 60.0, lng: 5.0, adresse_id: null }),
    ]
    const groups = groupOrganizationPointsByAddress(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0].orgCount).toBe(2)
  })

  it('sets orgType to MIXED when multiple types at same address', () => {
    const rows = [
      makeRow({ orgnr: '100', org_type: 'AS', adresse_id: 'addr-1' }),
      makeRow({ orgnr: '200', org_type: 'ENK', adresse_id: 'addr-1' }),
    ]
    const groups = groupOrganizationPointsByAddress(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0].orgType).toBe('MIXED')
  })
})

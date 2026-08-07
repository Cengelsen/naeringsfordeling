import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { normalizeAddressText } from '../scripts/lib/kartverket-bulk.js'
import {
  parseStreetAddress,
  splitHouseNumber,
  normalizeStreetName,
} from '../scripts/lib/geocode.js'
import { ensureKartverketSchema } from '../scripts/lib/kartverket-bulk.js'
import { lookupKartverketAddress } from '../scripts/lib/local-geocode.js'

describe('normalizeAddressText', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeAddressText('Storgata  12')).toBe('storgata 12')
  })

  it('strips punctuation and normalizes postboks', () => {
    expect(normalizeAddressText('Pb. 123')).toBe('postboks 123')
  })

  it('strips diacritics', () => {
    expect(normalizeAddressText('Karenslyst Allé 12')).toBe('karenslyst alle 12')
    expect(normalizeStreetName('Karenslyst Allé')).toBe('karenslyst alle')
  })
})

describe('parseStreetAddress', () => {
  it('parses slash house number ranges', () => {
    expect(parseStreetAddress('Nedre Torggate 5/7')).toEqual({
      adressenavn: 'Nedre Torggate',
      nummer: '5/7',
      bokstav: '',
      range: [5, 6, 7],
    })
  })

  it('parses house number ranges', () => {
    expect(parseStreetAddress('Cecilie Thoresens vei 5-7')).toEqual({
      adressenavn: 'Cecilie Thoresens vei',
      nummer: '5-7',
      bokstav: '',
      range: [5, 6, 7],
    })
  })

  it('splits house number and letter', () => {
    expect(parseStreetAddress('Storgata 12A')).toEqual({
      adressenavn: 'Storgata',
      nummer: '12',
      bokstav: 'A',
    })
  })

  it('parses spaced house letter', () => {
    expect(splitHouseNumber('12 A')).toEqual({ nummer: '12', bokstav: 'A' })
  })
})

describe('lookupKartverketAddress', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    ensureKartverketSchema(db)
    db.prepare(
      `INSERT INTO kartverket_addresses (
         adresse_id, postnummer, adressenavn, nummer, bokstav,
         adresse_tekst, adresse_tekst_norm, lat, lng,
         kommunenummer, matrikkel_key, lookup_key, adressetype
       ) VALUES (
         '1', '5003', 'Storgata', '12', 'A',
         'Storgata 12A', 'storgata 12a', 60.39, 5.32,
         '4601', NULL, '5003|storgata|12A', 'vegadresse'
       )`,
    ).run()
    db.prepare(
      `INSERT INTO kartverket_addresses (
         adresse_id, postnummer, adressenavn, nummer, bokstav,
         adresse_tekst, adresse_tekst_norm, lat, lng,
         kommunenummer, matrikkel_key, lookup_key, adressetype
       ) VALUES (
         '2', '5003', 'Storgata', '14', '',
         'Storgata 14', 'storgata 14', 60.391, 5.321,
         '4601', NULL, '5003|storgata|14', 'vegadresse'
       )`,
    ).run()
  })

  afterEach(() => {
    db.close()
  })

  it('matches structured lookup with letter', () => {
    const result = lookupKartverketAddress(db, {
      address_text: 'Storgata 12A',
      postnummer: '5003',
      kommunenummer: '4601',
    })

    expect(result).toMatchObject({
      lat: 60.39,
      lng: 5.32,
      method: 'structured',
      quality: 'verified',
    })
  })

  it('matches free text with punctuation stripped', () => {
    const result = lookupKartverketAddress(db, {
      address_text: 'Storgata 14,',
      postnummer: '5003',
      kommunenummer: '4601',
    })

    expect(result).toMatchObject({
      lat: 60.391,
      method: 'freeText',
    })
  })

  it('matches street components when only number is given', () => {
    const result = lookupKartverketAddress(db, {
      address_text: 'Storgata 14',
      postnummer: '5003',
      kommunenummer: '4601',
    })

    expect(result).toMatchObject({
      lat: 60.391,
      method: 'structured',
    })
  })

  it('falls back to first letter suffix when plain number is missing', () => {
    const result = lookupKartverketAddress(db, {
      address_text: 'Storgata 12',
      postnummer: '5003',
      kommunenummer: '4601',
    })

    expect(result).toMatchObject({
      lat: 60.39,
      method: 'structured',
    })
  })
})

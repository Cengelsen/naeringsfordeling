import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from '../scripts/lib/db.js'
import { nullOrphanOverordnetEnhet, upsertEntity } from '../scripts/lib/organizations.js'
import type { BrregEntity } from '../scripts/lib/types.js'

function makeEntity(orgnr: string, parent?: string): BrregEntity {
  return {
    organisasjonsnummer: orgnr,
    navn: `Org ${orgnr}`,
    organisasjonsform: { kode: 'AS', beskrivelse: 'Aksjeselskap' },
    forretningsadresse: {
      adresse: ['Storgata 1'],
      postnummer: '5003',
      kommunenummer: '4601',
      landkode: 'NO',
    },
    overordnetEnhet: parent,
  }
}

describe('overordnet_enhet foreign keys', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('defers parent links during bulk import and clears orphans on commit', () => {
    db.exec('BEGIN DEFERRED')
    upsertEntity(db, makeEntity('111111111', '999999999'), false, { deferParentLink: true })
    upsertEntity(db, makeEntity('999999999'), false, { deferParentLink: true })
    const cleared = nullOrphanOverordnetEnhet(db)
    db.exec('COMMIT')

    expect(cleared).toBe(0)
    expect(
      db.prepare('SELECT overordnet_enhet FROM organizations WHERE orgnr = ?').get('111111111'),
    ).toEqual({ overordnet_enhet: '999999999' })
  })

  it('nulls parent links that never resolve', () => {
    db.exec('BEGIN DEFERRED')
    upsertEntity(db, makeEntity('111111111', '999999999'), false, { deferParentLink: true })
    expect(nullOrphanOverordnetEnhet(db)).toBe(1)
    db.exec('COMMIT')

    expect(
      db.prepare('SELECT overordnet_enhet FROM organizations WHERE orgnr = ?').get('111111111'),
    ).toEqual({ overordnet_enhet: null })
  })

  it('drops missing parents on incremental upsert', () => {
    upsertEntity(db, makeEntity('111111111', '999999999'))

    expect(
      db.prepare('SELECT overordnet_enhet FROM organizations WHERE orgnr = ?').get('111111111'),
    ).toEqual({ overordnet_enhet: null })
  })
})

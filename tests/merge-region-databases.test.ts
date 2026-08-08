import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase } from '../scripts/lib/db.js'
import { upsertEntity } from '../scripts/lib/organizations.js'
import type { BrregEntity } from '../scripts/lib/types.js'
import { mergeRegionDatabases } from '../scripts/lib/merge-region-databases.js'

function makeEntity(orgnr: string, kommune: string): BrregEntity {
  return {
    organisasjonsnummer: orgnr,
    navn: `Org ${orgnr}`,
    organisasjonsform: { kode: 'AS', beskrivelse: 'Aksjeselskap' },
    forretningsadresse: {
      adresse: ['Storgata 1'],
      postnummer: '5003',
      kommunenummer: kommune,
      landkode: 'NO',
    },
  }
}

function writeRegionDb(path: string, entities: BrregEntity[]) {
  const db = openDatabase(path, { runBackfill: true })
  for (const entity of entities) {
    upsertEntity(db, entity)
  }
  db.close()
}

describe('mergeRegionDatabases', () => {
  let workDir: string

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  it('merges organizations from multiple region databases', () => {
    workDir = mkdtempSync(join(tmpdir(), 'merge-region-db-'))
    const sourceA = join(workDir, '03-oslo.db')
    const sourceB = join(workDir, '11-rogaland.db')
    const target = join(workDir, 'national.db')

    writeRegionDb(sourceA, [makeEntity('111111111', '0301')])
    writeRegionDb(sourceB, [makeEntity('222222222', '1103')])

    const summary = mergeRegionDatabases(target, [sourceA, sourceB], { clearTarget: true })
    expect(summary.sources.length).toBe(2)

    const db = openDatabase(target)
    const count = (db.prepare('SELECT COUNT(*) AS count FROM organizations').get() as { count: number }).count
    db.close()

    expect(count).toBe(2)
  })
})

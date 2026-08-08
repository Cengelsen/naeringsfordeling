import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase } from '../scripts/lib/db.js'
import { computeBrregContentHash, loadBrregHashIndex } from '../scripts/lib/organizations.js'
import { importBrregFromGzip } from '../scripts/lib/brreg-import-pipeline.js'
import type { BrregEntity } from '../scripts/lib/types.js'

function makeEntity(orgnr: string, overrides: Partial<BrregEntity> = {}): BrregEntity {
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
    ...overrides,
  }
}

function writeGzipJsonArray(path: string, items: unknown[]) {
  const json = `[${items.map((item) => JSON.stringify(item)).join(',')}]`
  writeFileSync(path, gzipSync(json))
}

describe('importBrregFromGzip', () => {
  let db: Database.Database
  let cacheDir: string
  let gzipPath: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    cacheDir = mkdtempSync(join(tmpdir(), 'brreg-import-pipeline-'))
    gzipPath = join(cacheDir, 'enheter.v2.json.gz')
  })

  afterEach(() => {
    db.close()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('imports all entities without hash index', async () => {
    writeGzipJsonArray(gzipPath, [makeEntity('111111111'), makeEntity('222222222')])

    const result = await importBrregFromGzip(db, gzipPath, {
      entityKind: 'enhet',
      prepareWorkers: 0,
      batchSize: 1,
    })

    expect(result).toMatchObject({ scanned: 2, written: 2, skipped: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 2 })
  })

  it('respects kommune filter', async () => {
    writeGzipJsonArray(gzipPath, [
      makeEntity('111111111'),
      makeEntity('222222222', {
        forretningsadresse: {
          adresse: ['Annen gate 2'],
          postnummer: '0001',
          kommunenummer: '0301',
          landkode: 'NO',
        },
      }),
    ])

    const result = await importBrregFromGzip(db, gzipPath, {
      entityKind: 'enhet',
      prepareWorkers: 0,
      filter: (entity) => entity.forretningsadresse?.kommunenummer === '4601',
    })

    expect(result.scanned).toBe(1)
    expect(result.written).toBe(1)
    expect(db.prepare('SELECT orgnr FROM organizations').all()).toEqual([{ orgnr: '111111111' }])
  })

  it('skips unchanged rows in diff mode', async () => {
    const entity = makeEntity('111111111')
    writeGzipJsonArray(gzipPath, [entity])

    const first = await importBrregFromGzip(db, gzipPath, {
      entityKind: 'enhet',
      prepareWorkers: 0,
    })
    expect(first).toMatchObject({ scanned: 1, written: 1, skipped: 0 })

    const hashIndex = loadBrregHashIndex(db)
    const second = await importBrregFromGzip(db, gzipPath, {
      entityKind: 'enhet',
      prepareWorkers: 0,
      hashIndex,
    })

    expect(second).toMatchObject({ scanned: 1, written: 0, skipped: 1 })
    expect(computeBrregContentHash(entity)).toBe(hashIndex.get('111111111'))
  })

  it('produces identical rows with workers enabled', async () => {
    writeGzipJsonArray(gzipPath, [makeEntity('111111111'), makeEntity('222222222')])

    const mainDb = openDatabase(':memory:')
    const workerDb = openDatabase(':memory:')

    try {
      const mainResult = await importBrregFromGzip(mainDb, gzipPath, {
        entityKind: 'enhet',
        prepareWorkers: 0,
      })
      const workerResult = await importBrregFromGzip(workerDb, gzipPath, {
        entityKind: 'enhet',
        prepareWorkers: 2,
        batchSize: 1,
      })

      expect(mainResult).toEqual(workerResult)
      const mainRows = mainDb.prepare('SELECT * FROM organizations ORDER BY orgnr').all() as Array<
        Record<string, unknown>
      >
      const workerRows = workerDb.prepare('SELECT * FROM organizations ORDER BY orgnr').all() as Array<
        Record<string, unknown>
      >
      expect(mainRows.map((row) => ({ ...row, updated_at: 'fixed' }))).toEqual(
        workerRows.map((row) => ({ ...row, updated_at: 'fixed' })),
      )
    } finally {
      mainDb.close()
      workerDb.close()
    }
  })
})

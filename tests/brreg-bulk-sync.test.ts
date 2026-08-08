import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { gzipSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase, setSyncState } from '../scripts/lib/db.js'
import {
  computeBrregContentHash,
  upsertEntity,
} from '../scripts/lib/organizations.js'
import { sha256File } from '../scripts/lib/reference-cache.js'
import { syncBrregFromBulkCache } from '../scripts/lib/brreg-bulk-sync.js'
import type { BrregEntity } from '../scripts/lib/types.js'

function makeEntity(overrides: Partial<BrregEntity> = {}): BrregEntity {
  return {
    organisasjonsnummer: '123456789',
    navn: 'Test AS',
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

function seedReferenceCache(cacheDir: string) {
  mkdirSync(join(cacheDir, 'brreg'), { recursive: true })
  writeFileSync(join(cacheDir, 'brreg/kommuner.json'), '[]\n')
  writeFileSync(join(cacheDir, 'manifest.json'), '{}\n')
}

describe('computeBrregContentHash', () => {
  it('is stable for the same entity payload', () => {
    const entity = makeEntity()
    expect(computeBrregContentHash(entity)).toBe(computeBrregContentHash(entity))
  })

  it('changes when address changes', () => {
    const before = makeEntity()
    const after = makeEntity({
      forretningsadresse: {
        adresse: ['Ny gate 2'],
        postnummer: '5004',
        kommunenummer: '4601',
        landkode: 'NO',
      },
    })
    expect(computeBrregContentHash(before)).not.toBe(computeBrregContentHash(after))
  })
})

describe('syncBrregFromBulkCache', () => {
  let db: Database.Database
  let cacheDir: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    cacheDir = mkdtempSync(join(tmpdir(), 'brreg-bulk-sync-'))
    seedReferenceCache(cacheDir)
  })

  afterEach(() => {
    db.close()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('skips import when bulk file hash is unchanged', async () => {
    const gzipPath = join(cacheDir, 'brreg/enheter.v2.json.gz')
    await writeGzipJsonArray(gzipPath, [makeEntity()])
    const fileHash = sha256File(gzipPath)
    setSyncState(db, 'brreg_enheter_file_hash', fileHash)

    const result = await syncBrregFromBulkCache(db, {
      referenceCacheDir: cacheDir,
      skipUnderenheter: true,
      localOnly: true,
    })

    expect(result.skipped).toBe(true)
    expect(result.enheterChanged).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 0 })
  })

  it('upserts only changed entities and preserves coordinates when unchanged', async () => {
    const entity = makeEntity()
    upsertEntity(db, entity)
    db.prepare('UPDATE organizations SET lat = 60.39, lng = 5.32 WHERE orgnr = ?').run(entity.organisasjonsnummer)

    const gzipPath = join(cacheDir, 'brreg/enheter.v2.json.gz')
    writeGzipJsonArray(gzipPath, [entity])
    setSyncState(db, 'brreg_enheter_file_hash', 'stale-hash')

    const unchanged = await syncBrregFromBulkCache(db, {
      referenceCacheDir: cacheDir,
      skipUnderenheter: true,
      localOnly: true,
    })
    expect(unchanged.enheterChanged).toBe(0)
    expect(
      db.prepare('SELECT lat, lng FROM organizations WHERE orgnr = ?').get(entity.organisasjonsnummer),
    ).toEqual({ lat: 60.39, lng: 5.32 })

    const changedEntity = makeEntity({
      forretningsadresse: {
        adresse: ['Ny gate 9'],
        postnummer: '5004',
        kommunenummer: '4601',
        landkode: 'NO',
      },
    })
    writeGzipJsonArray(gzipPath, [changedEntity])

    const changed = await syncBrregFromBulkCache(db, {
      referenceCacheDir: cacheDir,
      skipUnderenheter: true,
      localOnly: true,
    })
    expect(changed.enheterChanged).toBe(1)
    expect(
      db.prepare('SELECT lat, lng, brreg_content_hash FROM organizations WHERE orgnr = ?').get(
        entity.organisasjonsnummer,
      ),
    ).toMatchObject({ lat: null, lng: null })
  })
})

import type Database from 'better-sqlite3'
import { streamBrregGzipArray } from './reference-cache.js'
import { BrregBatchWriter } from './brreg-batch-writer.js'
import {
  BRREG_IMPORT_BATCH_SIZE,
  BRREG_IMPORT_PREPARE_CHUNK,
  BRREG_IMPORT_WORKERS,
} from './brreg-import-config.js'
import {
  computeBrregContentHash,
  prepareEntityRecord,
  prepareUnderenhetRecord,
  type OrganizationUpsertRecord,
} from './organizations.js'
import { BrregRecordWorkerPool } from './brreg-record-worker-pool.js'
import type { BrregEntity, BrregUnderenhet } from './types.js'

type BrregEntityUnion = BrregEntity | BrregUnderenhet

export interface BrregImportOptions {
  entityKind: 'enhet' | 'underenhet'
  filter?: (entity: BrregEntityUnion) => boolean
  hashIndex?: Map<string, string | null>
  deferParentLink?: boolean
  batchSize?: number
  prepareWorkers?: number
  /** Filtered entities processed (every 10k). */
  onProgress?: (scanned: number) => void
  /** Suppress stream progress logging. */
  quiet?: boolean
  /** Raw gzip rows read (every 10k, before filter). */
  onRowsRead?: (rowsRead: number) => void
}

export interface BrregImportResult {
  scanned: number
  written: number
  skipped: number
}

interface PendingEntity {
  entity: BrregEntityUnion
  deleted: boolean
}

function entityLabel(entityKind: BrregImportOptions['entityKind']): string {
  return entityKind === 'enhet' ? 'enheter' : 'underenheter'
}

function prepareOnMain(
  entityKind: BrregImportOptions['entityKind'],
  entity: BrregEntityUnion,
  deleted: boolean,
  updatedAt: string,
): OrganizationUpsertRecord {
  if (entityKind === 'underenhet') {
    return prepareUnderenhetRecord(entity as BrregUnderenhet, deleted, updatedAt)
  }
  return prepareEntityRecord(entity as BrregEntity, deleted, updatedAt)
}

async function flushPrepareBatch(
  entityKind: BrregImportOptions['entityKind'],
  batch: PendingEntity[],
  updatedAt: string,
  workerPool: BrregRecordWorkerPool | null,
): Promise<OrganizationUpsertRecord[]> {
  if (batch.length === 0) return []

  if (workerPool) {
    return workerPool.prepare(
      entityKind,
      batch.map((item) => item.entity),
      updatedAt,
      batch.map((item) => item.deleted),
    )
  }

  return batch.map((item) => prepareOnMain(entityKind, item.entity, item.deleted, updatedAt))
}

export async function importBrregFromGzip(
  db: Database.Database,
  gzipPath: string,
  options: BrregImportOptions,
): Promise<BrregImportResult> {
  const entityKind = options.entityKind
  const label = `Importerer ${entityLabel(entityKind)} fra lokal BRREG-fil`
  const prepareWorkers = options.prepareWorkers ?? BRREG_IMPORT_WORKERS
  const maxInFlight = prepareWorkers > 0 ? prepareWorkers * 2 : 0
  const workerPool = prepareWorkers > 0 ? new BrregRecordWorkerPool(prepareWorkers) : null

  const batchWriter = new BrregBatchWriter(db, {
    batchSize: options.batchSize ?? BRREG_IMPORT_BATCH_SIZE,
    deferParentLink: options.deferParentLink ?? true,
  })

  let scanned = 0
  let skipped = 0
  const prepareBatch: PendingEntity[] = []
  const inFlight: Promise<OrganizationUpsertRecord[]>[] = []
  const importStartedAt = new Date().toISOString()

  const applyRecords = (records: OrganizationUpsertRecord[]) => {
    for (const record of records) {
      if (options.hashIndex) {
        if (options.hashIndex.get(record.orgnr) === record.brreg_content_hash) {
          skipped += 1
          continue
        }
        options.hashIndex.set(record.orgnr, record.brreg_content_hash)
      }
      batchWriter.push(record)
    }
  }

  const drainInFlight = async () => {
    if (inFlight.length === 0) return
    const results = await Promise.all(inFlight.splice(0, inFlight.length))
    for (const records of results) {
      applyRecords(records)
    }
  }

  const submitPrepareBatch = async (updatedAt: string) => {
    if (prepareBatch.length === 0) return

    const batch = prepareBatch.splice(0, prepareBatch.length)
    if (workerPool) {
      if (inFlight.length >= maxInFlight) {
        await drainInFlight()
      }
      inFlight.push(flushPrepareBatch(entityKind, batch, updatedAt, workerPool))
      return
    }

    applyRecords(await flushPrepareBatch(entityKind, batch, updatedAt, null))
  }

  try {
    await streamBrregGzipArray<BrregEntityUnion>(
      gzipPath,
      async (entity) => {
        if (options.filter && !options.filter(entity)) return

        scanned += 1
        if (options.onProgress && scanned % 10_000 === 0) {
          options.onProgress(scanned)
        }

        const deleted = Boolean(entity.slettedato)

        if (options.hashIndex) {
          const contentHash = computeBrregContentHash(entity)
          if (options.hashIndex.get(entity.organisasjonsnummer) === contentHash) {
            skipped += 1
            return
          }
        }

        prepareBatch.push({ entity, deleted })
        if (prepareBatch.length >= BRREG_IMPORT_PREPARE_CHUNK) {
          await submitPrepareBatch(importStartedAt)
        }
      },
      label,
      {
        quiet: options.quiet,
        onRowsRead: options.onRowsRead,
      },
    )

    await submitPrepareBatch(importStartedAt)
    await drainInFlight()
    batchWriter.flush()

    return {
      scanned,
      written: batchWriter.written,
      skipped,
    }
  } finally {
    await workerPool?.terminate()
  }
}

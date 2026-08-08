import type Database from 'better-sqlite3'
import {
  BRREG_IMPORT_BATCH_SIZE,
} from './brreg-import-config.js'
import {
  upsertManyOrganizations,
  type OrganizationUpsertRecord,
  type UpsertOrganizationOptions,
} from './organizations.js'

export interface BrregBatchWriterOptions extends UpsertOrganizationOptions {
  batchSize?: number
}

export class BrregBatchWriter {
  private readonly batch: OrganizationUpsertRecord[] = []
  private readonly batchSize: number
  private _written = 0

  constructor(
    private readonly db: Database.Database,
    options: BrregBatchWriterOptions = {},
  ) {
    this.batchSize = options.batchSize ?? BRREG_IMPORT_BATCH_SIZE
    this.deferParentLink = options.deferParentLink
  }

  private readonly deferParentLink?: boolean

  get written(): number {
    return this._written
  }

  push(record: OrganizationUpsertRecord): void {
    this.batch.push(record)
    if (this.batch.length >= this.batchSize) {
      this.flush()
    }
  }

  flush(): void {
    if (this.batch.length === 0) return
    const rows = this.batch.splice(0, this.batch.length)
    upsertManyOrganizations(this.db, rows, { deferParentLink: this.deferParentLink })
    this._written += rows.length
  }
}

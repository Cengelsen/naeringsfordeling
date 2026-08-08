import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { BrregEntity, BrregUnderenhet } from './types.js'
import type { OrganizationUpsertRecord } from './organizations.js'

const workerPath = fileURLToPath(new URL('./brreg-record-worker-bootstrap.mjs', import.meta.url))

interface PrepareTask {
  kind: 'enhet' | 'underenhet'
  entities: Array<BrregEntity | BrregUnderenhet>
  deletedFlags?: boolean[]
  updatedAt: string
  resolve: (records: OrganizationUpsertRecord[]) => void
  reject: (error: Error) => void
}

interface WorkerSlot {
  worker: Worker
  busy: boolean
}

export class BrregRecordWorkerPool {
  private readonly slots: WorkerSlot[] = []
  private readonly pending: PrepareTask[] = []
  private nextId = 0
  private readonly callbacks = new Map<
    number,
    { resolve: (records: OrganizationUpsertRecord[]) => void; reject: (error: Error) => void }
  >()

  constructor(private readonly size: number) {
    for (let index = 0; index < size; index += 1) {
      const worker = new Worker(workerPath)
      worker.on('message', (message: { type: string; id: number; records?: OrganizationUpsertRecord[]; message?: string }) => {
        if (message.type === 'prepared') {
          const callback = this.callbacks.get(message.id)
          this.callbacks.delete(message.id)
          callback?.resolve(message.records ?? [])
        } else if (message.type === 'error') {
          const callback = this.callbacks.get(message.id)
          this.callbacks.delete(message.id)
          callback?.reject(new Error(message.message ?? 'Worker prepare failed'))
        }
        this.releaseWorker(worker)
      })
      worker.on('error', (error) => {
        for (const [id, callback] of this.callbacks) {
          callback.reject(error)
          this.callbacks.delete(id)
        }
        this.pending.length = 0
      })
      this.slots.push({ worker, busy: false })
    }
  }

  get inFlight(): number {
    return this.callbacks.size
  }

  prepare(
    kind: 'enhet' | 'underenhet',
    entities: Array<BrregEntity | BrregUnderenhet>,
    updatedAt: string,
    deletedFlags?: boolean[],
  ): Promise<OrganizationUpsertRecord[]> {
    return new Promise((resolve, reject) => {
      this.pending.push({ kind, entities, deletedFlags, updatedAt, resolve, reject })
      this.dispatch()
    })
  }

  async terminate(): Promise<void> {
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()))
    this.slots.length = 0
    this.pending.length = 0
    this.callbacks.clear()
  }

  private dispatch(): void {
    while (this.pending.length > 0) {
      const slot = this.slots.find((entry) => !entry.busy)
      if (!slot) return

      const task = this.pending.shift()!
      const id = this.nextId
      this.nextId += 1
      slot.busy = true
      this.callbacks.set(id, { resolve: task.resolve, reject: task.reject })
      slot.worker.postMessage({
        type: 'prepare',
        id,
        kind: task.kind,
        entities: task.entities,
        deletedFlags: task.deletedFlags,
        updatedAt: task.updatedAt,
      })
    }
  }

  private releaseWorker(worker: Worker): void {
    const slot = this.slots.find((entry) => entry.worker === worker)
    if (slot) slot.busy = false
    this.dispatch()
  }
}

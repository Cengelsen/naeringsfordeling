import { parentPort } from 'node:worker_threads'
import {
  prepareEntityRecord,
  prepareUnderenhetRecord,
} from './organizations.js'
import type { BrregEntity, BrregUnderenhet } from './types.js'

interface PrepareMessage {
  type: 'prepare'
  id: number
  kind: 'enhet' | 'underenhet'
  entities: Array<BrregEntity | BrregUnderenhet>
  deletedFlags?: boolean[]
  updatedAt: string
}

parentPort?.on('message', (message: PrepareMessage) => {
  try {
    if (message.type !== 'prepare') return

    const records = message.entities.map((entity, index) => {
      const deleted =
        message.deletedFlags?.[index] ?? Boolean((entity as BrregEntity).slettedato)
      if (message.kind === 'underenhet') {
        return prepareUnderenhetRecord(entity as BrregUnderenhet, deleted, message.updatedAt)
      }
      return prepareEntityRecord(entity as BrregEntity, deleted, message.updatedAt)
    })

    parentPort?.postMessage({ type: 'prepared', id: message.id, records })
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

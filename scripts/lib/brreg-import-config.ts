import { availableParallelism } from 'node:os'

export const BRREG_IMPORT_BATCH_SIZE = Number(process.env.BRREG_IMPORT_BATCH_SIZE ?? 2000)
export const BRREG_IMPORT_PREPARE_CHUNK = Number(process.env.BRREG_IMPORT_PREPARE_CHUNK ?? 500)

const cpuCount = availableParallelism()
export const BRREG_IMPORT_WORKERS = Number(
  process.env.BRREG_IMPORT_WORKERS ?? Math.min(4, cpuCount),
)

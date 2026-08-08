import type { RegionBuildPhase } from './region-build.js'

export const REGION_PROGRESS_PREFIX = '@region-progress:'

export type RegionBuildIpcMessage =
  | {
      type: 'progress'
      phase: RegionBuildPhase
      progress?: number
      detail?: string
      displayPhase?: string
    }
  | {
      type: 'done'
      orgTotal: number
      outputPath: string
    }

export function emitRegionBuildProgress(message: RegionBuildIpcMessage): void {
  process.stdout.write(`${REGION_PROGRESS_PREFIX}${JSON.stringify(message)}\n`)
}

export function parseRegionBuildProgressLine(line: string): RegionBuildIpcMessage | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(REGION_PROGRESS_PREFIX)) return null
  try {
    return JSON.parse(trimmed.slice(REGION_PROGRESS_PREFIX.length)) as RegionBuildIpcMessage
  } catch {
    return null
  }
}

export function consumeRegionBuildProgressChunk(
  chunk: string,
  onMessage: (message: RegionBuildIpcMessage) => void,
): void {
  for (const line of chunk.split('\n')) {
    const message = parseRegionBuildProgressLine(line)
    if (message) onMessage(message)
  }
}

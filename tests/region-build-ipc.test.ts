import { describe, it, expect } from 'vitest'
import {
  REGION_PROGRESS_PREFIX,
  parseRegionBuildProgressLine,
  consumeRegionBuildProgressChunk,
} from '../scripts/lib/region-build-ipc.js'

describe('region-build-ipc', () => {
  it('parses progress lines from stdout chunks', () => {
    const messages: Array<{ type: string; phase?: string }> = []
    const payload = {
      type: 'progress',
      phase: 'brreg',
      progress: 0.5,
      detail: 'test',
      displayPhase: 'BRREG enheter (1/2)',
    }
    const line = `${REGION_PROGRESS_PREFIX}${JSON.stringify(payload)}`
    consumeRegionBuildProgressChunk(`${line}\n`, (message) => messages.push(message))
    expect(messages[0]?.type).toBe('progress')
    expect(parseRegionBuildProgressLine(line)?.displayPhase).toBe('BRREG enheter (1/2)')
  })

  it('ignores non-progress lines', () => {
    expect(parseRegionBuildProgressLine('random log line')).toBeNull()
  })
})

/** Conservative defaults aligned with BRREG/Kartverket fair-use guidance. */
export const LIMITS = {
  /** BRREG search/entity API: pause between paginated list requests. */
  brregPageDelayMs: Number(process.env.BRREG_PAGE_DELAY_MS ?? 250),
  /** BRREG single-entity lookups during incremental sync. */
  brregEntityDelayMs: Number(process.env.BRREG_ENTITY_DELAY_MS ?? 150),
  /** Kartverket adresse-API: max in-flight requests. */
  geocodeConcurrency: Number(process.env.SYNC_GEOCODE_CONCURRENCY ?? 3),
  /** Kartverket adresse-API: minimum gap between request starts. */
  geocodeDelayMs: Number(process.env.GEOCODE_DELAY_MS ?? 200),
  /** Unique addresses geocoded per batch before a short cool-down. */
  geocodeBatchSize: Number(process.env.SYNC_GEOCODE_LIMIT ?? 5000),
  /** Pause between geocoding batches. */
  geocodeBatchPauseMs: Number(process.env.GEOCODE_BATCH_PAUSE_MS ?? 2000),
  /** HTTP retries for 429/503. */
  maxRetries: Number(process.env.API_MAX_RETRIES ?? 5),
  /** Initial retry backoff. */
  retryBaseMs: Number(process.env.API_RETRY_BASE_MS ?? 1000),
} as const

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (!Number.isNaN(seconds)) return seconds * 1000
  }
  return LIMITS.retryBaseMs * 2 ** attempt
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  label = url,
): Promise<Response> {
  for (let attempt = 0; attempt <= LIMITS.maxRetries; attempt += 1) {
    const response = await fetch(url, init)

    if (response.ok || response.status === 404) {
      return response
    }

    if ((response.status === 429 || response.status >= 500) && attempt < LIMITS.maxRetries) {
      const wait = retryAfterMs(response, attempt)
      console.warn(
        `${label}: HTTP ${response.status}, venter ${Math.round(wait / 1000)}s (forsøk ${attempt + 1}/${LIMITS.maxRetries})`,
      )
      await sleep(wait)
      continue
    }

    return response
  }

  throw new Error(`${label}: ga opp etter ${LIMITS.maxRetries} forsøk`)
}

class RateGate {
  private lastStart = 0
  private inFlight = 0
  private queue: Array<() => void> = []

  constructor(
    private readonly concurrency: number,
    private readonly minGapMs: number,
  ) {}

  async acquire(): Promise<void> {
    if (this.inFlight >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }

    const now = Date.now()
    const wait = Math.max(0, this.minGapMs - (now - this.lastStart))
    if (wait > 0) await sleep(wait)

    this.lastStart = Date.now()
    this.inFlight += 1
  }

  release(): void {
    this.inFlight -= 1
    const next = this.queue.shift()
    if (next) next()
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

export const geocodeGate = new RateGate(LIMITS.geocodeConcurrency, LIMITS.geocodeDelayMs)

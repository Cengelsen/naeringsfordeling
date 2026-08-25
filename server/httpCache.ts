import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import type { Context } from 'hono'

let dataVersion = '0'

export function initHttpCache(dbPath: string) {
  try {
    dataVersion = String(Math.round(statSync(dbPath).mtimeMs))
  } catch {
    dataVersion = String(Date.now())
  }
}

export function getDataVersion(): string {
  return dataVersion
}

export function weakEtag(...parts: string[]): string {
  const hash = createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)
  return `W/"${hash}"`
}

export function resourceEtag(...parts: string[]): string {
  return weakEtag(dataVersion, ...parts)
}

/** Set Cache-Control + ETag. Returns a 304 response when If-None-Match matches. */
export function maybeNotModified(
  c: Context,
  options: { etag: string; maxAge: number },
): Response | null {
  c.header('Cache-Control', `public, max-age=${options.maxAge}`)
  c.header('ETag', options.etag)
  const incoming = c.req.header('If-None-Match')
  if (!incoming) return null
  const tags = incoming.split(',').map((value) => value.trim())
  if (tags.includes(options.etag)) {
    return c.body(null, 304)
  }
  return null
}

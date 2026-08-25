import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type Database from 'better-sqlite3'
import type { BrregEntity, BrregUnderenhet } from './types.js'
import { nullOrphanOverordnetEnhet } from './organizations.js'
import { beginBulkLoad, endBulkLoad } from './db.js'
import {
  importBrregFromGzip,
  type BrregImportOptions,
  type BrregImportResult,
} from './brreg-import-pipeline.js'
import { fetchWithRetry } from './rate-limit.js'
import { fetchAllKommuner, fetchLatestUpdateId, fetchLatestUpdateIdUnderenheter } from './brreg.js'

const API_BASE = 'https://data.brreg.no/enhetsregisteret/api'

export const DEFAULT_REFERENCE_CACHE_DIR = process.env.REFERENCE_CACHE_DIR ?? 'data/cache/reference'

export const BRREG_ENHETER_FILE = 'brreg/enheter.v2.json.gz'
export const BRREG_UNDERENHETER_FILE = 'brreg/underenheter.v2.json.gz'
export const BRREG_KOMMUNER_FILE = 'brreg/kommuner.json'
export const REFERENCE_MANIFEST_FILE = 'manifest.json'

export interface ReferenceManifest {
  brreg_enheter_cached_at?: string
  brreg_underenheter_cached_at?: string
  brreg_kommuner_cached_at?: string
  kartverket_national_cached_at?: string
  brreg_enheter_sha256?: string
  brreg_underenheter_sha256?: string
  kartverket_zip_sha256?: string
  last_oppdateringsid?: string
  last_oppdateringsid_underenheter?: string
}

export interface EnsureReferenceOptions {
  cacheDir?: string
  /** Re-use existing cached files (default true). */
  reuseDownloads?: boolean
  /** Force re-download even when cache exists. */
  refreshDownloads?: boolean
  /** Fail instead of downloading when cache files are missing. */
  localOnly?: boolean
  skipUnderenheter?: boolean
  skipBrreg?: boolean
  skipKartverket?: boolean
}

export function referencePath(cacheDir: string, relative: string): string {
  return join(cacheDir, relative)
}

export function readReferenceManifest(cacheDir = DEFAULT_REFERENCE_CACHE_DIR): ReferenceManifest {
  const path = referencePath(cacheDir, REFERENCE_MANIFEST_FILE)
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as ReferenceManifest
}

export function writeReferenceManifest(
  cacheDir: string,
  patch: Partial<ReferenceManifest>,
): ReferenceManifest {
  const path = referencePath(cacheDir, REFERENCE_MANIFEST_FILE)
  mkdirSync(dirname(path), { recursive: true })
  const next = { ...readReferenceManifest(cacheDir), ...patch }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

export function describeReferenceCache(cacheDir = DEFAULT_REFERENCE_CACHE_DIR): string {
  const parts: string[] = []
  const enheter = referencePath(cacheDir, BRREG_ENHETER_FILE)
  const under = referencePath(cacheDir, BRREG_UNDERENHETER_FILE)
  const kartverket = referencePath(
    cacheDir,
    'kartverket/Basisdata_0000_Norge_4258_MatrikkelenAdresse_CSV.zip',
  )

  if (existsSync(enheter)) parts.push(`BRREG enheter: ${enheter}`)
  if (existsSync(under)) parts.push(`BRREG underenheter: ${under}`)
  if (existsSync(kartverket)) parts.push(`Kartverket: ${kartverket}`)
  if (parts.length === 0) return `${cacheDir} (tom)`
  return parts.join('; ')
}

function shouldDownload(
  existingPath: string,
  reuseDownloads: boolean,
  refreshDownloads: boolean,
): boolean {
  if (refreshDownloads) return true
  if (reuseDownloads && existsSync(existingPath)) return false
  return !existsSync(existingPath)
}

export function sha256File(path: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

export function nationalKartverketZipPath(cacheDir = DEFAULT_REFERENCE_CACHE_DIR): string {
  return join(cacheDir, 'kartverket', 'Basisdata_0000_Norge_4258_MatrikkelenAdresse_CSV.zip')
}

export function refreshReferenceFileHashes(
  cacheDir = DEFAULT_REFERENCE_CACHE_DIR,
): ReferenceManifest {
  const patch: Partial<ReferenceManifest> = {}
  const enheterPath = referencePath(cacheDir, BRREG_ENHETER_FILE)
  const underPath = referencePath(cacheDir, BRREG_UNDERENHETER_FILE)
  const kartverketPath = nationalKartverketZipPath(cacheDir)

  if (existsSync(enheterPath)) patch.brreg_enheter_sha256 = sha256File(enheterPath)
  if (existsSync(underPath)) patch.brreg_underenheter_sha256 = sha256File(underPath)
  if (existsSync(kartverketPath)) patch.kartverket_zip_sha256 = sha256File(kartverketPath)

  return writeReferenceManifest(cacheDir, patch)
}

async function downloadBinaryToFile(url: string, accept: string, destPath: string, label: string) {
  mkdirSync(dirname(destPath), { recursive: true })
  const response = await fetchWithRetry(url, { headers: { Accept: accept } }, label)

  if (!response.ok || !response.body) {
    throw new Error(`${label} feilet (${response.status})`)
  }

  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    createWriteStream(destPath),
  )
}

export interface StreamBrregGzipOptions {
  quiet?: boolean
  onRowsRead?: (rowsRead: number) => void
}

export async function streamBrregGzipArray<T>(
  gzipPath: string,
  onItem: (item: T) => void | Promise<void>,
  label: string,
  options: StreamBrregGzipOptions = {},
): Promise<number> {
  const { chain } = await import('stream-chain')
  const { parser } = await import('stream-json')
  const { streamArray } = await import('stream-json/streamers/stream-array.js')
  const { createGunzip } = await import('node:zlib')

  const jsonPipeline = chain([createReadStream(gzipPath), createGunzip(), parser(), streamArray()])
  let count = 0

  for await (const chunk of jsonPipeline) {
    const result = onItem((chunk as { value: T }).value)
    if (result instanceof Promise) await result
    count += 1
    if (count % 10000 === 0) {
      if (options.quiet) {
        options.onRowsRead?.(count)
      } else {
        console.log(`  ${label}: ${count.toLocaleString('nb-NO')} rader…`)
      }
    }
  }

  return count
}

export async function ensureBrregEnheterCache(
  cacheDir = DEFAULT_REFERENCE_CACHE_DIR,
  options: Pick<EnsureReferenceOptions, 'reuseDownloads' | 'refreshDownloads' | 'localOnly'> = {},
): Promise<string> {
  const reuseDownloads = options.reuseDownloads ?? true
  const refreshDownloads = options.refreshDownloads ?? false
  const destPath = referencePath(cacheDir, BRREG_ENHETER_FILE)

  if (options.localOnly && !existsSync(destPath)) {
    throw new Error(
      `Mangler lokal BRREG enheter-fil: ${destPath}. Kjør yarn build-national-db for å laste ned referansedata.`,
    )
  }

  if (!shouldDownload(destPath, reuseDownloads, refreshDownloads)) {
    console.log(`Gjenbruker lokal BRREG enheter-fil: ${destPath}`)
    return destPath
  }

  console.log('Laster ned BRREG enheter (bulk) til referansecache…')
  await downloadBinaryToFile(
    `${API_BASE}/enheter/lastned`,
    'application/vnd.brreg.enhetsregisteret.enhet.v2+gzip;charset=UTF-8',
    destPath,
    'BRREG enheter bulk',
  )
  console.log(`  Lagret ${destPath}`)

  const manifestPatch: Partial<ReferenceManifest> = {
    brreg_enheter_cached_at: new Date().toISOString(),
  }

  if (!existsSync(referencePath(cacheDir, REFERENCE_MANIFEST_FILE)) || refreshDownloads) {
    const latestId = await fetchLatestUpdateId()
    if (latestId > 0) manifestPatch.last_oppdateringsid = String(latestId)
  }

  writeReferenceManifest(cacheDir, manifestPatch)
  refreshReferenceFileHashes(cacheDir)
  return destPath
}

export async function ensureBrregUnderenheterCache(
  cacheDir = DEFAULT_REFERENCE_CACHE_DIR,
  options: Pick<EnsureReferenceOptions, 'reuseDownloads' | 'refreshDownloads' | 'localOnly'> = {},
): Promise<string> {
  const reuseDownloads = options.reuseDownloads ?? true
  const refreshDownloads = options.refreshDownloads ?? false
  const destPath = referencePath(cacheDir, BRREG_UNDERENHETER_FILE)

  if (options.localOnly && !existsSync(destPath)) {
    throw new Error(
      `Mangler lokal BRREG underenheter-fil: ${destPath}. Kjør yarn build-national-db for å laste ned referansedata.`,
    )
  }

  if (!shouldDownload(destPath, reuseDownloads, refreshDownloads)) {
    console.log(`Gjenbruker lokal BRREG underenheter-fil: ${destPath}`)
    return destPath
  }

  console.log('Laster ned BRREG underenheter (bulk) til referansecache…')
  await downloadBinaryToFile(
    `${API_BASE}/underenheter/lastned`,
    'application/vnd.brreg.enhetsregisteret.underenhet.v2+gzip;charset=UTF-8',
    destPath,
    'BRREG underenheter bulk',
  )
  console.log(`  Lagret ${destPath}`)

  const manifestPatch: Partial<ReferenceManifest> = {
    brreg_underenheter_cached_at: new Date().toISOString(),
  }

  if (!existsSync(referencePath(cacheDir, REFERENCE_MANIFEST_FILE)) || refreshDownloads) {
    const latestUnderId = await fetchLatestUpdateIdUnderenheter()
    if (latestUnderId > 0) {
      manifestPatch.last_oppdateringsid_underenheter = String(latestUnderId)
    }
  }

  writeReferenceManifest(cacheDir, manifestPatch)
  refreshReferenceFileHashes(cacheDir)
  return destPath
}

export async function ensureKommunerCache(
  cacheDir = DEFAULT_REFERENCE_CACHE_DIR,
  options: Pick<EnsureReferenceOptions, 'reuseDownloads' | 'refreshDownloads' | 'localOnly'> = {},
): Promise<Array<{ nummer: string; navn: string }>> {
  const reuseDownloads = options.reuseDownloads ?? true
  const refreshDownloads = options.refreshDownloads ?? false
  const destPath = referencePath(cacheDir, BRREG_KOMMUNER_FILE)

  if (options.localOnly && !existsSync(destPath)) {
    throw new Error(
      `Mangler lokal kommuneliste: ${destPath}. Kjør yarn build-national-db for å laste ned referansedata.`,
    )
  }

  if (!shouldDownload(destPath, reuseDownloads, refreshDownloads)) {
    return JSON.parse(readFileSync(destPath, 'utf8')) as Array<{ nummer: string; navn: string }>
  }

  console.log('Henter kommuneliste fra BRREG (lagres lokalt for senere offline-bygg)…')
  const kommuner = await fetchAllKommuner()
  mkdirSync(dirname(destPath), { recursive: true })
  writeFileSync(destPath, `${JSON.stringify(kommuner, null, 2)}\n`, 'utf8')
  writeReferenceManifest(cacheDir, { brreg_kommuner_cached_at: new Date().toISOString() })
  return kommuner
}

export function loadKommunerCache(
  cacheDir = DEFAULT_REFERENCE_CACHE_DIR,
): Array<{ nummer: string; navn: string }> | null {
  const destPath = referencePath(cacheDir, BRREG_KOMMUNER_FILE)
  if (!existsSync(destPath)) return null
  return JSON.parse(readFileSync(destPath, 'utf8')) as Array<{ nummer: string; navn: string }>
}

export async function ensureBrregReferenceCache(
  cacheDir = DEFAULT_REFERENCE_CACHE_DIR,
  options: EnsureReferenceOptions = {},
): Promise<{ enheterPath: string; underenheterPath?: string; manifest: ReferenceManifest }> {
  if (options.skipBrreg) {
    const enheterPath = referencePath(cacheDir, BRREG_ENHETER_FILE)
    if (!existsSync(enheterPath)) {
      throw new Error(`Mangler lokal BRREG enheter-fil: ${enheterPath}`)
    }
    return {
      enheterPath,
      underenheterPath: existsSync(referencePath(cacheDir, BRREG_UNDERENHETER_FILE))
        ? referencePath(cacheDir, BRREG_UNDERENHETER_FILE)
        : undefined,
      manifest: readReferenceManifest(cacheDir),
    }
  }

  const cacheOptions = {
    reuseDownloads: options.reuseDownloads,
    refreshDownloads: options.refreshDownloads,
    localOnly: options.localOnly,
  }

  const enheterPromise = ensureBrregEnheterCache(cacheDir, cacheOptions)
  const kommunerPromise = ensureKommunerCache(cacheDir, cacheOptions)
  const underPromise = options.skipUnderenheter
    ? Promise.resolve(undefined)
    : ensureBrregUnderenheterCache(cacheDir, cacheOptions)

  const [enheterPath, , underenheterPath] = await Promise.all([
    enheterPromise,
    kommunerPromise,
    underPromise,
  ])

  refreshReferenceFileHashes(cacheDir)

  return { enheterPath, underenheterPath, manifest: readReferenceManifest(cacheDir) }
}

export async function importBrregEnheterFromCache(
  gzipPath: string,
  onEntity: (entity: BrregEntity) => void | Promise<void>,
  filter?: (entity: BrregEntity) => boolean,
): Promise<number> {
  return streamBrregGzipArray<BrregEntity>(
    gzipPath,
    (entity) => {
      if (filter && !filter(entity)) return
      return onEntity(entity)
    },
    'Importerer enheter fra lokal BRREG-fil',
  )
}

export async function importBrregUnderenheterFromCache(
  gzipPath: string,
  onEntity: (entity: BrregUnderenhet) => void | Promise<void>,
  filter?: (entity: BrregUnderenhet) => boolean,
): Promise<number> {
  return streamBrregGzipArray<BrregUnderenhet>(
    gzipPath,
    (entity) => {
      if (filter && !filter(entity)) return
      return onEntity(entity)
    },
    'Importerer underenheter fra lokal BRREG-fil',
  )
}

async function runBulkImport(
  db: Database.Database,
  importFn: () => Promise<BrregImportResult>,
  options: { quiet?: boolean } = {},
): Promise<BrregImportResult> {
  beginBulkLoad(db)
  db.exec('BEGIN DEFERRED')
  try {
    const result = await importFn()
    const cleared = nullOrphanOverordnetEnhet(db)
    if (cleared > 0 && !options.quiet) {
      console.log(
        `  Nullstilte ${cleared.toLocaleString('nb-NO')} foreldreløse overordnet_enhet-referanser`,
      )
    }
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    endBulkLoad(db)
  }
}

export async function importBrregEnheterFromCacheTransactional(
  db: Database.Database,
  gzipPath: string,
  filter?: (entity: BrregEntity) => boolean,
  options: Omit<BrregImportOptions, 'entityKind' | 'filter'> = {},
): Promise<BrregImportResult> {
  return runBulkImport(
    db,
    () => importBrregFromGzip(db, gzipPath, { entityKind: 'enhet', filter, ...options }),
    { quiet: options.quiet },
  )
}

export async function importBrregUnderenheterFromCacheTransactional(
  db: Database.Database,
  gzipPath: string,
  filter?: (entity: BrregUnderenhet) => boolean,
  options: Omit<BrregImportOptions, 'entityKind' | 'filter'> = {},
): Promise<BrregImportResult> {
  return runBulkImport(
    db,
    () =>
      importBrregFromGzip(db, gzipPath, {
        entityKind: 'underenhet',
        filter: filter as BrregImportOptions['filter'],
        ...options,
      }),
    { quiet: options.quiet },
  )
}

export function brregReferenceAvailable(cacheDir = DEFAULT_REFERENCE_CACHE_DIR): boolean {
  return existsSync(referencePath(cacheDir, BRREG_ENHETER_FILE))
}

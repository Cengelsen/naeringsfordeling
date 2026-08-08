import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { importBrregForKommuner } from './brreg-local-import.js'
import {
  DEFAULT_REFERENCE_CACHE_DIR,
  brregReferenceAvailable,
  ensureKommunerCache,
  loadKommunerCache,
} from './reference-cache.js'
import {
  downloadAndImportRegionKartverket,
  kartverketAddressCount,
  kartverketBulkAvailable,
} from './kartverket-bulk.js'
import {
  backfillMetadataFromKartverketBulk,
  geocodeAllFromKartverketBulk,
} from './local-geocode.js'
import { getStats, openDatabase, rebuildOrgsRtree, removeDatabaseFiles, setSyncState } from './db.js'
import {
  importRegionFromNationalDb,
  listKommunerFromNationalDb,
  nationalDatabaseAvailable,
  resolveNationalDbPath,
  resolveRegionDataSource,
  type RegionDataSource,
} from './national-db-slice.js'
import { emitRegionBuildProgress } from './region-build-ipc.js'

export const DEFAULT_REGIONS_DIR = process.env.REGIONS_OUTPUT_DIR ?? 'data/regions'

export interface RegionBuildOptions {
  /** Two-digit fylkeskode, e.g. "46". */
  fylke?: string
  /** Four-digit kommunenummer, e.g. "4601". */
  kommune?: string
  outputPath: string
  fresh?: boolean
  skipKartverket?: boolean
  skipBrreg?: boolean
  skipGeocode?: boolean
  skipUnderenheter?: boolean
  reuseDownloads?: boolean
  refreshDownloads?: boolean
  /** Root for reference cache (BRREG bulk + Kartverket zips). */
  referenceCacheDir?: string
  /** Path to national SQLite (default: data/norway.db). */
  nationalDbPath?: string
  /** auto = cache if available, else national DB. */
  sourceMode?: 'auto' | 'cache' | 'national'
  /** @deprecated Use referenceCacheDir */
  cacheDir?: string
  /** Suppress step logging (for parallel orchestrators). */
  quiet?: boolean
  /** Emit progress lines for parent process (stdout IPC). */
  reportProgress?: boolean
  onProgress?: (event: RegionBuildProgress) => void
  /** Expected org count for this region (dashboard BRREG progress). */
  estimatedBrregOrgs?: number
  nationalBrregEnheterRows?: number
  nationalBrregUnderenheterRows?: number
}

export type RegionBuildPhase =
  | 'starting'
  | 'kartverket-download'
  | 'kartverket-import'
  | 'brreg'
  | 'geocode'
  | 'index'
  | 'done'

export interface RegionBuildProgress {
  phase: RegionBuildPhase
  progress?: number
  detail?: string
  /** Human-readable phase label (e.g. BRREG enheter 1/2). */
  displayPhase?: string
}

function regionLog(options: RegionBuildOptions, ...args: unknown[]) {
  if (!options.quiet) console.log(...args)
}

function regionProgress(options: RegionBuildOptions, event: RegionBuildProgress) {
  if (options.reportProgress) {
    emitRegionBuildProgress({
      type: 'progress',
      phase: event.phase,
      progress: event.progress,
      detail: event.detail,
      displayPhase: event.displayPhase,
    })
  }
  options.onProgress?.(event)
}

export interface RegionDescriptor {
  kind: 'fylke' | 'kommune'
  code: string
  name: string
  slug: string
  kommuner: string[]
}

export function slugifyRegionName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function defaultRegionOutputPath(descriptor: RegionDescriptor, baseDir = DEFAULT_REGIONS_DIR): string {
  const subdir = descriptor.kind === 'fylke' ? 'fylker' : 'kommuner'
  return join(baseDir, subdir, `${descriptor.code}-${descriptor.slug}.db`)
}

export function resolveReferenceCacheDir(options: {
  referenceCacheDir?: string
  cacheDir?: string
}): string {
  return options.referenceCacheDir ?? options.cacheDir ?? DEFAULT_REFERENCE_CACHE_DIR
}

export function kartverketCacheDirForReference(referenceCacheDir: string): string {
  return process.env.KARTVERKET_CACHE_DIR ?? join(referenceCacheDir, 'kartverket')
}

async function loadKommunerForBuild(
  referenceCacheDir: string,
  options: { localOnly?: boolean; nationalDbPath?: string } = {},
) {
  const cached = loadKommunerCache(referenceCacheDir)
  if (cached) return cached

  const nationalPath = resolveNationalDbPath(options.nationalDbPath)
  if (nationalDatabaseAvailable(nationalPath)) {
    const fromNational = listKommunerFromNationalDb(nationalPath)
    if (fromNational.length > 0) {
      console.log(`  Kommuneliste fra nasjonal database: ${nationalPath}`)
      return fromNational
    }
  }

  if (options.localOnly) {
    throw new Error(
      `Mangler kommuneliste i ${referenceCacheDir} og nasjonal database (${nationalPath}). Kjør yarn build-national-db først.`,
    )
  }

  return ensureKommunerCache(referenceCacheDir, { reuseDownloads: true })
}

function resolveRegionDataSourceMode(options: RegionBuildOptions): {
  source: RegionDataSource
  nationalDbPath: string
} {
  const referenceCacheDir = resolveReferenceCacheDir(options)
  const nationalDbPath = resolveNationalDbPath(options.nationalDbPath)
  const cacheAvailable = brregReferenceAvailable(referenceCacheDir)
  const nationalAvailable = nationalDatabaseAvailable(nationalDbPath)

  if (options.sourceMode === 'cache') {
    if (!cacheAvailable) {
      throw new Error(`Mangler BRREG referansecache i ${referenceCacheDir}. Kjør yarn build-national-db først.`)
    }
    return { source: 'cache', nationalDbPath }
  }

  if (options.sourceMode === 'national') {
    if (!nationalAvailable) {
      throw new Error(`Mangler nasjonal database: ${nationalDbPath}. Kjør yarn build-national-db først.`)
    }
    return { source: 'national', nationalDbPath }
  }

  return resolveRegionDataSource({
    referenceCacheDir,
    nationalDbPath,
  })
}

export async function resolveRegionDescriptor(
  input: { fylke?: string; kommune?: string },
  referenceCacheDir = DEFAULT_REFERENCE_CACHE_DIR,
  options: { localOnly?: boolean; nationalDbPath?: string } = {},
): Promise<RegionDescriptor> {
  const allKommuner = await loadKommunerForBuild(referenceCacheDir, {
    localOnly: options.localOnly ?? true,
    nationalDbPath: options.nationalDbPath,
  })

  if (input.kommune) {
    const code = input.kommune.padStart(4, '0')
    const match = allKommuner.find((k) => k.nummer === code)
    if (!match) {
      throw new Error(`Ukjent kommunenummer «${code}».`)
    }
    return {
      kind: 'kommune',
      code,
      name: match.navn,
      slug: slugifyRegionName(match.navn),
      kommuner: [code],
    }
  }

  if (input.fylke) {
    const code = input.fylke.padStart(2, '0').slice(0, 2)
    const kommuner = allKommuner
      .filter((k) => k.nummer.slice(0, 2) === code)
      .map((k) => k.nummer)
      .sort()

    if (kommuner.length === 0) {
      throw new Error(`Ingen kommuner funnet for fylke «${code}».`)
    }

    const fylkeName = fylkeNameFromKommuner(code, allKommuner)
    return {
      kind: 'fylke',
      code,
      name: fylkeName,
      slug: slugifyRegionName(fylkeName),
      kommuner,
    }
  }

  throw new Error('Region krever --fylke=XX eller --kommune=XXXX.')
}

export const CURRENT_FYLKE_CODES = [
  '03',
  '11',
  '15',
  '18',
  '31',
  '32',
  '33',
  '34',
  '39',
  '40',
  '42',
  '46',
  '50',
  '55',
  '56',
] as const

const FYLKE_NAMES: Record<string, string> = {
  '03': 'Oslo',
  '11': 'Rogaland',
  '15': 'Møre og Romsdal',
  '18': 'Nordland',
  '21': 'Svalbard',
  '22': 'Jan Mayen',
  '31': 'Østfold',
  '32': 'Akershus',
  '33': 'Buskerud',
  '34': 'Innlandet',
  '39': 'Vestfold',
  '40': 'Telemark',
  '42': 'Agder',
  '46': 'Vestland',
  '50': 'Trøndelag',
  '55': 'Troms',
  '56': 'Finnmark',
}

function fylkeNameFromKommuner(
  fylkeCode: string,
  kommuner: Array<{ nummer: string; navn: string }>,
): string {
  return FYLKE_NAMES[fylkeCode] ?? `Fylke ${fylkeCode}`
}

export async function listAllFylker(
  referenceCacheDir = DEFAULT_REFERENCE_CACHE_DIR,
  options: {
    localOnly?: boolean
    nationalDbPath?: string
    /** Only the 15 current mainland fylker (excludes utland/Svalbard pseudo-codes). */
    currentOnly?: boolean
  } = {},
): Promise<RegionDescriptor[]> {
  const kommuner = await loadKommunerForBuild(referenceCacheDir, {
    localOnly: options.localOnly ?? true,
    nationalDbPath: options.nationalDbPath,
  })
  const codes = [...new Set(kommuner.map((k) => k.nummer.slice(0, 2)))].sort()
  const allowed =
    options.currentOnly === true ? new Set<string>(CURRENT_FYLKE_CODES) : null

  return codes
    .filter((code) => allowed == null || allowed.has(code))
    .map((code) => ({
      kind: 'fylke' as const,
      code,
      name: fylkeNameFromKommuner(code, kommuner),
      slug: slugifyRegionName(fylkeNameFromKommuner(code, kommuner)),
      kommuner: kommuner.filter((k) => k.nummer.slice(0, 2) === code).map((k) => k.nummer).sort(),
    }))
}

export async function listAllKommuner(
  referenceCacheDir = DEFAULT_REFERENCE_CACHE_DIR,
  options: { localOnly?: boolean; nationalDbPath?: string } = {},
): Promise<RegionDescriptor[]> {
  const kommuner = await loadKommunerForBuild(referenceCacheDir, {
    localOnly: options.localOnly ?? true,
    nationalDbPath: options.nationalDbPath,
  })
  return kommuner.map((k) => ({
    kind: 'kommune' as const,
    code: k.nummer,
    name: k.navn,
    slug: slugifyRegionName(k.navn),
    kommuner: [k.nummer],
  }))
}

export function regionLabel(descriptor: RegionDescriptor): string {
  if (descriptor.kind === 'fylke') {
    return `fylke ${descriptor.code} ${descriptor.name} (${descriptor.kommuner.length} kommuner)`
  }
  return `kommune ${descriptor.code} ${descriptor.name}`
}

export async function buildRegionDatabase(options: RegionBuildOptions) {
  const referenceCacheDir = resolveReferenceCacheDir(options)
  const kartverketCacheDir = kartverketCacheDirForReference(referenceCacheDir)
  const reuseDownloads = options.reuseDownloads ?? !options.refreshDownloads
  const { source, nationalDbPath } = resolveRegionDataSourceMode(options)

  const descriptor = await resolveRegionDescriptor(
    { fylke: options.fylke, kommune: options.kommune },
    referenceCacheDir,
    { localOnly: true, nationalDbPath },
  )

  if (options.fresh && existsSync(options.outputPath)) {
    regionLog(options, `Sletter eksisterende database: ${options.outputPath}`)
    removeDatabaseFiles(options.outputPath)
  }

  mkdirSync(dirname(options.outputPath), { recursive: true })
  const db = openDatabase(options.outputPath, { runBackfill: true })

  regionProgress(options, { phase: 'starting' })
  regionLog(options, `Bygger regionsdatabase: ${regionLabel(descriptor)}`)
  regionLog(options, `  Output: ${options.outputPath}`)
  regionLog(
    options,
    source === 'cache'
      ? `  Datakilde: referansecache (${referenceCacheDir})`
      : `  Datakilde: nasjonal SQLite (${nationalDbPath})`,
  )

  setSyncState(db, 'build_source', 'build-region-db')
  setSyncState(db, 'region_kind', descriptor.kind)
  setSyncState(db, 'region_code', descriptor.code)
  setSyncState(db, 'region_name', descriptor.name)
  setSyncState(db, 'region_data_source', source)

  if (source === 'national') {
    regionLog(options, '\nSteg 1/2: Kopierer region fra nasjonal database…')
    const copied = importRegionFromNationalDb(db, nationalDbPath, descriptor.kommuner, {
      skipUnderenheter: options.skipUnderenheter ?? false,
    })
    regionLog(options, `  ${copied.organizations.toLocaleString('nb-NO')} organisasjoner`)
    regionLog(options, `  ${copied.addressCache.toLocaleString('nb-NO')} adresse-cache-rader`)
    regionLog(options, `  ${copied.kartverket.toLocaleString('nb-NO')} Kartverket-adresser`)
    setSyncState(db, 'copied_from_national_db', nationalDbPath)
  } else {
    if (!options.skipKartverket) {
      regionLog(options, '\nSteg 1/4: Kartverket Adresse (regional CSV)…')
      const scope =
        descriptor.kind === 'kommune'
          ? { kommune: descriptor.code }
          : { fylke: descriptor.code }
      await downloadAndImportRegionKartverket(db, scope, {
        cacheDir: kartverketCacheDir,
        reuseDownload: reuseDownloads,
        clearExisting: true,
        quiet: options.quiet,
        onProgress: (event) => {
          if (event.phase === 'download') {
            regionProgress(options, {
              phase: 'kartverket-download',
              progress: event.progress,
              detail: event.detail,
            })
            return
          }
          regionProgress(options, {
            phase: 'kartverket-import',
            progress: event.progress,
            detail: event.detail,
          })
        },
      })
      setSyncState(db, 'kartverket_bulk_imported_at', new Date().toISOString())
    } else if (!kartverketBulkAvailable(db)) {
      throw new Error('Ingen Kartverket-data i databasen. Fjern --skip-kartverket.')
    }

    if (!options.skipBrreg) {
      regionLog(
        options,
        `\nSteg 2/4: Importerer BRREG for ${descriptor.kommuner.length} kommune(r) fra lokal cache…`,
      )
      regionProgress(options, { phase: 'brreg' })
      await importBrregForKommuner(db, descriptor.kommuner, {
        skipUnderenheter: options.skipUnderenheter ?? false,
        referenceCacheDir,
        quiet: options.quiet,
        nationalEnheterRows: options.nationalBrregEnheterRows,
        nationalUnderenheterRows: options.nationalBrregUnderenheterRows,
        onBrregProgress: (event) => {
          const hasUnderenheter =
            !(options.skipUnderenheter ?? false) &&
            (options.nationalBrregUnderenheterRows ?? 0) > 0
          const brregSteps = hasUnderenheter ? 2 : 1
          const stepIndex = event.phase === 'enheter' ? 1 : 2
          const rowGoal =
            event.phase === 'enheter'
              ? options.nationalBrregEnheterRows
              : options.nationalBrregUnderenheterRows
          const stepProgress =
            rowGoal != null && rowGoal > 0 ? Math.min(1, event.rowsRead / rowGoal) : undefined

          let combinedProgress = stepProgress
          if (brregSteps === 2 && stepProgress != null) {
            combinedProgress =
              event.phase === 'enheter' ? stepProgress * 0.5 : 0.5 + stepProgress * 0.5
          }

          const fileLabel = event.phase === 'enheter' ? 'enheter' : 'underenheter'
          const displayPhase =
            brregSteps === 1
              ? 'BRREG enheter'
              : `BRREG ${fileLabel} (${stepIndex}/${brregSteps})`

          const rowDetail =
            rowGoal != null && rowGoal > 0
              ? `${event.rowsRead.toLocaleString('nb-NO')}/${rowGoal.toLocaleString('nb-NO')} rows in national file`
              : undefined
          const detail = [
            `${event.imported.toLocaleString('nb-NO')} org matched in fylke`,
            rowDetail,
            brregSteps === 2 && event.phase === 'underenheter'
              ? 'step 2: scanning underenheter file'
              : brregSteps === 2
                ? 'step 1: scanning enheter file'
                : 'scanning national enheter file',
          ]
            .filter(Boolean)
            .join(' · ')

          regionProgress(options, {
            phase: 'brreg',
            progress: combinedProgress,
            displayPhase,
            detail,
          })
        },
      })
    }

    if (!options.skipGeocode) {
      regionLog(options, '\nSteg 3/4: Geokoder organisasjoner mot lokal Kartverket-database…')
      await geocodeAllFromKartverketBulk(db, {
        quiet: options.quiet,
        onProgress: (event) => {
          regionProgress(options, {
            phase: 'geocode',
            progress: event.progress,
            detail: event.detail,
          })
        },
      })
      await backfillMetadataFromKartverketBulk(db, { quiet: options.quiet })
    } else {
      regionLog(options, '\nSteg 3/4: Hopper over geokoding (--skip-geocode).')
    }
  }

  regionProgress(options, { phase: 'index' })
  regionLog(options, `\nSteg ${source === 'national' ? '2/2' : '4/4'}: Bygger spatialt indeks (R-tree)…`)
  rebuildOrgsRtree(db)
  setSyncState(db, 'last_sync_at', new Date().toISOString())

  const stats = getStats(db)
  const kartverketCount = kartverketAddressCount(db)

  regionProgress(options, {
    phase: 'done',
    detail: `${stats.total.toLocaleString('nb-NO')} org.`,
  })
  if (options.reportProgress) {
    emitRegionBuildProgress({
      type: 'done',
      orgTotal: stats.total ?? 0,
      outputPath: options.outputPath,
    })
  }
  regionLog(options, '\nFerdig. Database status:')
  regionLog(options, `  Fil: ${options.outputPath}`)
  regionLog(options, `  Region: ${regionLabel(descriptor)}`)
  regionLog(options, `  Kartverket-adresser: ${kartverketCount.toLocaleString('nb-NO')}`)
  regionLog(options, `  Organisasjoner totalt: ${stats.total.toLocaleString('nb-NO')}`)
  regionLog(options, `  Geokodet: ${(stats.geocoded ?? 0).toLocaleString('nb-NO')}`)
  regionLog(options, `  Venter geokoding: ${(stats.pending_geocode ?? 0).toLocaleString('nb-NO')}`)

  db.close()
  return { descriptor, stats, kartverketCount }
}

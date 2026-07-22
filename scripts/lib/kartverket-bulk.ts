import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type Database from 'better-sqlite3'
import { fetchWithRetry } from './rate-limit.js'
import { DEFAULT_REFERENCE_CACHE_DIR } from './reference-cache.js'

const ATOM_FEED_CSV =
  'https://nedlasting.geonorge.no/geonorge/ATOM-feeds/MatrikkelenAdresse_AtomFeedCSV.xml'

const DEFAULT_NATIONAL_CSV_URL =
  'https://nedlasting.geonorge.no/geonorge/Basisdata/MatrikkelenAdresse/CSV/Basisdata_0000_Norge_4258_MatrikkelenAdresse_CSV.zip'

export const DEFAULT_KARTVERKET_CACHE_DIR =
  process.env.KARTVERKET_CACHE_DIR ?? join(DEFAULT_REFERENCE_CACHE_DIR, 'kartverket')

function ensureUnzipAvailable() {
  const result = spawnSync('unzip', ['-v'], { stdio: 'ignore' })
  if (result.error || result.status !== 0) {
    throw new Error(
      'Kommandoen «unzip» mangler. Installer unzip (f.eks. dnf install unzip) for å pakke ut Kartverket CSV.',
    )
  }
}

export function ensureKartverketSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kartverket_addresses (
      adresse_id TEXT PRIMARY KEY,
      postnummer TEXT NOT NULL,
      adressenavn TEXT,
      nummer TEXT,
      bokstav TEXT,
      adresse_tekst TEXT NOT NULL,
      adresse_tekst_norm TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      kommunenummer TEXT,
      matrikkel_key TEXT,
      lookup_key TEXT,
      adressetype TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_kv_lookup_key
      ON kartverket_addresses(lookup_key)
      WHERE lookup_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_kv_text_lookup
      ON kartverket_addresses(postnummer, adresse_tekst_norm);
  `)
}

export function normalizeAddressText(text: string): string {
  return text.trim().toLowerCase()
}

export function structuredLookupKey(
  postnummer: string,
  adressenavn: string,
  nummer: string,
  bokstav = '',
): string | null {
  if (!postnummer || !adressenavn.trim() || !nummer.trim()) return null
  const num = `${nummer}${bokstav}`.replace(/\s+/g, '')
  return `${postnummer}|${adressenavn.trim().toLowerCase()}|${num}`
}

export function matrikkelKeyFromCsv(
  kommunenummer: string,
  gardsnummer: string,
  bruksnummer: string,
  festenummer: string,
  undernummer: string,
): string | null {
  if (!gardsnummer && !bruksnummer) return null
  const g = Number(gardsnummer) || 0
  const b = Number(bruksnummer) || 0
  const f = Number(festenummer) || 0
  const u = Number(undernummer) || 0
  return `${kommunenummer}|${g}/${b}/${f}/${u}`
}

export async function resolveNationalCsvDownloadUrl(): Promise<string> {
  return resolveRegionCsvDownloadUrl({ national: true }) ?? DEFAULT_NATIONAL_CSV_URL
}

let atomFeedXmlCache: string | null = null

async function fetchAtomFeedXml(): Promise<string> {
  if (atomFeedXmlCache) return atomFeedXmlCache
  const response = await fetchWithRetry(ATOM_FEED_CSV, undefined, 'Kartverket ATOM-feed')
  atomFeedXmlCache = await response.text()
  return atomFeedXmlCache
}

export type KartverketRegionScope =
  | { national: true }
  | { fylke: string }
  | { kommune: string }

function regionZipPattern(scope: KartverketRegionScope): RegExp {
  if ('national' in scope) {
    return /href="(https:\/\/nedlasting\.geonorge\.no\/geonorge\/Basisdata\/MatrikkelenAdresse\/CSV\/Basisdata_0000_Norge_4258_MatrikkelenAdresse_CSV\.zip)"/
  }
  if ('kommune' in scope) {
    const kommune = scope.kommune.padStart(4, '0')
    return new RegExp(
      `href="(https://nedlasting\\.geonorge\\.no/geonorge/Basisdata/MatrikkelenAdresse/CSV/Basisdata_${kommune}_[^"]*_4258_MatrikkelenAdresse_CSV\\.zip)"`,
    )
  }
  const fylke = scope.fylke.padStart(2, '0').slice(0, 2)
  return new RegExp(
    `href="(https://nedlasting\\.geonorge\\.no/geonorge/Basisdata/MatrikkelenAdresse/CSV/Basisdata_${fylke}_[^"]*_4258_MatrikkelenAdresse_CSV\\.zip)"`,
  )
}

export async function resolveRegionCsvDownloadUrl(
  scope: KartverketRegionScope,
): Promise<string | null> {
  try {
    const xml = await fetchAtomFeedXml()
    const match = xml.match(regionZipPattern(scope))
    return match?.[1] ?? null
  } catch (error) {
    console.warn('Kunne ikke lese Kartverket ATOM-feed:', error)
    return null
  }
}

export function regionZipCachePath(
  scope: KartverketRegionScope,
  cacheDir = DEFAULT_KARTVERKET_CACHE_DIR,
): string {
  if ('national' in scope) {
    return join(cacheDir, 'Basisdata_0000_Norge_4258_MatrikkelenAdresse_CSV.zip')
  }
  if ('kommune' in scope) {
    const kommune = scope.kommune.padStart(4, '0')
    return join(cacheDir, 'kommuner', `${kommune}_4258_MatrikkelenAdresse_CSV.zip`)
  }
  const fylke = scope.fylke.padStart(2, '0').slice(0, 2)
  return join(cacheDir, 'fylker', `${fylke}_4258_MatrikkelenAdresse_CSV.zip`)
}

async function downloadFile(url: string, destination: string): Promise<void> {
  mkdirSync(basename(destination) === destination ? '.' : join(destination, '..'), {
    recursive: true,
  })

  const response = await fetchWithRetry(url, undefined, 'Kartverket bulk nedlasting')
  if (!response.ok || !response.body) {
    throw new Error(`Kartverket-nedlasting feilet (${response.status})`)
  }

  const totalBytes = Number(response.headers.get('content-length') ?? '0')
  const reader = response.body.getReader()
  const file = createWriteStream(destination)

  let received = 0
  let lastLog = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    file.write(value)
    received += value.byteLength

    if (totalBytes > 0 && received - lastLog >= 5 * 1024 * 1024) {
      const pct = Math.round((received / totalBytes) * 100)
      console.log(
        `  Lastet ned ${(received / (1024 * 1024)).toFixed(1)} / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB (${pct} %)`,
      )
      lastLog = received
    }
  }

  await new Promise<void>((resolve, reject) => {
    file.end(() => resolve())
    file.on('error', reject)
  })

  console.log(`  Lagret ${destination} (${(received / (1024 * 1024)).toFixed(1)} MB)`)
}

function findCsvEntryInZip(zipPath: string): string {
  const result = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Kunne ikke liste innhold i ${zipPath}: ${result.stderr}`)
  }

  const entry =
    result.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.endsWith('matrikkelenAdresse.csv')) ?? null

  if (!entry) {
    throw new Error(`Fant ingen matrikkelenAdresse.csv i ${zipPath}`)
  }

  return entry
}

function parseCsvLine(line: string): string[] {
  return line.split(';')
}

function parseCoordinate(value: string): number | null {
  const normalized = value.trim().replace(',', '.')
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

export interface KartverketImportOptions {
  cacheDir?: string
  reuseDownload?: boolean
  clearExisting?: boolean
  /** When importing a fylke-zip for a single kommune, keep only this kommunenummer. */
  kommunenummer?: string
}

export async function downloadRegionKartverketCsv(
  scope: KartverketRegionScope,
  options: Pick<KartverketImportOptions, 'cacheDir' | 'reuseDownload'> = {},
): Promise<string> {
  ensureUnzipAvailable()
  const cacheDir = options.cacheDir ?? DEFAULT_KARTVERKET_CACHE_DIR
  const reuseDownload = options.reuseDownload ?? true
  const destination = regionZipCachePath(scope, cacheDir)
  mkdirSync(dirname(destination), { recursive: true })

  if (reuseDownload && existsSync(destination)) {
    console.log(`Gjenbruker cached Kartverket-fil: ${destination}`)
    return destination
  }

  const url = await resolveRegionCsvDownloadUrl(scope)
  if (!url) {
    throw new Error(`Fant ingen Kartverket CSV-URL for ${JSON.stringify(scope)}`)
  }

  console.log(`Laster ned Kartverket Adresse…`)
  console.log(`  URL: ${url}`)
  await downloadFile(url, destination)
  return destination
}

/** Download and import Kartverket CSV for a fylke or kommune (with fylke-zip fallback for kommune). */
export async function downloadAndImportRegionKartverket(
  db: Database.Database,
  scope: { fylke?: string; kommune?: string },
  options: KartverketImportOptions = {},
): Promise<number> {
  if (scope.kommune) {
    const kommune = scope.kommune.padStart(4, '0')
    const kommuneUrl = await resolveRegionCsvDownloadUrl({ kommune })
    if (kommuneUrl) {
      const zipPath = await downloadRegionKartverketCsv(
        { kommune },
        { cacheDir: options.cacheDir, reuseDownload: options.reuseDownload },
      )
      return streamImportKartverketCsvFromZip(db, zipPath, {
        ...options,
        clearExisting: options.clearExisting ?? true,
      })
    }

    const fylke = kommune.slice(0, 2)
    console.log(`Ingen kommune-CSV for ${kommune}, bruker fylke ${fylke}-zip med filter.`)
    const zipPath = await downloadRegionKartverketCsv(
      { fylke },
      { cacheDir: options.cacheDir, reuseDownload: options.reuseDownload },
    )
    return streamImportKartverketCsvFromZip(db, zipPath, {
      ...options,
      clearExisting: options.clearExisting ?? true,
      kommunenummer: kommune,
    })
  }

  if (scope.fylke) {
    const zipPath = await downloadRegionKartverketCsv(
      { fylke: scope.fylke },
      { cacheDir: options.cacheDir, reuseDownload: options.reuseDownload },
    )
    return streamImportKartverketCsvFromZip(db, zipPath, {
      ...options,
      clearExisting: options.clearExisting ?? true,
    })
  }

  throw new Error('downloadAndImportRegionKartverket krever fylke eller kommune')
}

export async function downloadNationalKartverketCsv(
  options: KartverketImportOptions = {},
): Promise<string> {
  ensureUnzipAvailable()
  const cacheDir = options.cacheDir ?? DEFAULT_KARTVERKET_CACHE_DIR
  const reuseDownload = options.reuseDownload ?? true
  mkdirSync(cacheDir, { recursive: true })

  const destination = join(cacheDir, 'Basisdata_0000_Norge_4258_MatrikkelenAdresse_CSV.zip')
  if (reuseDownload && existsSync(destination)) {
    console.log(`Gjenbruker cached Kartverket-fil: ${destination}`)
    return destination
  }

  const url = await resolveNationalCsvDownloadUrl()
  console.log(`Laster ned Kartverket Adresse (hele landet, EPSG:4258)…`)
  console.log(`  URL: ${url}`)
  await downloadFile(url, destination)
  return destination
}

async function streamImportKartverketCsvFromZip(
  db: Database.Database,
  zipPath: string,
  options: KartverketImportOptions = {},
): Promise<number> {
  ensureUnzipAvailable()
  ensureKartverketSchema(db)

  if (options.clearExisting) {
    db.exec('DELETE FROM kartverket_addresses')
  }

  const kommunenummerFilter = options.kommunenummer?.padStart(4, '0')
  if (kommunenummerFilter) {
    console.log(`  Filtrerer import til kommunenummer ${kommunenummerFilter}`)
  }

  const csvEntry = findCsvEntryInZip(zipPath)
  console.log(`Streamer ${csvEntry} fra ${zipPath}…`)

  const unzipProcess = spawn('unzip', ['-p', zipPath, csvEntry], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  if (!unzipProcess.stdout) {
    throw new Error('Kunne ikke åpne CSV-strøm fra zip')
  }

  const rl = createInterface({ input: unzipProcess.stdout, crlfDelay: Infinity })
  let imported = 0
  let header: string[] | null = null
  const insert = db.prepare(`
    INSERT OR REPLACE INTO kartverket_addresses (
      adresse_id, postnummer, adressenavn, nummer, bokstav,
      adresse_tekst, adresse_tekst_norm, lat, lng,
      kommunenummer, matrikkel_key, lookup_key, adressetype
    ) VALUES (
      @adresse_id, @postnummer, @adressenavn, @nummer, @bokstav,
      @adresse_tekst, @adresse_tekst_norm, @lat, @lng,
      @kommunenummer, @matrikkel_key, @lookup_key, @adressetype
    )
  `)

  const insertMany = db.transaction((rows: Array<Record<string, unknown>>) => {
    for (const row of rows) insert.run(row)
  })

  let batch: Array<Record<string, unknown>> = []

  const flush = () => {
    if (batch.length === 0) return
    insertMany(batch)
    imported += batch.length
    batch = []
    if (imported % 100_000 === 0) {
      console.log(`  Importert ${imported.toLocaleString('nb-NO')} Kartverket-adresser…`)
    }
  }

  for await (const rawLine of rl) {
    const line = rawLine.replace(/^\uFEFF/, '')
    if (!line.trim()) continue

    if (!header) {
      header = parseCsvLine(line)
      continue
    }

    const values = parseCsvLine(line)
    const row = rowFromCsv(header, values)
    if (!row) continue
    if (kommunenummerFilter && String(row.kommunenummer) !== kommunenummerFilter) continue
    batch.push(row)
    if (batch.length >= 5000) flush()
  }

  flush()

  const exitCode = await new Promise<number>((resolve, reject) => {
    unzipProcess.on('error', reject)
    unzipProcess.on('close', (code) => resolve(code ?? 1))
  })

  if (exitCode !== 0) {
    throw new Error(`unzip avsluttet med status ${exitCode}`)
  }

  console.log(`  Kartverket-import ferdig: ${imported.toLocaleString('nb-NO')} adresser`)
  return imported
}

function rowFromCsv(header: string[], values: string[]): Record<string, unknown> | null {
  const field = (name: string) => values[header.indexOf(name)] ?? ''
  const lat = parseCoordinate(field('Nord'))
  const lng = parseCoordinate(field('Øst'))
  const postnummer = field('postnummer').trim()
  const adresseTekst = field('adresseTekst').trim()

  if (lat == null || lng == null || !postnummer || !adresseTekst) return null

  const adresseId = field('adresseId').trim() || field('lokalid').trim()
  if (!adresseId) return null

  const kommunenummer = field('kommunenummer').trim()
  const adressenavn = field('adressenavn').trim()
  const nummer = field('nummer').trim()
  const bokstav = field('bokstav').trim()

  return {
    adresse_id: adresseId,
    postnummer,
    adressenavn: adressenavn || null,
    nummer: nummer || null,
    bokstav: bokstav || null,
    adresse_tekst: adresseTekst,
    adresse_tekst_norm: normalizeAddressText(adresseTekst),
    lat,
    lng,
    kommunenummer: kommunenummer || null,
    matrikkel_key: matrikkelKeyFromCsv(
      kommunenummer,
      field('gardsnummer'),
      field('bruksnummer'),
      field('festenummer'),
      field('undernummer'),
    ),
    lookup_key: structuredLookupKey(postnummer, adressenavn, nummer, bokstav),
    adressetype: field('adressetype').trim() || null,
  }
}

export async function downloadAndImportNationalKartverket(
  db: Database.Database,
  options: KartverketImportOptions = {},
): Promise<number> {
  const zipPath = await downloadNationalKartverketCsv(options)
  return streamImportKartverketCsvFromZip(db, zipPath, {
    clearExisting: options.clearExisting ?? true,
  })
}

export function kartverketAddressCount(db: Database.Database): number {
  ensureKartverketSchema(db)
  return (db.prepare('SELECT COUNT(*) AS count FROM kartverket_addresses').get() as { count: number })
    .count
}

export function kartverketBulkAvailable(db: Database.Database): boolean {
  return kartverketAddressCount(db) > 0
}

export function findCachedKartverketZip(cacheDir = DEFAULT_KARTVERKET_CACHE_DIR): string | null {
  const zipPath = join(cacheDir, 'Basisdata_0000_Norge_4258_MatrikkelenAdresse_CSV.zip')
  return existsSync(zipPath) ? zipPath : null
}

/** Import Kartverket CSV from cache zip if present. Returns rows imported (0 if no file). */
export async function importKartverketFromCache(
  db: Database.Database,
  cacheDir = DEFAULT_KARTVERKET_CACHE_DIR,
): Promise<number> {
  const zipPath = findCachedKartverketZip(cacheDir)
  if (!zipPath) return 0
  return streamImportKartverketCsvFromZip(db, zipPath, { clearExisting: false })
}

export function describeKartverketCache(cacheDir = DEFAULT_KARTVERKET_CACHE_DIR): string {
  if (!existsSync(cacheDir)) return `${cacheDir} (tom)`
  const files = readdirSync(cacheDir)
  if (files.length === 0) return `${cacheDir} (tom)`
  return files
    .map((file) => {
      const path = join(cacheDir, file)
      const sizeMb = (statSync(path).size / (1024 * 1024)).toFixed(1)
      return `${path} (${sizeMb} MB)`
    })
    .join(', ')
}

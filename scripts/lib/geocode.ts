import type { BrregAddress } from './types.js'
import type { GeocodeQuality } from './types.js'
import { geocodeGate, fetchWithRetry } from './rate-limit.js'

export interface GeocodeResult {
  lat: number
  lng: number
  adresseId?: string
  matrikkelKey?: string
  kommunenummer?: string
  quality: GeocodeQuality
  method: 'structured' | 'freeText'
}

export function pickAddressLine(lines: string[] | undefined): string | null {
  if (!lines?.length) return null

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^c\/o\s.+/i, '').trim()
    if (line.length > 2 && /\d/.test(line)) return line
  }

  const fallback = lines[lines.length - 1]?.replace(/^c\/o\s.+/i, '').trim()
  return fallback || null
}

export function parseStreetAddress(line: string): { adressenavn: string; nummer: string } | null {
  const cleaned = line.replace(/^c\/o\s.+/i, '').trim()
  const match = cleaned.match(/^(.+?)\s+(\d+\s*[A-Za-zæøåÆØÅ]?)$/)
  if (!match) return null
  return { adressenavn: match[1].trim(), nummer: match[2].replace(/\s+/g, '') }
}

export function addressCacheKey(address: BrregAddress, line: string): string {
  return `${address.postnummer ?? ''}|${line.toLowerCase()}`
}

function matrikkelKeyFromAddress(address: {
  matrikkelnummer?: {
    gardsnummer?: number
    bruksnummer?: number
    festenummer?: number
    seksjonsnummer?: number
    kommunenummer?: string
  }
}): string | undefined {
  const m = address.matrikkelnummer
  if (!m?.gardsnummer && !m?.bruksnummer) return undefined
  const kommune = m.kommunenummer ?? ''
  return `${kommune}|${m.gardsnummer ?? 0}/${m.bruksnummer ?? 0}/${m.festenummer ?? 0}/${m.seksjonsnummer ?? 0}`
}

const GEO_API = 'https://ws.geonorge.no/adresser/v1/sok'

interface GeonorgeAddress {
  representasjonspunkt?: { lat: number; lon: number }
  adresseId?: string | number
  kommunenummer?: string
  matrikkelnummer?: {
    gardsnummer?: number
    bruksnummer?: number
    festenummer?: number
    seksjonsnummer?: number
    kommunenummer?: string
  }
}

async function queryGeonorge(
  params: URLSearchParams,
): Promise<Omit<GeocodeResult, 'quality' | 'method'> | null> {
  params.set(
    'filtrer',
    'adresser.representasjonspunkt,adresser.adressetekst,adresser.kommunenummer,adresser.adresseId,adresser.matrikkelnummer',
  )
  params.set('treffPerSide', '5')

  const response = await geocodeGate.run(() =>
    fetchWithRetry(`${GEO_API}?${params.toString()}`, undefined, 'Kartverket adresse'),
  )

  if (!response.ok) return null

  const data = (await response.json()) as { adresser?: GeonorgeAddress[] }
  const hit = data.adresser?.[0]
  const point = hit?.representasjonspunkt
  if (!point) return null

  return {
    lat: point.lat,
    lng: point.lon,
    adresseId: hit.adresseId != null ? String(hit.adresseId) : undefined,
    kommunenummer: hit.kommunenummer,
    matrikkelKey: hit ? matrikkelKeyFromAddress(hit) : undefined,
  }
}

function classifyQuality(
  method: 'structured' | 'freeText',
  brregKommune: string | null | undefined,
  geoKommune: string | undefined,
): GeocodeQuality {
  if (brregKommune && geoKommune && brregKommune !== geoKommune) return 'mismatch'
  return method === 'structured' ? 'verified' : 'fallback'
}

export async function geocodeAddress(
  address: BrregAddress,
  line: string,
): Promise<GeocodeResult | null> {
  if (!address.postnummer) return null
  if (address.landkode && address.landkode !== 'NO') return null

  const parsed = parseStreetAddress(line)
  if (parsed) {
    const params = new URLSearchParams({
      postnummer: address.postnummer,
      adressenavn: parsed.adressenavn,
      nummer: parsed.nummer,
    })
    const result = await queryGeonorge(params)
    if (result) {
      return {
        ...result,
        method: 'structured',
        quality: classifyQuality('structured', address.kommunenummer, result.kommunenummer),
      }
    }
  }

  const fallbackParams = new URLSearchParams({
    sok: line,
    postnummer: address.postnummer,
  })
  const fallback = await queryGeonorge(fallbackParams)
  if (!fallback) return null

  return {
    ...fallback,
    method: 'freeText',
    quality: classifyQuality('freeText', address.kommunenummer, fallback.kommunenummer),
  }
}

export function jitterCoordinates(
  lat: number,
  lng: number,
  index: number,
  total: number,
): [number, number] {
  if (total <= 1) return [lat, lng]
  const angle = (index / total) * Math.PI * 2
  const radius = 0.00008 * Math.min(total, 8)
  return [lat + Math.cos(angle) * radius, lng + Math.sin(angle) * radius]
}

export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0

  async function next(): Promise<void> {
    while (index < items.length) {
      const current = index++
      results[current] = await worker(items[current])
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()))
  return results
}

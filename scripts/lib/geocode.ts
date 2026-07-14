import type { BrregAddress } from './types.js'
import { geocodeGate, fetchWithRetry } from './rate-limit.js'

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

const GEO_API = 'https://ws.geonorge.no/adresser/v1/sok'

async function queryGeonorge(params: URLSearchParams): Promise<{ lat: number; lng: number } | null> {
  params.set('filtrer', 'adresser.representasjonspunkt,adresser.adressetekst')
  params.set('treffPerSide', '5')

  const response = await geocodeGate.run(() =>
    fetchWithRetry(`${GEO_API}?${params.toString()}`, undefined, 'Kartverket adresse'),
  )

  if (!response.ok) return null

  const data = (await response.json()) as {
    adresser?: Array<{ representasjonspunkt?: { lat: number; lon: number } }>
  }

  const point = data.adresser?.[0]?.representasjonspunkt
  if (!point) return null
  return { lat: point.lat, lng: point.lon }
}

export async function geocodeAddress(
  address: BrregAddress,
  line: string,
): Promise<{ lat: number; lng: number } | null> {
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
    if (result) return result
  }

  const fallbackParams = new URLSearchParams({
    sok: line,
    postnummer: address.postnummer,
  })
  return queryGeonorge(fallbackParams)
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

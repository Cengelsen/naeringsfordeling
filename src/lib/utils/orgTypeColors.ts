import type { ExpressionSpecification } from 'maplibre-gl'

/**
 * Organisasjonsformer ordered by legal similarity (private → corporate →
 * cooperative → housing → voluntary → financial → public). Adjacent entries
 * receive adjacent hues on the colour spectrum.
 */
export const ORG_TYPE_SPECTRUM: readonly string[] = [
  // Individual / personlig næring
  'ENK',
  'PERS',
  'IKJP',
  'TVAM',
  // Personlige selskapsformer
  'ANS',
  'DA',
  'KS',
  'PRE',
  'KTRF',
  // Kapital- og aksjeselskaper
  'AS',
  'ASA',
  'NUF',
  'SE',
  'UTLA',
  'EOFG',
  // Samvirke og delt eierskap
  'SA',
  'BA',
  'SAM',
  'ESEK',
  // Bolig
  'BRL',
  'BBL',
  // Frivillig sektor
  'FLI',
  'STI',
  'KIRK',
  'ANNA',
  // Finansielle foretak
  'SPA',
  'GFS',
  'PK',
  'VPFO',
  // Særskilte og bo
  'SÆR',
  'BO',
  'KBO',
  'OPMV',
  // Underenheter og organisasjonsledd
  'ORGL',
  'BEDR',
  'AAFY',
  'ADOS',
  // Offentlig forvaltning (kommune/fylke)
  'IKS',
  'KF',
  'FKF',
  'KOMM',
  'FYLK',
  // Statlig
  'SF',
  'STAT',
]

const SPECTRUM_HUE_START = 18
const SPECTRUM_HUE_SPAN = 268
const SPECTRUM_SATURATION = 68
const SPECTRUM_LIGHTNESS = 46

const UNKNOWN_TAIL_SLOTS = 8

function hslToHex(h: number, s: number, l: number): string {
  const saturation = s / 100
  const lightness = l / 100
  const chroma = saturation * Math.min(lightness, 1 - lightness)

  const hueToRgb = (offset: number) => {
    const k = (offset + h / 30) % 12
    const channel = lightness - chroma * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * channel)
      .toString(16)
      .padStart(2, '0')
  }

  return `#${hueToRgb(0)}${hueToRgb(8)}${hueToRgb(4)}`
}

function spectrumHue(position: number, span: number): number {
  if (span <= 0) return SPECTRUM_HUE_START + SPECTRUM_HUE_SPAN / 2
  const t = Math.min(1, Math.max(0, position / span))
  return SPECTRUM_HUE_START + t * SPECTRUM_HUE_SPAN
}

/** Stable spectrum position for an org-type code (0 = most individual-like). */
export function spectrumPosition(kode: string): number {
  if (kode === 'MIXED') return ORG_TYPE_SPECTRUM.length + UNKNOWN_TAIL_SLOTS / 2

  const knownIndex = ORG_TYPE_SPECTRUM.indexOf(kode as (typeof ORG_TYPE_SPECTRUM)[number])
  if (knownIndex >= 0) return knownIndex

  let hash = 0
  for (const char of kode) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return ORG_TYPE_SPECTRUM.length + (hash % UNKNOWN_TAIL_SLOTS)
}

export function colorForOrgType(kode: string, _allTypes: string[] = []): string {
  const position = spectrumPosition(kode)
  const span = ORG_TYPE_SPECTRUM.length + UNKNOWN_TAIL_SLOTS - 1
  const hue = spectrumHue(position, span)
  return hslToHex(hue, SPECTRUM_SATURATION, SPECTRUM_LIGHTNESS)
}

/** MapLibre `circle-color` expression keyed on the `orgType` property */
export function orgTypeColorExpression(allTypes: string[]): ExpressionSpecification {
  const uniqueTypes = [...new Set(allTypes)].sort(
    (left, right) => spectrumPosition(left) - spectrumPosition(right),
  )
  const expression: unknown[] = ['match', ['get', 'orgType']]

  for (const kode of uniqueTypes) {
    expression.push(kode, colorForOrgType(kode, uniqueTypes))
  }

  expression.push('#64748b')
  return expression as ExpressionSpecification
}

export function orgTypeLabels(
  types: Array<{ kode: string; label: string; color: string }>,
): Array<{ kode: string; label: string; color: string }> {
  return types.sort((left, right) => spectrumPosition(left.kode) - spectrumPosition(right.kode))
}

const DEFAULT_MIX_COLOR = '#64748b'

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) return null
  const value = Number.parseInt(normalized, 16)
  if (!Number.isFinite(value)) return null
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.min(255, Math.max(0, Math.round(value)))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

/** Count-weighted RGB blend of org-type spectrum colours (used at tile bake time). */
export function mixOrgTypeColors(counts: Iterable<[orgType: string, count: number]>): string {
  let totalR = 0
  let totalG = 0
  let totalB = 0
  let total = 0

  for (const [orgType, count] of counts) {
    if (count <= 0) continue
    const rgb = hexToRgb(colorForOrgType(orgType))
    if (!rgb) continue
    totalR += rgb.r * count
    totalG += rgb.g * count
    totalB += rgb.b * count
    total += count
  }

  if (total === 0) return DEFAULT_MIX_COLOR
  return rgbToHex(totalR / total, totalG / total, totalB / total)
}

export function dominantOrgType(counts: Iterable<[orgType: string, count: number]>): string {
  let bestType = ''
  let bestCount = 0
  for (const [orgType, count] of counts) {
    if (count > bestCount) {
      bestType = orgType
      bestCount = count
    }
  }
  return bestType
}

/** Compact JSON breakdown for aggregate popups (sorted by count, descending). */
export function orgTypeBreakdownJson(counts: Iterable<[orgType: string, count: number]>): string {
  const entries = [...counts]
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
  const breakdown: Record<string, number> = {}
  for (const [orgType, count] of entries) {
    breakdown[orgType] = count
  }
  return JSON.stringify(breakdown)
}

/** MapLibre expression for pre-baked aggregate tile colours. */
export function bakedColorExpression(): ExpressionSpecification {
  return ['coalesce', ['get', 'color'], DEFAULT_MIX_COLOR] as ExpressionSpecification
}

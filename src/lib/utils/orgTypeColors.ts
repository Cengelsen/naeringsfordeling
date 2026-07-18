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

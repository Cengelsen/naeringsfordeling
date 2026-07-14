import type { ColorScheme } from '../types'

const PALETTES: Record<ColorScheme, string[]> = {
  blues: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'],
  oranges: ['#fff5eb', '#fee6ce', '#fdd0a2', '#fdae6b', '#fd8d3c', '#f16913', '#d94801', '#a63603', '#7f2704'],
  greens: ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c', '#00441b'],
  purples: ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8', '#807dba', '#6a51a3', '#54278f', '#3f007d'],
}

export function colorForValue(value: number, max: number, scheme: ColorScheme): string {
  const palette = PALETTES[scheme]
  if (value <= 0 || max <= 0) return '#e8e8e8'
  const index = Math.min(
    palette.length - 1,
    Math.max(0, Math.floor((value / max) * (palette.length - 1))),
  )
  return palette[index]
}

export function legendStops(scheme: ColorScheme): string[] {
  return PALETTES[scheme]
}

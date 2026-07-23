import { colorForOrgType } from '../utils/orgTypeColors'
import type { LocationGroup } from './addressGroups'
import { orgTypeSegments } from './addressGroups'

export interface ColoredSegment {
  orgType: string
  count: number
  fraction: number
  color: string
}

/** Pixel size of generated MapLibre icon (matched to circle diameter via icon-size). */
export const SPLIT_SQUARE_IMAGE_SIZE = 24

const MAX_MATRIX_CELLS = 36

export function coloredSegments(group: LocationGroup, colorTypes: string[]): ColoredSegment[] {
  return orgTypeSegments(group).map((segment) => ({
    ...segment,
    color: colorForOrgType(segment.orgType, colorTypes),
  }))
}

export function colorMixKey(segments: ColoredSegment[]): string {
  return `mix-${segments.map((segment) => `${segment.orgType}:${segment.count}`).join('|')}`
}

/** Parse a `mix-AS:3|ENK:2` key back into colored segments for icon generation. */
export function segmentsFromColorMixKey(key: string, colorTypes: string[]): ColoredSegment[] {
  if (!key.startsWith('mix-')) return []
  const parts = key
    .slice(4)
    .split('|')
    .map((part) => {
      const colon = part.lastIndexOf(':')
      if (colon <= 0) return null
      const orgType = part.slice(0, colon)
      const count = Number(part.slice(colon + 1))
      if (!orgType || !Number.isFinite(count) || count <= 0) return null
      return { orgType, count }
    })
    .filter((entry): entry is { orgType: string; count: number } => entry != null)

  const total = parts.reduce((sum, part) => sum + part.count, 0)
  if (total <= 0) return []

  return parts.map((part) => ({
    orgType: part.orgType,
    count: part.count,
    fraction: part.count / total,
    color: colorForOrgType(part.orgType, colorTypes),
  }))
}

function allocateMatrixCells(segments: ColoredSegment[], cellCount: number): string[] {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0)
  if (total === 0 || cellCount === 0) return []

  const allocations = segments.map((segment) => {
    const exact = (segment.count / total) * cellCount
    const base = Math.floor(exact)
    return {
      color: segment.color,
      count: base,
      remainder: exact - base,
    }
  })

  let assigned = allocations.reduce((sum, entry) => sum + entry.count, 0)
  const byRemainder = allocations
    .map((entry, index) => ({ index, remainder: entry.remainder }))
    .sort((left, right) => right.remainder - left.remainder)

  for (const entry of byRemainder) {
    if (assigned >= cellCount) break
    allocations[entry.index]!.count += 1
    assigned += 1
  }

  const colors: string[] = []
  for (const allocation of allocations) {
    for (let index = 0; index < allocation.count; index++) {
      colors.push(allocation.color)
    }
  }

  return colors
}

function matrixCellColors(segments: ColoredSegment[]): string[] {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0)
  if (total === 0) return []

  if (total <= MAX_MATRIX_CELLS) {
    const colors: string[] = []
    for (const segment of segments) {
      for (let index = 0; index < segment.count; index++) {
        colors.push(segment.color)
      }
    }
    return colors
  }

  return allocateMatrixCells(segments, MAX_MATRIX_CELLS)
}

function matrixDimensions(cellCount: number): { rows: number; cols: number } {
  if (cellCount <= 1) return { rows: 1, cols: 1 }

  let best = { rows: 1, cols: cellCount, waste: cellCount - 1 }
  const maxSide = Math.min(6, Math.ceil(Math.sqrt(cellCount)) + 1)

  for (let cols = 1; cols <= maxSide; cols++) {
    const rows = Math.ceil(cellCount / cols)
    const waste = rows * cols - cellCount
    const aspectPenalty = Math.abs(rows - cols)
    const bestPenalty = Math.abs(best.rows - best.cols)
    if (
      waste < best.waste ||
      (waste === best.waste && aspectPenalty < bestPenalty)
    ) {
      best = { rows, cols, waste }
    }
  }

  return { rows: best.rows, cols: best.cols }
}

export function matrixLayout(segments: ColoredSegment[]): {
  rows: number
  cols: number
  colors: string[]
} {
  const colors = matrixCellColors(segments)
  const { rows, cols } = matrixDimensions(colors.length)
  return { rows, cols, colors }
}

export function drawMatrixSquareCanvas(
  ctx: CanvasRenderingContext2D,
  size: number,
  segments: ColoredSegment[],
) {
  ctx.clearRect(0, 0, size, size)

  const inset = 1
  const inner = size - inset * 2
  const { rows, cols, colors } = matrixLayout(segments)
  const cellWidth = inner / cols
  const cellHeight = inner / rows

  for (let index = 0; index < colors.length; index++) {
    const row = Math.floor(index / cols)
    const col = index % cols
    ctx.fillStyle = colors[index]!
    ctx.fillRect(
      inset + col * cellWidth,
      inset + row * cellHeight,
      cellWidth,
      cellHeight,
    )
  }

  ctx.strokeStyle = '#0f172a'
  ctx.lineWidth = 1
  ctx.strokeRect(inset + 0.5, inset + 0.5, inner - 1, inner - 1)
}

export function createSplitSquareImageData(segments: ColoredSegment[]): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = SPLIT_SQUARE_IMAGE_SIZE
  canvas.height = SPLIT_SQUARE_IMAGE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas ikke tilgjengelig')
  }

  drawMatrixSquareCanvas(ctx, SPLIT_SQUARE_IMAGE_SIZE, segments)
  return ctx.getImageData(0, 0, SPLIT_SQUARE_IMAGE_SIZE, SPLIT_SQUARE_IMAGE_SIZE)
}

export function matrixSquareHtml(
  segments: ColoredSegment[],
  sizePx: number,
  opacity: number,
  title: string,
): string {
  const { rows, cols, colors } = matrixLayout(segments)
  const cells = colors
    .map((color) => `<div class="org-dot-square-cell" style="background:${color}"></div>`)
    .join('')

  return `<div class="org-dot-square-matrix" style="width:${sizePx}px;height:${sizePx}px;opacity:${opacity};grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)" title="${title}">${cells}</div>`
}

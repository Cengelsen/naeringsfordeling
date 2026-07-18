import { colorForOrgType } from '../utils/orgTypeColors'
import type { LocationGroup } from './addressGroups'
import { orgTypeSegments } from './addressGroups'

export interface ColoredSegment {
  orgType: string
  count: number
  fraction: number
  color: string
}

export const SPLIT_SQUARE_IMAGE_SIZE = 48

export function coloredSegments(group: LocationGroup, colorTypes: string[]): ColoredSegment[] {
  return orgTypeSegments(group).map((segment) => ({
    ...segment,
    color: colorForOrgType(segment.orgType, colorTypes),
  }))
}

export function colorMixKey(segments: ColoredSegment[]): string {
  return `mix-${segments.map((segment) => `${segment.orgType}:${segment.count}`).join('|')}`
}

export function conicGradientCss(segments: ColoredSegment[]): string {
  if (segments.length === 1) return segments[0]!.color

  let angle = 0
  const stops: string[] = []
  for (const segment of segments) {
    const start = angle
    angle += segment.fraction * 360
    stops.push(`${segment.color} ${start}deg ${angle}deg`)
  }

  return `conic-gradient(from -90deg, ${stops.join(', ')})`
}

export function drawSplitSquareCanvas(
  ctx: CanvasRenderingContext2D,
  size: number,
  segments: ColoredSegment[],
) {
  ctx.clearRect(0, 0, size, size)

  const inset = 2
  ctx.save()
  ctx.beginPath()
  ctx.rect(inset, inset, size - inset * 2, size - inset * 2)
  ctx.clip()

  const center = size / 2
  const radius = size / 2
  let angle = -Math.PI / 2

  for (const segment of segments) {
    const sweep = segment.fraction * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(center, center)
    ctx.arc(center, center, radius, angle, angle + sweep)
    ctx.closePath()
    ctx.fillStyle = segment.color
    ctx.fill()
    angle += sweep
  }

  ctx.restore()

  ctx.strokeStyle = '#0f172a'
  ctx.lineWidth = 2
  ctx.strokeRect(inset + 0.5, inset + 0.5, size - inset * 2 - 1, size - inset * 2 - 1)
}

export function createSplitSquareImageData(segments: ColoredSegment[]): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = SPLIT_SQUARE_IMAGE_SIZE
  canvas.height = SPLIT_SQUARE_IMAGE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas ikke tilgjengelig')
  }

  drawSplitSquareCanvas(ctx, SPLIT_SQUARE_IMAGE_SIZE, segments)
  return ctx.getImageData(0, 0, SPLIT_SQUARE_IMAGE_SIZE, SPLIT_SQUARE_IMAGE_SIZE)
}

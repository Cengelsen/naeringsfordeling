import { stdout } from 'node:process'
import type { RegionBuildPhase } from './region-build.js'
import type { FylkeBuildPlan } from './region-size-estimate.js'

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  clearLine: '\x1b[2K',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  moveUp: (lines: number) => `\x1b[${lines}A`,
}

export type TaskStatus = 'pending' | 'active' | 'complete' | 'skipped' | 'error'

export interface TaskUpdate {
  label: string
  status: TaskStatus
  phase?: string
  /** 0–1 within current build phase */
  progress?: number
  detail?: string
  targetOrgs?: number
  targetDbBytes?: number
  actualOrgs?: number
  actualDbBytes?: number
}

interface TaskRow extends TaskUpdate {
  startedAt: number
  finishedAt?: number
  buildPhase?: RegionBuildPhase
  buildFraction?: number
}

const PHASE_WEIGHT: Record<RegionBuildPhase, { start: number; end: number }> = {
  starting: { start: 0, end: 0.03 },
  'kartverket-download': { start: 0.03, end: 0.28 },
  'kartverket-import': { start: 0.28, end: 0.58 },
  brreg: { start: 0.58, end: 0.72 },
  geocode: { start: 0.72, end: 0.96 },
  index: { start: 0.96, end: 1 },
  done: { start: 1, end: 1 },
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec > 0 ? `${min}m${sec}s` : `${min}m`
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function progressBar(ratio: number, width = 24): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  const arrow = filled > 0 && filled < width ? '>' : ''
  const equals = '='.repeat(Math.max(0, filled - (arrow ? 1 : 0)))
  const spaces = ' '.repeat(Math.max(0, width - filled))
  return `[${equals}${arrow}${spaces}]`
}

function buildFraction(phase: RegionBuildPhase | undefined, inner?: number): number {
  if (!phase) return 0
  const span = PHASE_WEIGHT[phase]
  if (phase === 'done') return 1
  const t = inner == null ? 0.35 : Math.max(0, Math.min(1, inner))
  return span.start + (span.end - span.start) * t
}

function formatGoal(actual: number | undefined, target: number | undefined, formatter: (n: number) => string): string {
  if (target != null && target > 0) {
    const actualText = actual != null ? formatter(actual) : '–'
    return `${actualText} / ${formatter(target)}`
  }
  if (actual != null) return formatter(actual)
  return ''
}

export class FylkeBuildDashboard {
  private readonly tasks = new Map<string, TaskRow>()
  private readonly order: string[] = []
  private readonly plans = new Map<string, FylkeBuildPlan>()
  private lineCount = 0
  private readonly interactive: boolean
  private title = ''
  private sizingMessage = ''
  private overallLabel = 'Overall'

  constructor() {
    this.interactive = stdout.isTTY === true
  }

  setPlans(plans: FylkeBuildPlan[]) {
    for (const plan of plans) {
      this.plans.set(plan.code, plan)
    }
  }

  beginSizing(message: string) {
    this.title = message
    this.sizingMessage = message
    if (this.interactive) stdout.write(ANSI.hideCursor)
    this.render()
  }

  beginBuild(title: string, items: Array<{ id: string; label: string }>) {
    this.clearRenderedBlock()
    this.title = title
    this.sizingMessage = ''
    for (const item of items) {
      this.order.push(item.id)
      const plan = this.plans.get(item.id)
      this.tasks.set(item.id, {
        label: item.label,
        status: 'pending',
        phase: 'Waiting',
        startedAt: Date.now(),
        targetOrgs: plan?.estimatedOrgs,
        targetDbBytes: plan?.estimatedDbBytes,
      })
    }
    this.render()
  }

  update(id: string, patch: Partial<TaskUpdate> & { buildPhase?: RegionBuildPhase; buildFraction?: number }) {
    const existing = this.tasks.get(id)
    if (!existing) return

    const next: TaskRow = {
      ...existing,
      ...patch,
      startedAt:
        patch.status === 'active' && existing.status === 'pending'
          ? Date.now()
          : existing.startedAt,
    }
    if (
      (patch.status === 'complete' || patch.status === 'skipped' || patch.status === 'error') &&
      next.finishedAt == null
    ) {
      next.finishedAt = Date.now()
    } else if (existing.finishedAt != null) {
      next.finishedAt = existing.finishedAt
    }
    if (patch.buildPhase != null) next.buildPhase = patch.buildPhase
    if (patch.buildFraction != null) next.buildFraction = patch.buildFraction
    this.tasks.set(id, next)
    this.render()
  }

  finish() {
    this.render()
    if (this.interactive) {
      stdout.write(ANSI.showCursor)
      stdout.write('\n')
    }
    this.lineCount = 0
  }

  private clearRenderedBlock() {
    if (!this.interactive || this.lineCount === 0) return
    stdout.write(ANSI.moveUp(this.lineCount))
    for (let i = 0; i < this.lineCount; i += 1) {
      stdout.write(`${ANSI.clearLine}\n`)
    }
    stdout.write(ANSI.moveUp(this.lineCount))
    this.lineCount = 0
  }

  private overallProgress(): {
    fraction: number
    completed: number
    total: number
    dbBytesDone: number
    dbBytesGoal: number
    orgsDone: number
    orgsGoal: number
  } {
    const total = this.order.length
    let completed = 0
    let weighted = 0
    let weightSum = 0
    let dbBytesDone = 0
    let dbBytesGoal = 0
    let orgsDone = 0
    let orgsGoal = 0

    for (const id of this.order) {
      const task = this.tasks.get(id)!
      const plan = this.plans.get(id)
      const weight = plan?.estimatedDbBytes > 0 ? plan.estimatedDbBytes : 1
      weightSum += weight
      orgsGoal += task.targetOrgs ?? plan?.estimatedOrgs ?? 0
      dbBytesGoal += task.targetDbBytes ?? plan?.estimatedDbBytes ?? 0

      if (task.status === 'complete' || task.status === 'skipped') {
        completed += 1
        weighted += weight
        orgsDone += task.actualOrgs ?? task.targetOrgs ?? plan?.estimatedOrgs ?? 0
        dbBytesDone += task.actualDbBytes ?? task.targetDbBytes ?? plan?.estimatedDbBytes ?? 0
      } else if (task.status === 'error') {
        weighted += weight * 0
      } else if (task.status === 'active') {
        const frac = buildFraction(task.buildPhase, task.buildFraction ?? task.progress)
        weighted += weight * frac
        orgsDone += Math.round((task.targetOrgs ?? plan?.estimatedOrgs ?? 0) * frac)
        dbBytesDone += Math.round((task.targetDbBytes ?? plan?.estimatedDbBytes ?? 0) * frac)
      }
    }

    const fraction = weightSum > 0 ? weighted / weightSum : completed / Math.max(total, 1)
    return { fraction, completed, total, dbBytesDone, dbBytesGoal, orgsDone, orgsGoal }
  }

  private formatTaskLine(id: string): string {
    const task = this.tasks.get(id)!
    const plan = this.plans.get(id)
    const code = id.padStart(2, ' ')
    const name = task.label.padEnd(18).slice(0, 18)
    const endAt = task.finishedAt ?? Date.now()
    const elapsed = formatDuration(endAt - task.startedAt)

    const targetOrgs = task.targetOrgs ?? plan?.estimatedOrgs
    const targetDb = task.targetDbBytes ?? plan?.estimatedDbBytes
    const sizeGoal = formatGoal(task.actualDbBytes, targetDb, formatBytes)
    const orgGoal = formatGoal(task.actualOrgs, targetOrgs, (n) => n.toLocaleString('nb-NO'))

    let statusPart: string
    if (task.status === 'complete') {
      statusPart = `${ANSI.green}Done${ANSI.reset}`
      const parts = [orgGoal, sizeGoal].filter(Boolean)
      if (parts.length > 0) statusPart += ` ${ANSI.dim}${parts.join(' · ')}${ANSI.reset}`
    } else if (task.status === 'skipped') {
      statusPart = `${ANSI.dim}Skipped${ANSI.reset}`
    } else if (task.status === 'error') {
      statusPart = `${ANSI.red}Error${ANSI.reset}`
      if (task.detail) statusPart += ` ${ANSI.dim}${task.detail.slice(0, 40)}${ANSI.reset}`
    } else if (task.status === 'pending') {
      const parts = [
        targetOrgs != null ? `${targetOrgs.toLocaleString('nb-NO')} org` : '',
        targetDb != null ? formatBytes(targetDb) : '',
      ].filter(Boolean)
      statusPart = `${ANSI.dim}Waiting${parts.length ? ` · est. ${parts.join(' · ')}` : ''}${ANSI.reset}`
    } else {
      const phase = task.phase ?? 'Working'
      const bar =
        task.progress != null
          ? ` ${progressBar(task.progress, 14)} ${String(Math.round(task.progress * 100)).padStart(3, ' ')}%`
          : ''
      const detail =
        task.detail != null && task.detail.length > 0
          ? ` ${ANSI.dim}${task.detail.slice(0, 72)}${ANSI.reset}`
          : ''
      statusPart = `${ANSI.cyan}${phase}${ANSI.reset}${bar}${detail}`
    }

    return `${code} ${name} ${statusPart} ${ANSI.dim}${elapsed.padStart(6, ' ')}${ANSI.reset}`
  }

  private render() {
    const lines: string[] = []

    if (this.title) {
      lines.push(`${ANSI.bold}${this.title}${ANSI.reset}`)
    }

    if (this.sizingMessage) {
      lines.push(`${ANSI.cyan}Sizing${ANSI.reset} ${ANSI.dim}${this.sizingMessage}${ANSI.reset}`)
    } else if (this.order.length > 0) {
      const overall = this.overallProgress()
      const bar = progressBar(overall.fraction, 28)
      const fylker = `${overall.completed}/${overall.total} fylker`
      const db =
        overall.dbBytesGoal > 0
          ? `${formatBytes(overall.dbBytesDone)} / ${formatBytes(overall.dbBytesGoal)}`
          : ''
      const orgs =
        overall.orgsGoal > 0
          ? `${overall.orgsDone.toLocaleString('nb-NO')} / ${overall.orgsGoal.toLocaleString('nb-NO')} org`
          : ''
      const metrics = [fylker, db, orgs].filter(Boolean).join(' · ')
      lines.push(
        `${this.overallLabel} ${bar} ${String(Math.round(overall.fraction * 100)).padStart(3, ' ')}% ${ANSI.dim}${metrics}${ANSI.reset}`,
      )
      lines.push('')
      for (const id of this.order) {
        lines.push(this.formatTaskLine(id))
      }
    }

    if (!this.interactive) return

    if (this.lineCount > 0) {
      stdout.write(ANSI.moveUp(this.lineCount))
    }
    for (const line of lines) {
      stdout.write(`${ANSI.clearLine}${line}\n`)
    }
    this.lineCount = lines.length
  }
}

/** @deprecated Use FylkeBuildDashboard */
export class ParallelTaskBoard {
  private readonly dashboard = new FylkeBuildDashboard()

  constructor(private readonly title?: string) {}

  init(items: Array<{ id: string; label: string }>) {
    if (this.title) this.dashboard.beginBuild(this.title, items)
    else this.dashboard.beginBuild('', items)
  }

  update(id: string, patch: Partial<TaskUpdate>) {
    this.dashboard.update(id, patch)
  }

  complete() {
    this.dashboard.finish()
  }
}

export function formatByteProgress(received: number, total: number): string {
  if (total > 0) return `${formatBytes(received)} / ${formatBytes(total)}`
  return formatBytes(received)
}

export function formatCountProgress(done: number, total: number): string {
  return `${done.toLocaleString('nb-NO')} / ${total.toLocaleString('nb-NO')}`
}

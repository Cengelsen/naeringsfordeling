#!/usr/bin/env node
/**
 * Build all fylke databases in parallel (from referansecache) and merge into one national DB.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_REGIONS_DIR,
  defaultRegionOutputPath,
  kartverketCacheDirForReference,
  listAllFylker,
  resolveReferenceCacheDir,
  type RegionBuildPhase,
  type RegionDescriptor,
} from './lib/region-build.js'
import { mergeRegionDatabases } from './lib/merge-region-databases.js'
import { removeDatabaseFiles } from './lib/db.js'
import { DEFAULT_NATIONAL_DB_PATH } from './lib/national-db-slice.js'
import { ensureBrregReferenceCache } from './lib/reference-cache.js'
import { FylkeBuildDashboard } from './lib/parallel-progress.js'
import {
  consumeRegionBuildProgressChunk,
  type RegionBuildIpcMessage,
} from './lib/region-build-ipc.js'
import {
  dbFileSize,
  estimateFylkeBuildPlans,
  type FylkeBuildPlan,
} from './lib/region-size-estimate.js'

const REPO_ROOT = join(fileURLToPath(new URL('..', import.meta.url)))

const PHASE_LABELS: Record<RegionBuildPhase, string> = {
  starting: 'Preparing',
  'kartverket-download': 'Downloading',
  'kartverket-import': 'Extracting',
  brreg: 'Importing BRREG',
  geocode: 'Geocoding',
  index: 'Finalizing',
  done: 'Complete',
}

function parseArgs(argv: string[]) {
  const outputArg = argv.find((arg) => arg.startsWith('--output='))?.split('=')[1]
  const cacheDirArg = argv.find((arg) => arg.startsWith('--cache-dir='))?.split('=')[1]
  const regionsDirArg = argv.find((arg) => arg.startsWith('--regions-dir='))?.split('=')[1]
  const jobsArg = argv.find((arg) => arg.startsWith('--jobs='))?.split('=')[1]
  const refreshDownloads = argv.includes('--refresh-downloads')

  return {
    output: outputArg ?? process.env.DATABASE_PATH ?? process.env.NATIONAL_DB_PATH ?? DEFAULT_NATIONAL_DB_PATH,
    referenceCacheDir: cacheDirArg,
    regionsDir: regionsDirArg ?? DEFAULT_REGIONS_DIR,
    jobs: Number(jobsArg ?? process.env.FYLKE_BUILD_JOBS ?? '15'),
    fresh: argv.includes('--fresh'),
    mergeOnly: argv.includes('--merge-only'),
    buildOnly: argv.includes('--build-only'),
    skipExisting: argv.includes('--skip-existing'),
    skipUnderenheter: argv.includes('--skip-underenheter'),
    skipGeocode: argv.includes('--skip-geocode'),
    refreshDownloads,
    reuseDownloads: !refreshDownloads,
    verbose: argv.includes('--verbose'),
  }
}

function runBuildRegionDb(args: string[], options: { inheritOutput?: boolean } = {}): Promise<void> {
  const tsxPath = join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
  const scriptPath = join(REPO_ROOT, 'scripts', 'build-region-db.ts')

  return new Promise((resolve, reject) => {
    const child = spawn(tsxPath, [scriptPath, ...args], {
      cwd: REPO_ROOT,
      stdio: options.inheritOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`build-region-db avsluttet med status ${code ?? 1}`))
    })
  })
}

function runBuildRegionDbWithProgress(
  args: string[],
  onMessage: (message: RegionBuildIpcMessage) => void,
): Promise<void> {
  const tsxPath = join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
  const scriptPath = join(REPO_ROOT, 'scripts', 'build-region-db.ts')

  return new Promise((resolve, reject) => {
    let stderr = ''
    const child = spawn(tsxPath, [scriptPath, ...args, '--report-progress'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    child.on('error', reject)

    child.stdout?.on('data', (chunk) => {
      consumeRegionBuildProgressChunk(chunk.toString(), onMessage)
    })

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const detail = stderr.trim().split('\n').pop() ?? `status ${code ?? 1}`
      reject(new Error(detail))
    })
  })
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const limit = Math.max(1, Math.min(concurrency, items.length))
  let nextIndex = 0

  async function runWorker() {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) break
      await worker(items[index]!, index)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()))
}

function buildRegionChildArgs(
  region: RegionDescriptor,
  outputPath: string,
  referenceCacheDir: string,
  options: ReturnType<typeof parseArgs>,
  plan: FylkeBuildPlan | undefined,
  sizing: { nationalEnheterRows: number; nationalUnderenheterRows: number },
): string[] {
  const buildArgs = [
    `--fylke=${region.code}`,
    `--output=${outputPath}`,
    `--cache-dir=${referenceCacheDir}`,
    '--from-cache',
  ]
  if (options.fresh) buildArgs.push('--fresh')
  if (options.skipUnderenheter) buildArgs.push('--skip-underenheter')
  if (options.skipGeocode) buildArgs.push('--skip-geocode')
  if (options.refreshDownloads) buildArgs.push('--refresh-downloads')
  if (plan?.estimatedOrgs != null) {
    buildArgs.push(`--estimated-brreg-orgs=${plan.estimatedOrgs}`)
  }
  if (sizing.nationalEnheterRows > 0) {
    buildArgs.push(`--national-brreg-enheter-rows=${sizing.nationalEnheterRows}`)
  }
  if (!options.skipUnderenheter && sizing.nationalUnderenheterRows > 0) {
    buildArgs.push(`--national-brreg-underenheter-rows=${sizing.nationalUnderenheterRows}`)
  }
  return buildArgs
}

async function buildFylkerInParallel(
  regions: RegionDescriptor[],
  options: ReturnType<typeof parseArgs>,
  referenceCacheDir: string,
) {
  const kartverketCacheDir = kartverketCacheDirForReference(referenceCacheDir)
  const dashboard = new FylkeBuildDashboard()

  dashboard.beginSizing('Scanning BRREG cache and Kartverket zip sizes…')
  const sizing = await estimateFylkeBuildPlans(regions, referenceCacheDir, {
    kartverketCacheDir,
    reuseDownloads: options.reuseDownloads,
    skipUnderenheter: options.skipUnderenheter,
  })
  const plans = sizing.plans
  dashboard.setPlans(plans)

  dashboard.beginBuild(
    `Building ${regions.length} fylke databases (${options.jobs} parallel processes)`,
    regions.map((region) => ({ id: region.code, label: region.name })),
  )

  let built = 0
  let skipped = 0
  let failed = 0

  await runPool(regions, options.jobs, async (region) => {
    const outputPath = defaultRegionOutputPath(region, options.regionsDir)
    const plan = plans.find((row) => row.code === region.code)

    if (options.skipExisting && existsSync(outputPath) && !options.fresh) {
      dashboard.update(region.code, {
        label: region.name,
        status: 'skipped',
        actualOrgs: plan?.estimatedOrgs,
        actualDbBytes: dbFileSize(outputPath),
        targetOrgs: plan?.estimatedOrgs,
        targetDbBytes: plan?.estimatedDbBytes,
      })
      skipped += 1
      return
    }

    dashboard.update(region.code, {
      label: region.name,
      status: 'active',
      phase: 'Preparing',
      buildPhase: 'starting',
      buildFraction: 0,
      targetOrgs: plan?.estimatedOrgs,
      targetDbBytes: plan?.estimatedDbBytes,
    })

    const childArgs = buildRegionChildArgs(
      region,
      outputPath,
      referenceCacheDir,
      options,
      plan,
      sizing,
    )

    try {
      await runBuildRegionDbWithProgress(childArgs, (message) => {
        if (message.type === 'progress') {
          dashboard.update(region.code, {
            label: region.name,
            status: 'active',
            phase: message.displayPhase ?? PHASE_LABELS[message.phase],
            progress: message.progress,
            detail: message.detail,
            buildPhase: message.phase,
            buildFraction: message.progress,
            targetOrgs: plan?.estimatedOrgs,
            targetDbBytes: plan?.estimatedDbBytes,
          })
          return
        }

        if (message.type === 'done') {
          dashboard.update(region.code, {
            label: region.name,
            status: 'complete',
            phase: 'Done',
            actualOrgs: message.orgTotal,
            actualDbBytes: dbFileSize(message.outputPath),
            targetOrgs: plan?.estimatedOrgs,
            targetDbBytes: plan?.estimatedDbBytes,
            buildPhase: 'done',
            buildFraction: 1,
          })
        }
      })
      built += 1
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : String(error)
      dashboard.update(region.code, {
        label: region.name,
        status: 'error',
        detail: message.split('\n')[0]?.slice(0, 60),
        targetOrgs: plan?.estimatedOrgs,
        targetDbBytes: plan?.estimatedDbBytes,
      })
    }
  })

  dashboard.finish()

  console.log('\nFylke-bygg oppsummert:')
  console.log(`  Bygget: ${built.toLocaleString('nb-NO')}`)
  console.log(`  Hoppet over: ${skipped.toLocaleString('nb-NO')}`)
  console.log(`  Feilet: ${failed.toLocaleString('nb-NO')}`)

  if (failed > 0) {
    throw new Error(`${failed} fylke-bygg feilet. Fletting hoppet over.`)
  }
}

async function buildFylkerVerbose(
  regions: RegionDescriptor[],
  options: ReturnType<typeof parseArgs>,
  referenceCacheDir: string,
) {
  console.log(
    `Bygger ${regions.length.toLocaleString('nb-NO')} fylkesdatabaser parallelt (${options.jobs} jobber)…`,
  )

  let built = 0
  let skipped = 0
  let failed = 0

  await runPool(regions, options.jobs, async (region, index) => {
    const outputPath = defaultRegionOutputPath(region, options.regionsDir)
    const label = `fylke ${region.code} ${region.name}`

    if (options.skipExisting && existsSync(outputPath) && !options.fresh) {
      console.log(`[${index + 1}/${regions.length}] Hopper over ${label} (finnes)`)
      skipped += 1
      return
    }

    console.log(`[${index + 1}/${regions.length}] Starter ${label}`)

    const buildArgs = [
      `--fylke=${region.code}`,
      `--output=${outputPath}`,
      `--cache-dir=${referenceCacheDir}`,
      '--from-cache',
    ]
    if (options.fresh) buildArgs.push('--fresh')
    if (options.skipUnderenheter) buildArgs.push('--skip-underenheter')
    if (options.skipGeocode) buildArgs.push('--skip-geocode')
    if (options.refreshDownloads) buildArgs.push('--refresh-downloads')

    try {
      await runBuildRegionDb(buildArgs, { inheritOutput: true })
      built += 1
      console.log(`[${index + 1}/${regions.length}] Ferdig ${label}`)
    } catch (error) {
      failed += 1
      console.error(`[${index + 1}/${regions.length}] Feilet ${label}:`, error)
    }
  })

  console.log('\nFylke-bygg oppsummert:')
  console.log(`  Bygget: ${built.toLocaleString('nb-NO')}`)
  console.log(`  Hoppet over: ${skipped.toLocaleString('nb-NO')}`)
  console.log(`  Feilet: ${failed.toLocaleString('nb-NO')}`)

  if (failed > 0) {
    throw new Error(`${failed} fylke-bygg feilet. Fletting hoppet over.`)
  }
}

function mergePlansFromPaths(regions: RegionDescriptor[], paths: string[]): FylkeBuildPlan[] {
  return regions.map((region, index) => {
    const bytes = dbFileSize(paths[index] ?? '')
    return {
      code: region.code,
      name: region.name,
      kartverketZipBytes: 0,
      estimatedOrgs: 0,
      estimatedDbBytes: bytes > 0 ? bytes : 1,
    }
  })
}

async function mergeWithProgress(
  outputPath: string,
  regions: RegionDescriptor[],
  fylkePaths: string[],
) {
  const dashboard = new FylkeBuildDashboard()
  const plans = mergePlansFromPaths(regions, fylkePaths)
  dashboard.setPlans(plans)
  dashboard.beginBuild(`Merging ${regions.length} fylke databases`, regions.map((r) => ({
    id: r.code,
    label: r.name,
  })))

  if (regions[0]) {
    dashboard.update(regions[0].code, {
      label: regions[0].name,
      status: 'active',
      phase: 'Merging',
      buildPhase: 'starting',
      buildFraction: 0,
      targetDbBytes: plans[0]?.estimatedDbBytes,
    })
  }

  const summary = mergeRegionDatabases(outputPath, fylkePaths, {
    clearTarget: true,
    quiet: true,
    onSourceMerged: ({ index, result }) => {
      const region = regions[index]
      if (!region) return
      const plan = plans[index]

      dashboard.update(region.code, {
        label: region.name,
        status: 'complete',
        actualOrgs: result.organizations,
        actualDbBytes: plan?.estimatedDbBytes,
        targetDbBytes: plan?.estimatedDbBytes,
        buildPhase: 'done',
        buildFraction: 1,
      })

      const next = regions[index + 1]
      if (next) {
        dashboard.update(next.code, {
          label: next.name,
          status: 'active',
          phase: 'Merging',
          buildPhase: 'brreg',
          buildFraction: (index + 1) / regions.length,
          targetDbBytes: plans[index + 1]?.estimatedDbBytes,
        })
      }
    },
  })

  dashboard.finish()
  return summary
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const referenceCacheDir = resolveReferenceCacheDir({ referenceCacheDir: args.referenceCacheDir })

  if (!args.mergeOnly) {
    console.log('Sikrer BRREG referansecache (nedlasting ved behov)…')
    await ensureBrregReferenceCache(referenceCacheDir, {
      reuseDownloads: args.reuseDownloads,
      refreshDownloads: args.refreshDownloads,
      skipUnderenheter: args.skipUnderenheter,
    })
  }

  const regions = await listAllFylker(referenceCacheDir, { localOnly: true, currentOnly: true })
  const fylkePaths = regions.map((region) => defaultRegionOutputPath(region, args.regionsDir))

  console.log('Nasjonal database fra parallelle fylke-bygg')
  console.log(`  Output: ${args.output}`)
  console.log(`  Fylker: ${regions.length.toLocaleString('nb-NO')}`)
  console.log(`  Regionsdir: ${args.regionsDir}`)
  console.log(`  Referansecache: ${referenceCacheDir}`)
  console.log(`  Parallellitet: ${args.jobs}`)
  if (args.verbose) console.log('  Modus: verbose (full underprosess-logg)')

  if (!args.mergeOnly) {
    if (args.verbose) {
      await buildFylkerVerbose(regions, args, referenceCacheDir)
    } else {
      await buildFylkerInParallel(regions, args, referenceCacheDir)
    }
  }

  if (args.buildOnly) {
    console.log('\n--build-only: hopper over fletting.')
    return
  }

  const missing = fylkePaths.filter((path) => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(
      `[${missing.length}] fylkesdatabase(r) mangler før fletting. Kjør uten --merge-only først.\n${missing.join('\n')}`,
    )
  }

  if (args.fresh && existsSync(args.output)) {
    console.log(`\nSletter eksisterende nasjonal database: ${args.output}`)
    removeDatabaseFiles(args.output)
  }

  const summary = args.verbose
    ? await (async () => {
        console.log('\nFletter fylkesdatabaser til nasjonal SQLite…')
        return mergeRegionDatabases(args.output, fylkePaths, { clearTarget: true })
      })()
    : await mergeWithProgress(args.output, regions, fylkePaths)

  const totalOrgs = summary.sources.reduce((sum, row) => sum + row.organizations, 0)
  const totalKv = summary.sources.reduce((sum, row) => sum + row.kartverket, 0)

  console.log('\nFletting ferdig:')
  console.log(`  Output: ${args.output}`)
  console.log(`  Kilder: ${summary.sources.length.toLocaleString('nb-NO')}`)
  console.log(`  Organisasjoner (sum per fylke): ${totalOrgs.toLocaleString('nb-NO')}`)
  console.log(`  Kartverket-rader (sum per fylke): ${totalKv.toLocaleString('nb-NO')}`)
  if (summary.clearedOrphans > 0) {
    console.log(
      `  Foreldreløse overordnet_enhet nullstilt: ${summary.clearedOrphans.toLocaleString('nb-NO')}`,
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

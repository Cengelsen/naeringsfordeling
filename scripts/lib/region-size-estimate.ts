import { existsSync, statSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import type { RegionDescriptor } from './region-build.js'
import {
  BRREG_ENHETER_FILE,
  BRREG_UNDERENHETER_FILE,
  referencePath,
} from './reference-cache.js'
import { entityKommunenummer } from './organizations.js'
import type { BrregEntity, BrregUnderenhet } from './types.js'
import { estimateFylkeZipBytes, regionZipCachePath } from './kartverket-bulk.js'

export interface FylkeBuildPlan {
  code: string
  name: string
  kartverketZipBytes: number
  estimatedOrgs: number
  /** Rough expected on-disk DB size for progress weighting. */
  estimatedDbBytes: number
}

const BYTES_PER_ORG_ESTIMATE = 1800

async function streamJsonGzipCountByFylke(gzipPath: string): Promise<{
  byFylke: Map<string, number>
  total: number
}> {
  const { chain } = await import('stream-chain')
  const { parser } = await import('stream-json')
  const { streamArray } = await import('stream-json/streamers/stream-array.js')
  const { createGunzip } = await import('node:zlib')

  const byFylke = new Map<string, number>()
  let total = 0
  const jsonPipeline = chain([createReadStream(gzipPath), createGunzip(), parser(), streamArray()])

  for await (const chunk of jsonPipeline) {
    total += 1
    const entity = (chunk as { value: BrregEntity | BrregUnderenhet }).value
    const kommune = entityKommunenummer(entity)
    if (!kommune) continue
    const fylke = kommune.slice(0, 2)
    byFylke.set(fylke, (byFylke.get(fylke) ?? 0) + 1)
  }

  return { byFylke, total }
}

export interface FylkeSizingResult {
  plans: FylkeBuildPlan[]
  nationalEnheterRows: number
  nationalUnderenheterRows: number
}

export async function estimateFylkeBuildPlans(
  regions: RegionDescriptor[],
  referenceCacheDir: string,
  options: {
    kartverketCacheDir: string
    reuseDownloads?: boolean
    skipUnderenheter?: boolean
  },
): Promise<FylkeSizingResult> {
  const enheterPath = referencePath(referenceCacheDir, BRREG_ENHETER_FILE)
  if (!existsSync(enheterPath)) {
    throw new Error(`Mangler lokal BRREG enheter-fil: ${enheterPath}`)
  }

  const enheterCounts = await streamJsonGzipCountByFylke(enheterPath)

  let underCounts = { byFylke: new Map<string, number>(), total: 0 }
  if (!options.skipUnderenheter) {
    const underPath = referencePath(referenceCacheDir, BRREG_UNDERENHETER_FILE)
    if (existsSync(underPath)) {
      underCounts = await streamJsonGzipCountByFylke(underPath)
    }
  }

  const zipSizes = await Promise.all(
    regions.map(async (region) =>
      estimateFylkeZipBytes(region.code, options.kartverketCacheDir, {
        reuseDownload: options.reuseDownloads ?? true,
      }),
    ),
  )

  const plans = regions.map((region, index) => {
    const kartverketZipBytes = zipSizes[index] ?? 0
    const estimatedOrgs =
      (enheterCounts.byFylke.get(region.code) ?? 0) + (underCounts.byFylke.get(region.code) ?? 0)
    const estimatedDbBytes = Math.round(
      kartverketZipBytes * 1.35 + estimatedOrgs * BYTES_PER_ORG_ESTIMATE,
    )

    return {
      code: region.code,
      name: region.name,
      kartverketZipBytes,
      estimatedOrgs,
      estimatedDbBytes,
    }
  })

  return {
    plans,
    nationalEnheterRows: enheterCounts.total,
    nationalUnderenheterRows: underCounts.total,
  }
}

export function dbFileSize(path: string): number {
  if (!existsSync(path)) return 0
  return statSync(path).size
}

export function sumPlanGoals(plans: FylkeBuildPlan[]): {
  totalZipBytes: number
  totalOrgs: number
  totalDbBytes: number
} {
  return {
    totalZipBytes: plans.reduce((sum, plan) => sum + plan.kartverketZipBytes, 0),
    totalOrgs: plans.reduce((sum, plan) => sum + plan.estimatedOrgs, 0),
    totalDbBytes: plans.reduce((sum, plan) => sum + plan.estimatedDbBytes, 0),
  }
}

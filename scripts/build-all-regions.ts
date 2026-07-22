#!/usr/bin/env node
import { existsSync } from 'node:fs'
import {
  buildRegionDatabase,
  defaultRegionOutputPath,
  listAllFylker,
  listAllKommuner,
  regionLabel,
  resolveReferenceCacheDir,
} from './lib/region-build.js'

function parseArgs(argv: string[]) {
  const fylke = argv.find((arg) => arg.startsWith('--fylke='))?.split('=')[1]
  const cacheDir = argv.find((arg) => arg.startsWith('--cache-dir='))?.split('=')[1]
  const nationalDb = argv.find((arg) => arg.startsWith('--national-db='))?.split('=')[1]
  const limit = Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] ?? '0')
  const refreshDownloads = argv.includes('--refresh-downloads')

  let sourceMode: 'auto' | 'cache' | 'national' = 'auto'
  if (argv.includes('--from-cache')) sourceMode = 'cache'
  if (argv.includes('--from-national')) sourceMode = 'national'

  return {
    fylker: argv.includes('--fylker'),
    kommuner: argv.includes('--kommuner'),
    fylke,
    referenceCacheDir: cacheDir,
    nationalDbPath: nationalDb,
    sourceMode,
    limit: limit > 0 ? limit : undefined,
    fresh: argv.includes('--fresh'),
    skipExisting: argv.includes('--skip-existing'),
    skipKartverket: argv.includes('--skip-kartverket'),
    skipBrreg: argv.includes('--skip-brreg'),
    skipGeocode: argv.includes('--skip-geocode'),
    skipUnderenheter: argv.includes('--skip-underenheter'),
    refreshDownloads,
    reuseDownloads: !refreshDownloads,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const referenceCacheDir = resolveReferenceCacheDir({ referenceCacheDir: args.referenceCacheDir })

  if (args.fylker === args.kommuner) {
    throw new Error('Angi nøyaktig ett av --fylker eller --kommuner.')
  }

  let regions = args.fylker
    ? await listAllFylker(referenceCacheDir, {
        localOnly: true,
        nationalDbPath: args.nationalDbPath,
      })
    : await listAllKommuner(referenceCacheDir, {
        localOnly: true,
        nationalDbPath: args.nationalDbPath,
      })

  if (args.fylke) {
    const code = args.fylke.padStart(2, '0').slice(0, 2)
    regions = regions.filter((r) => r.code.startsWith(code))
    if (regions.length === 0) {
      throw new Error(`Ingen regioner funnet for fylke ${code}.`)
    }
  }

  if (args.limit != null) {
    regions = regions.slice(0, args.limit)
  }

  console.log(
    `Bygger ${regions.length.toLocaleString('nb-NO')} ${args.fylker ? 'fylkes' : 'kommune'}-databaser…`,
  )

  let built = 0
  let skipped = 0
  let failed = 0

  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index]
    const outputPath = defaultRegionOutputPath(region)

    console.log(`\n[${index + 1}/${regions.length}] ${regionLabel(region)}`)

    if (args.skipExisting && existsSync(outputPath) && !args.fresh) {
      console.log(`  Hopper over (finnes): ${outputPath}`)
      skipped += 1
      continue
    }

    try {
      await buildRegionDatabase({
        fylke: region.kind === 'fylke' ? region.code : undefined,
        kommune: region.kind === 'kommune' ? region.code : undefined,
        outputPath,
        fresh: args.fresh,
        skipKartverket: args.skipKartverket,
        skipBrreg: args.skipBrreg,
        skipGeocode: args.skipGeocode,
        skipUnderenheter: args.skipUnderenheter,
        reuseDownloads: args.reuseDownloads,
        refreshDownloads: args.refreshDownloads,
        referenceCacheDir,
        nationalDbPath: args.nationalDbPath,
        sourceMode: args.sourceMode,
      })
      built += 1
    } catch (error) {
      failed += 1
      console.error(`  Feilet for ${regionLabel(region)}:`, error)
    }
  }

  console.log('\nOppsummering:')
  console.log(`  Bygget: ${built.toLocaleString('nb-NO')}`)
  console.log(`  Hoppet over: ${skipped.toLocaleString('nb-NO')}`)
  console.log(`  Feilet: ${failed.toLocaleString('nb-NO')}`)

  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

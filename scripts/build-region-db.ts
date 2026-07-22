#!/usr/bin/env node
import {
  resolveRegionDescriptor,
  defaultRegionOutputPath,
  buildRegionDatabase,
  resolveReferenceCacheDir,
} from './lib/region-build.js'

function parseArgs(argv: string[]) {
  const fylke = argv.find((arg) => arg.startsWith('--fylke='))?.split('=')[1]
  const kommune = argv.find((arg) => arg.startsWith('--kommune='))?.split('=')[1]
  const output = argv.find((arg) => arg.startsWith('--output='))?.split('=')[1]
  const cacheDir = argv.find((arg) => arg.startsWith('--cache-dir='))?.split('=')[1]
  const nationalDb = argv.find((arg) => arg.startsWith('--national-db='))?.split('=')[1]
  const refreshDownloads = argv.includes('--refresh-downloads')

  let sourceMode: 'auto' | 'cache' | 'national' = 'auto'
  if (argv.includes('--from-cache')) sourceMode = 'cache'
  if (argv.includes('--from-national')) sourceMode = 'national'

  return {
    fylke,
    kommune,
    output,
    referenceCacheDir: cacheDir,
    nationalDbPath: nationalDb,
    sourceMode,
    fresh: argv.includes('--fresh'),
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

  if (Boolean(args.fylke) === Boolean(args.kommune)) {
    throw new Error('Angi nøyaktig ett av --fylke=XX eller --kommune=XXXX.')
  }

  const referenceCacheDir = resolveReferenceCacheDir({ referenceCacheDir: args.referenceCacheDir })
  const descriptor = await resolveRegionDescriptor(
    { fylke: args.fylke, kommune: args.kommune },
    referenceCacheDir,
    { localOnly: true, nationalDbPath: args.nationalDbPath },
  )

  const outputPath = args.output ?? defaultRegionOutputPath(descriptor)

  await buildRegionDatabase({
    fylke: args.fylke,
    kommune: args.kommune,
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
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

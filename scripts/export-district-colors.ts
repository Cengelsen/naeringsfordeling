#!/usr/bin/env node
import { openDatabase, DEFAULT_DB_PATH } from './lib/db.js'
import { exportDistrictColorAssets } from './lib/district-color-export.js'

const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH
const outputDir = process.env.DISTRICTS_OUTPUT_DIR ?? 'public/data/districts'

const db = openDatabase(dbPath)
const result = exportDistrictColorAssets(db, outputDir)

console.log(`Wrote district color GeoJSON to ${outputDir}`)
console.log(`  ${result.total.toLocaleString('nb-NO')} geocoded organizations`)
console.log(`  manifest: ${result.manifestPath}`)

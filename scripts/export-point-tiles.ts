#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, DEFAULT_DB_PATH } from './lib/db.js'
import {
  GRID_CELL_DEG,
  GRID_KOMMUNE_THRESHOLD,
  groupPointsByGrid,
  shouldGridKommune,
} from './lib/point-tiles.js'
import { toCompactPoint, type CompactPoint } from './lib/points.js'

const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH
const outputDir = process.env.POINTS_OUTPUT_DIR ?? 'public/data/points'

const db = openDatabase(dbPath)

const rows = db
  .prepare(
    `SELECT orgnr, org_type, lat, lng, kommunenummer
     FROM organizations
     WHERE deleted = 0 AND lat IS NOT NULL AND lng IS NOT NULL AND kommunenummer IS NOT NULL
     ORDER BY kommunenummer`,
  )
  .all() as Array<{
  orgnr: string
  org_type: string
  lat: number
  lng: number
  kommunenummer: string
}>

const byKommune = new Map<string, CompactPoint[]>()

for (const row of rows) {
  const bucket = byKommune.get(row.kommunenummer) ?? []
  bucket.push(toCompactPoint(row.orgnr, row.lng, row.lat, row.org_type))
  byKommune.set(row.kommunenummer, bucket)
}

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })

let total = 0
let griddedKommuner = 0
let gridFiles = 0

const index = [...byKommune.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([kommunenummer, points]) => {
    const gridded = shouldGridKommune(points.length)

    if (gridded) {
      griddedKommuner += 1
      const kommuneDir = join(outputDir, kommunenummer)
      mkdirSync(kommuneDir, { recursive: true })

      for (const [cell, cellPoints] of groupPointsByGrid(points)) {
        writeFileSync(
          join(kommuneDir, `${cell}.json`),
          JSON.stringify({
            kommunenummer,
            cell,
            points: cellPoints,
          }),
        )
        gridFiles += 1
      }
    } else {
      writeFileSync(
        join(outputDir, `${kommunenummer}.json`),
        JSON.stringify({
          kommunenummer,
          points,
        }),
      )
    }

    total += points.length
    return {
      kommunenummer,
      count: points.length,
      gridded,
    }
  })

writeFileSync(
  join(outputDir, 'index.json'),
  JSON.stringify({
    total,
    cellDeg: GRID_CELL_DEG,
    gridThreshold: GRID_KOMMUNE_THRESHOLD,
    kommuner: index,
  }),
)

console.log(
  `Exported ${total.toLocaleString('nb-NO')} points across ${byKommune.size} kommuner to ${outputDir}`,
)
console.log(
  `  ${griddedKommuner} gridded kommuner (${gridFiles.toLocaleString('nb-NO')} cell files), ${
    byKommune.size - griddedKommuner
  } monolith files`,
)

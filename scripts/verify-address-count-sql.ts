/**
 * Compare O(log N) spatial address counts against SQL COUNT(DISTINCT) ground truth.
 */
import { existsSync } from 'node:fs'
import { DEFAULT_DB_PATH, openDatabase } from './lib/db.js'
import { countViewportSpatial, warmAddressSpatialIndex } from '../server/addressSpatialIndex.js'

const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH
if (!existsSync(dbPath)) {
  console.log(`verify-address-count-sql: skip (no db at ${dbPath})`)
  process.exit(0)
}

const db = openDatabase(dbPath)
warmAddressSpatialIndex(db)

const filters = {
  orgTypes: [] as string[],
  excludeKonkurs: true,
  excludeUnderAvvikling: true,
  vatRegisteredOnly: false,
  naeringskodeSections: [] as string[],
  employeeBands: [] as import('./lib/employeeBands.js').EmployeeBand[],
  entityKinds: ['enhet'] as Array<'enhet' | 'underenhet'>,
  konsernMembersOnly: false,
}

const bboxes: Array<[number, number, number, number]> = [
  [5.2, 60.3, 5.5, 60.5], // Bergen-ish
  [10.6, 59.8, 10.9, 60.0], // Oslo-ish
  [4.5, 57.9, 31.5, 71.5], // Norway-ish
  [5.32, 60.38, 5.34, 60.4], // tiny
]

function sqlAddressCount(bbox: [number, number, number, number]): number {
  const [minLng, minLat, maxLng, maxLat] = bbox
  // Ground truth uses float64 org coordinates (not SQLite R-tree float32).
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(
           NULLIF(TRIM(adresse_id), ''),
           printf('%.5f:%.5f', lat, lng)
         )) AS count
       FROM organizations
       WHERE deleted = 0
         AND lat IS NOT NULL AND lng IS NOT NULL
         AND konkurs = 0 AND under_avvikling = 0
         AND entity_kind = 'enhet'
         AND lng >= ? AND lng <= ?
         AND lat >= ? AND lat <= ?`,
    )
    .get(minLng, maxLng, minLat, maxLat) as { count: number }
  return row.count
}

function sqlOrgCount(bbox: [number, number, number, number]): number {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM organizations
       WHERE deleted = 0
         AND lat IS NOT NULL AND lng IS NOT NULL
         AND konkurs = 0 AND under_avvikling = 0
         AND entity_kind = 'enhet'
         AND lng >= ? AND lng <= ?
         AND lat >= ? AND lat <= ?`,
    )
    .get(minLng, maxLng, minLat, maxLat) as { count: number }
  return row.count
}

let failures = 0
for (const bbox of bboxes) {
  const t0 = performance.now()
  const spatial = countViewportSpatial(db, filters, bbox)
  const spatialMs = performance.now() - t0

  const t1 = performance.now()
  const sqlAddresses = sqlAddressCount(bbox)
  const sqlOrgs = sqlOrgCount(bbox)
  const sqlMs = performance.now() - t1

  const addrOk = spatial.addressesInBbox === sqlAddresses
  const orgOk = spatial.geocodedInBbox === sqlOrgs
  console.log(
    `bbox ${bbox.join(',')} → addresses ${spatial.addressesInBbox}/${sqlAddresses} ` +
      `orgs ${spatial.geocodedInBbox}/${sqlOrgs} ` +
      `(${addrOk && orgOk ? 'ok' : 'FAIL'}; spatial ${spatialMs.toFixed(2)}ms sql ${sqlMs.toFixed(2)}ms)`,
  )
  if (!addrOk || !orgOk) failures += 1
}

if (failures > 0) {
  console.error(`verify-address-count-sql: ${failures} mismatch(es)`)
  process.exit(1)
}
console.log('verify-address-count-sql: all matches')

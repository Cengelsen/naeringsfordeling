/**
 * Invariant checks for address marker grouping (run: yarn tsx scripts/verify-address-markers.ts)
 */
import assert from 'node:assert/strict'
import {
  addressGroupKey,
  groupPointsByLocation,
  isPreGroupedAddressPoint,
  locationKey,
} from '../src/lib/map/addressGroups.ts'
import { groupOrganizationPointsByAddress } from '../server/addressGroups.ts'
import { DETAIL_MIN_ZOOM } from '../src/lib/lodConfig.ts'
import { LOD_ZOOM_RANGES, LEAFLET_ZOOM_RANGES } from './lib/lod-grid.ts'

// --- identity keys ---
assert.equal(locationKey(59.9139, 10.7522), '59.91390:10.75220')
assert.equal(
  addressGroupKey(59.9139, 10.7522, 'addr-1'),
  'id:addr-1',
)
assert.equal(
  addressGroupKey(59.9139, 10.7522, null),
  `ll:${locationKey(59.9139, 10.7522)}`,
)
assert.equal(
  addressGroupKey(59.9139, 10.7522, '  '),
  `ll:${locationKey(59.9139, 10.7522)}`,
)

// --- client grouping: same adresse_id → one marker ---
const clientGrouped = groupPointsByLocation([
  { orgnr: '1', orgType: 'AS', lat: 59.91, lng: 10.75, adresseId: 'A' },
  { orgnr: '2', orgType: 'ENK', lat: 59.91, lng: 10.75, adresseId: 'A' },
  { orgnr: '3', orgType: 'AS', lat: 60.0, lng: 11.0, adresseId: 'B' },
])
assert.equal(clientGrouped.length, 2)
const multi = clientGrouped.find((g) => g.adresseId === 'A')
assert.ok(multi)
assert.equal(multi.orgCount, 2)
assert.equal(multi.orgType, 'MIXED')
assert.deepEqual(
  multi.orgs.map((o) => o.orgnr).sort(),
  ['1', '2'],
)

// --- different adresse_id, same coords → two markers ---
const splitById = groupPointsByLocation([
  { orgnr: '1', orgType: 'AS', lat: 59.91, lng: 10.75, adresseId: 'A' },
  { orgnr: '2', orgType: 'AS', lat: 59.91, lng: 10.75, adresseId: 'B' },
])
assert.equal(splitById.length, 2)

// --- no adresse_id: same rounded coords merge ---
const byCoords = groupPointsByLocation([
  { orgnr: '1', orgType: 'AS', lat: 59.913901, lng: 10.752201 },
  { orgnr: '2', orgType: 'AS', lat: 59.913899, lng: 10.752199 },
])
assert.equal(byCoords.length, 1)
assert.equal(byCoords[0]!.orgCount, 2)

// --- server grouping matches client keys ---
const serverGrouped = groupOrganizationPointsByAddress([
  {
    orgnr: '1',
    org_type: 'AS',
    org_type_label: 'AS',
    navn: 'One',
    address_text: 'Gate 1',
    postnummer: '0001',
    kommunenummer: '0301',
    lat: 59.91,
    lng: 10.75,
    naeringskode: '62',
    employee_band: '1-4',
    entity_kind: 'enhet',
    adresse_id: 'A',
  },
  {
    orgnr: '2',
    org_type: 'ENK',
    org_type_label: 'ENK',
    navn: 'Two',
    address_text: 'Gate 1',
    postnummer: '0001',
    kommunenummer: '0301',
    lat: 59.91,
    lng: 10.75,
    naeringskode: '47',
    employee_band: '0',
    entity_kind: 'enhet',
    adresse_id: 'A',
  },
])
assert.equal(serverGrouped.length, 1)
assert.equal(serverGrouped[0]!.orgCount, 2)
assert.equal(serverGrouped[0]!.orgType, 'MIXED')
assert.equal(serverGrouped[0]!.orgnrs, '1,2')
assert.equal(serverGrouped[0]!.typeList, ',AS,ENK,')
assert.ok(isPreGroupedAddressPoint(serverGrouped[0] as never))

// --- zoom invariants ---
assert.equal(DETAIL_MIN_ZOOM, 15)
assert.equal(LOD_ZOOM_RANGES.points.minZoom, DETAIL_MIN_ZOOM - 2, 'bake from DETAIL-2 for warmup')
assert.equal(LEAFLET_ZOOM_RANGES.grunnkretser.maxZoom, DETAIL_MIN_ZOOM - 1)
assert.equal(LOD_ZOOM_RANGES.grunnkretser.maxZoom, 14)
// Paint gate: MapLibre minzoom = Leaflet DETAIL - 1
assert.equal(DETAIL_MIN_ZOOM - 1, 14)

console.log('verify-address-markers: all invariants passed')

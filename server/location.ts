import type Database from 'better-sqlite3'
import { geocodeAddressResolved, ensureLocalKartverketReady } from '../scripts/lib/geocode-resolve.js'
import {
  applyGeocodeResult,
  getCachedAddress,
  saveAddressCache,
} from '../scripts/lib/organizations.js'
import { roundCoord } from '../scripts/lib/points.js'

type OrgRow = {
  orgnr: string
  address_text: string | null
  postnummer: string | null
  kommunenummer: string | null
  address_key: string | null
  lat: number | null
  lng: number | null
}

export type OrganizationLocation = {
  orgnr: string
  lat: number | null
  lng: number | null
  kommunenummer: string
  source: 'database' | 'cache' | 'geocoded' | 'none'
}

function getOrgRow(db: Database.Database, orgnr: string): OrgRow | undefined {
  return db
    .prepare(
      `SELECT orgnr, address_text, postnummer, kommunenummer, address_key, lat, lng
       FROM organizations
       WHERE deleted = 0 AND orgnr = ?`,
    )
    .get(orgnr) as OrgRow | undefined
}

function locationFromCoords(
  orgnr: string,
  kommunenummer: string | null,
  lat: number,
  lng: number,
  source: OrganizationLocation['source'],
): OrganizationLocation {
  return {
    orgnr,
    lat: roundCoord(lat),
    lng: roundCoord(lng),
    kommunenummer: kommunenummer ?? '',
    source,
  }
}

export async function resolveOrganizationLocation(
  db: Database.Database,
  orgnr: string,
): Promise<OrganizationLocation | null> {
  const row = getOrgRow(db, orgnr)
  if (!row) return null

  if (row.lat != null && row.lng != null) {
    return locationFromCoords(row.orgnr, row.kommunenummer, row.lat, row.lng, 'database')
  }

  if (row.address_key) {
    const cached = getCachedAddress(db, row.address_key)
    if (cached && cached !== 'failed') {
      applyGeocodeResult(db, row.address_key, cached)
      return locationFromCoords(row.orgnr, row.kommunenummer, cached.lat, cached.lng, 'cache')
    }
  }

  if (row.address_text && row.postnummer) {
    await ensureLocalKartverketReady(db)

    const coords = await geocodeAddressResolved(
      db,
      {
        postnummer: row.postnummer,
        adresse: [row.address_text],
        kommunenummer: row.kommunenummer ?? undefined,
        landkode: 'NO',
      },
      row.address_text,
    )

    if (row.address_key) {
      saveAddressCache(db, row.address_key, coords)
      if (coords) {
        applyGeocodeResult(db, row.address_key, coords)
      }
    } else if (coords) {
      db.prepare(`UPDATE organizations SET lat = ?, lng = ? WHERE orgnr = ?`).run(
        coords.lat,
        coords.lng,
        orgnr,
      )
    }

    if (coords) {
      return locationFromCoords(row.orgnr, row.kommunenummer, coords.lat, coords.lng, 'geocoded')
    }
  }

  return {
    orgnr: row.orgnr,
    lat: null,
    lng: null,
    kommunenummer: row.kommunenummer ?? '',
    source: 'none',
  }
}

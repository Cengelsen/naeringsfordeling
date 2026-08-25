import { Hono } from 'hono'
import { getContext } from '../context.js'
import { maybeNotModified, resourceEtag } from '../httpCache.js'

const REFERENCE_MAX_AGE = 300

const reference = new Hono()

interface ReferenceCache {
  organisasjonsformer: { kode: string; beskrivelse: string }[]
  naeringskoder: { section: string; label: string | null; count: number }[]
  kommuner: { nummer: string; count: number }[]
}

let cache: ReferenceCache | null = null

function loadReferenceCache(): ReferenceCache {
  const { db } = getContext()

  const orgFormRows = db
    .prepare(
      `SELECT org_type AS kode, MIN(org_type_label) AS beskrivelse, COUNT(*) AS count
       FROM organizations WHERE deleted = 0 GROUP BY org_type ORDER BY beskrivelse`,
    )
    .all() as Array<{ kode: string; beskrivelse: string; count: number }>

  const naeringskodeRows = db
    .prepare(
      `SELECT substr(naeringskode, 1, 2) AS section, MIN(naeringskode_label) AS label, COUNT(*) AS count
       FROM organizations WHERE deleted = 0 AND naeringskode IS NOT NULL AND length(naeringskode) >= 2
       GROUP BY section ORDER BY section`,
    )
    .all() as Array<{ section: string; label: string | null; count: number }>

  const kommuneRows = db
    .prepare(
      `SELECT kommunenummer AS nummer, COUNT(*) AS count
       FROM organizations WHERE deleted = 0 AND kommunenummer IS NOT NULL
       GROUP BY kommunenummer ORDER BY kommunenummer`,
    )
    .all() as Array<{ nummer: string; count: number }>

  return {
    organisasjonsformer: orgFormRows.map(({ kode, beskrivelse }) => ({ kode, beskrivelse })),
    naeringskoder: naeringskodeRows.map((row) => ({
      section: row.section,
      label: row.label,
      count: row.count,
    })),
    kommuner: kommuneRows,
  }
}

export function warmReferenceCache() {
  cache = loadReferenceCache()
}

function getReferenceCache(): ReferenceCache {
  cache ??= loadReferenceCache()
  return cache
}

reference.get('/api/health', (c) => {
  return c.json({ ok: true })
})

reference.get('/api/organisasjonsformer', (c) => {
  const notModified = maybeNotModified(c, {
    etag: resourceEtag('organisasjonsformer'),
    maxAge: REFERENCE_MAX_AGE,
  })
  if (notModified) return notModified
  return c.json({ organisasjonsformer: getReferenceCache().organisasjonsformer })
})

reference.get('/api/naeringskoder', (c) => {
  const notModified = maybeNotModified(c, {
    etag: resourceEtag('naeringskoder'),
    maxAge: REFERENCE_MAX_AGE,
  })
  if (notModified) return notModified
  return c.json({ naeringskoder: getReferenceCache().naeringskoder })
})

reference.get('/api/kommuner', (c) => {
  const notModified = maybeNotModified(c, {
    etag: resourceEtag('kommuner'),
    maxAge: REFERENCE_MAX_AGE,
  })
  if (notModified) return notModified
  return c.json({ kommuner: getReferenceCache().kommuner })
})

export default reference

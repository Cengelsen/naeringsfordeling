import { Hono } from 'hono'
import { getStats } from '../../scripts/lib/db.js'
import { getContext } from '../context.js'

const reference = new Hono()

reference.get('/api/health', (c) => {
  const { db, dbPath } = getContext()
  const stats = getStats(db)
  return c.json({ ok: true, database: dbPath, stats })
})

reference.get('/api/organisasjonsformer', (c) => {
  const { db } = getContext()
  const rows = db
    .prepare(
      `SELECT org_type AS kode, MIN(org_type_label) AS beskrivelse, COUNT(*) AS count
       FROM organizations WHERE deleted = 0 GROUP BY org_type ORDER BY beskrivelse`,
    )
    .all() as Array<{ kode: string; beskrivelse: string; count: number }>
  return c.json({
    organisasjonsformer: rows.map(({ kode, beskrivelse }) => ({ kode, beskrivelse })),
  })
})

reference.get('/api/naeringskoder', (c) => {
  const { db } = getContext()
  const rows = db
    .prepare(
      `SELECT substr(naeringskode, 1, 2) AS section, MIN(naeringskode_label) AS label, COUNT(*) AS count
       FROM organizations WHERE deleted = 0 AND naeringskode IS NOT NULL AND length(naeringskode) >= 2
       GROUP BY section ORDER BY section`,
    )
    .all() as Array<{ section: string; label: string | null; count: number }>
  return c.json({
    naeringskoder: rows.map((row) => ({
      section: row.section,
      label: row.label,
      count: row.count,
    })),
  })
})

reference.get('/api/kommuner', (c) => {
  const { db } = getContext()
  const rows = db
    .prepare(
      `SELECT kommunenummer AS nummer, COUNT(*) AS count
       FROM organizations WHERE deleted = 0 AND kommunenummer IS NOT NULL
       GROUP BY kommunenummer ORDER BY kommunenummer`,
    )
    .all() as Array<{ nummer: string; count: number }>
  return c.json({ kommuner: rows })
})

export default reference

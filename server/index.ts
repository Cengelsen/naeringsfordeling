import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { openDatabase, DEFAULT_DB_PATH } from '../scripts/lib/db.js'
import { warmAddressSpatialIndex } from './addressSpatialIndex.js'
import { initContext } from './context.js'
import reference from './routes/reference.js'
import geography from './routes/geography.js'
import organizations from './routes/organizations.js'

const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`)
  console.error('Run yarn sync:full or yarn download-db first.')
  process.exit(1)
}

const db = openDatabase(dbPath)

const stmtCache = new Map<string, ReturnType<typeof db.prepare>>()
const STMT_CACHE_MAX = 64

function cachedPrepare(sql: string) {
  const cached = stmtCache.get(sql)
  if (cached) {
    stmtCache.delete(sql)
    stmtCache.set(sql, cached)
    return cached
  }
  const stmt = db.prepare(sql)
  stmtCache.set(sql, stmt)
  if (stmtCache.size > STMT_CACHE_MAX) {
    const oldest = stmtCache.keys().next().value!
    stmtCache.delete(oldest)
  }
  return stmt
}

initContext({ db, dbPath, cachedPrepare })

const app = new Hono()

app.use('/*', cors())
app.use(compress())

app.route('/', reference)
app.route('/', geography)
app.route('/', organizations)

const port = Number(process.env.PORT ?? 3001)

function shutdown() {
  db.pragma('optimize')
  db.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

console.log(`API server on http://localhost:${port}`)
console.log(`Database: ${dbPath}`)

serve({ fetch: app.fetch, port })

setImmediate(() => {
  try {
    warmAddressSpatialIndex(db)
  } catch (error) {
    console.error('Failed to warm address spatial index', error)
  }
})

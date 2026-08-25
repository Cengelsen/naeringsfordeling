import type Database from 'better-sqlite3'

type BindParams = Array<string | number | bigint | Buffer | null | undefined>

export interface CachedStatement {
  all(...params: BindParams): unknown[]
  get(...params: BindParams): unknown
  run(...params: BindParams): Database.RunResult
}

export interface ServerContext {
  db: Database.Database
  dbPath: string
  cachedPrepare: (sql: string) => CachedStatement
}

let _ctx: ServerContext | null = null

export function initContext(ctx: ServerContext) {
  _ctx = ctx
}

export function getContext(): ServerContext {
  if (!_ctx) throw new Error('Server context not initialized')
  return _ctx
}

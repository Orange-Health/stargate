import pg from 'pg'

let pool: pg.Pool | undefined

export function getPool() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) return undefined
  if (!pool) {
    pool = new pg.Pool({ connectionString })
  }
  return pool
}

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL)
}

export async function closePool() {
  if (!pool) return
  await pool.end()
  pool = undefined
}

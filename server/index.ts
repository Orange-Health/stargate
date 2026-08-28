import { createApp } from './app.js'
import { migrate } from './db/migrate.js'
import { loadLocalEnv } from './env.js'
import { expireSnapshots } from './services/releaseSnapshots.js'

const SNAPSHOT_EXPIRY_MS = 60 * 60 * 1000

async function main() {
  loadLocalEnv()
  await migrate()
  await expireSnapshots()
  setInterval(() => {
    void expireSnapshots()
  }, SNAPSHOT_EXPIRY_MS).unref()

  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 8787)
  const host =
    process.env.HOST ??
    (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')

  createApp().listen(port, host, () => {
    console.info(`Release Dashboard listening on http://${host}:${port}`)
  })
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

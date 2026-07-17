import { createApp } from './app.js'

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 8787)
const host =
  process.env.HOST ??
  (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')

createApp().listen(port, host, () => {
  console.info(`Release Dashboard listening on http://${host}:${port}`)
})

import { createApp } from './app.js'

const port = Number(process.env.API_PORT ?? 8787)

createApp().listen(port, '127.0.0.1', () => {
  console.info(`Release Dashboard API listening on http://127.0.0.1:${port}`)
})

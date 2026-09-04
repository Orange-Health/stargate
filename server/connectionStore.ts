import fs from 'node:fs'
import type { ConnectionConfig } from '../src/shared/types.js'

const connectionCachePath = '/tmp/stargate-connection.json'

let connection: ConnectionConfig | undefined = loadCachedConnection()

function loadCachedConnection() {
  try {
    if (!fs.existsSync(connectionCachePath)) return undefined
    return Object.freeze(
      JSON.parse(
        fs.readFileSync(connectionCachePath, 'utf8'),
      ) as ConnectionConfig,
    )
  } catch {
    return undefined
  }
}

export function setConnection(config: ConnectionConfig) {
  connection = Object.freeze({ ...config })
  try {
    fs.writeFileSync(connectionCachePath, JSON.stringify(config), {
      mode: 0o600,
    })
  } catch {
    // Local cache is best-effort for dev restarts.
  }
}

export function clearConnection() {
  connection = undefined
  try {
    fs.unlinkSync(connectionCachePath)
  } catch {
    // ignore missing cache
  }
}

export function getConnection(): ConnectionConfig | undefined {
  return connection
}

export function requireConnection(): ConnectionConfig {
  if (!connection) {
    throw new Error(
      'Connect Jira, GitHub, and Jenkins before loading release data.',
    )
  }
  return connection
}

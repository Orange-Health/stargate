import type { ConnectionConfig } from '../src/shared/types.js'

let connection: ConnectionConfig | undefined

export function setConnection(config: ConnectionConfig) {
  connection = Object.freeze({ ...config })
}

export function clearConnection() {
  connection = undefined
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

import { getPool } from '../db/pool.js'
import { getCurrentUser } from '../auth/context.js'

export async function recordAudit(input: {
  action: string
  repository?: string
  versionId?: string
  issueKey?: string
  details?: Record<string, unknown>
}) {
  const pool = getPool()
  const user = getCurrentUser()
  if (!pool || !user) return
  try {
    await pool.query(
      `INSERT INTO audit_events (user_id, action, repository, version_id, issue_key, details)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        user.id,
        input.action,
        input.repository ?? null,
        input.versionId ?? null,
        input.issueKey ?? null,
        input.details ?? {},
      ],
    )
  } catch (error) {
    console.error('Failed to write audit event', error)
  }
}

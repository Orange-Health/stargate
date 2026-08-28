import type {
  ReleaseControlRoomState,
  ReleaseDashboard,
  RepositoryReleaseState,
} from '../../src/shared/types.js'
import { snapshotTtlDays } from '../constants.js'
import { getPool } from '../db/pool.js'
import { getCurrentUser } from '../auth/context.js'

export type ReleaseSnapshotRow = {
  dashboard: ReleaseDashboard
  fetchedAt: string
}

function ttlInterval() {
  return `${snapshotTtlDays()} days`
}

export function snapshotCounts(dashboard: ReleaseDashboard) {
  return {
    ticketCount: dashboard.version.issueCount ?? dashboard.services.reduce(
      (sum, service) => sum + service.items.length,
      dashboard.unmatched.length,
    ),
    eligibleCount: dashboard.services.reduce(
      (sum, service) => sum + service.eligibleCount,
      0,
    ),
    blockedCount: dashboard.services.reduce(
      (sum, service) => sum + service.blockedCount,
      0,
    ),
    mergedCount: dashboard.services.reduce(
      (sum, service) => sum + service.mergedCount,
      0,
    ),
    unmatchedCount: dashboard.unmatched.length,
    serviceCount: dashboard.services.length,
  }
}

export async function getReleaseSnapshot(versionId: string) {
  const pool = getPool()
  if (!pool) return undefined
  const result = await pool.query<{
    dashboard: ReleaseDashboard
    fetched_at: Date
  }>(
    `SELECT dashboard, fetched_at
     FROM release_snapshots
     WHERE version_id = $1 AND expires_at > now()`,
    [versionId],
  )
  const row = result.rows[0]
  if (!row) return undefined
  return {
    dashboard: {
      ...row.dashboard,
      cached: true,
    },
    fetchedAt: row.fetched_at.toISOString(),
  } satisfies ReleaseSnapshotRow
}

export async function upsertReleaseSnapshot(dashboard: ReleaseDashboard) {
  const pool = getPool()
  if (!pool) return
  const counts = snapshotCounts(dashboard)
  await pool.query(
    `INSERT INTO release_snapshots (
       version_id, version_name, start_date, release_date, overdue,
       ticket_count, eligible_count, blocked_count, merged_count,
       unmatched_count, service_count, dashboard, fetched_at, expires_at,
       updated_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
       now() + $14::interval, $15
     )
     ON CONFLICT (version_id) DO UPDATE SET
       version_name = EXCLUDED.version_name,
       start_date = EXCLUDED.start_date,
       release_date = EXCLUDED.release_date,
       overdue = EXCLUDED.overdue,
       ticket_count = EXCLUDED.ticket_count,
       eligible_count = EXCLUDED.eligible_count,
       blocked_count = EXCLUDED.blocked_count,
       merged_count = EXCLUDED.merged_count,
       unmatched_count = EXCLUDED.unmatched_count,
       service_count = EXCLUDED.service_count,
       dashboard = EXCLUDED.dashboard,
       fetched_at = EXCLUDED.fetched_at,
       expires_at = EXCLUDED.expires_at,
       updated_by = EXCLUDED.updated_by`,
    [
      dashboard.version.id,
      dashboard.version.name,
      dashboard.version.startDate ?? null,
      dashboard.version.releaseDate ?? null,
      dashboard.version.overdue,
      counts.ticketCount,
      counts.eligibleCount,
      counts.blockedCount,
      counts.mergedCount,
      counts.unmatchedCount,
      counts.serviceCount,
      dashboard,
      dashboard.fetchedAt,
      ttlInterval(),
      getCurrentUser()?.id ?? null,
    ],
  )
}

export async function listSnapshotPlanning() {
  const pool = getPool()
  if (!pool) return []
  const result = await pool.query<{
    version_id: string
    version_name: string
    start_date: string | null
    release_date: string | null
    overdue: boolean
    ticket_count: number
    eligible_count: number
    blocked_count: number
    merged_count: number
    unmatched_count: number
    service_count: number
    fetched_at: Date
  }>(
    `SELECT version_id, version_name, start_date, release_date, overdue,
            ticket_count, eligible_count, blocked_count, merged_count,
            unmatched_count, service_count, fetched_at
     FROM release_snapshots
     WHERE expires_at > now()
     ORDER BY release_date DESC NULLS LAST, version_name`,
  )
  return result.rows
}

export async function upsertRepositoryState(
  versionId: string,
  state: ReleaseControlRoomState | RepositoryReleaseState,
) {
  const pool = getPool()
  if (!pool || !versionId) return
  await pool.query(
    `INSERT INTO release_repository_states (
       version_id, repository, production_ready, state, fetched_at, expires_at
     ) VALUES ($1,$2,$3,$4,$5, now() + $6::interval)
     ON CONFLICT (version_id, repository) DO UPDATE SET
       production_ready = EXCLUDED.production_ready,
       state = EXCLUDED.state,
       fetched_at = EXCLUDED.fetched_at,
       expires_at = EXCLUDED.expires_at`,
    [
      versionId,
      state.repository,
      'productionReady' in state ? Boolean(state.productionReady) : false,
      state,
      state.fetchedAt,
      ttlInterval(),
    ],
  )
}

export async function expireSnapshots() {
  const pool = getPool()
  if (!pool) return
  await pool.query('DELETE FROM release_snapshots WHERE expires_at < now()')
  await pool.query(
    'DELETE FROM release_repository_states WHERE expires_at < now()',
  )
  await pool.query('DELETE FROM release_progress WHERE expires_at < now()')
}

const refreshing = new Set<string>()

export function beginSnapshotRefresh(versionId: string) {
  if (refreshing.has(versionId)) return false
  refreshing.add(versionId)
  return true
}

export function endSnapshotRefresh(versionId: string) {
  refreshing.delete(versionId)
}

export async function upsertReleaseProgress(
  versionId: string,
  payload: unknown,
) {
  const pool = getPool()
  if (!pool) return
  await pool.query(
    `INSERT INTO release_progress (version_id, payload, updated_at, expires_at)
     VALUES ($1, $2, now(), now() + $3::interval)
     ON CONFLICT (version_id) DO UPDATE SET
       payload = EXCLUDED.payload,
       updated_at = now(),
       expires_at = EXCLUDED.expires_at`,
    [versionId, payload, ttlInterval()],
  )
}

export async function getReleaseProgress(versionId: string) {
  const pool = getPool()
  if (!pool) return undefined
  const result = await pool.query<{ payload: unknown }>(
    `SELECT payload FROM release_progress
     WHERE version_id = $1 AND expires_at > now()`,
    [versionId],
  )
  return result.rows[0]?.payload
}

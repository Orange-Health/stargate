export const GITHUB_ORG = 'Orange-Health'
export const DEFAULT_JIRA_PROJECT = 'OH'

export const SESSION_COOKIE_NAME = 'rd_session'
export const OIDC_COOKIE_NAME = 'rd_oidc'

export const LOCAL_DEV_USER_ID = '00000000-0000-4000-a000-000000000001'
export const LOCAL_DEV_USER_SUB = 'local-dev'
export const LOCAL_DEV_USER_EMAIL = 'local-dev@orangehealth'
export const LOCAL_DEV_USER_NAME = 'Local Dev'

export const NOT_CONNECTED_MESSAGE =
  'Connect Jira, GitHub, and Jenkins before loading release data.'

export const RELEASE_DASHBOARD_ROLE = 'release-dashboard'

export function snapshotTtlDays() {
  const parsed = Number(process.env.RELEASE_SNAPSHOT_TTL_DAYS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 28
}

export function snapshotStaleMs() {
  const parsed = Number(process.env.RELEASE_SNAPSHOT_STALE_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60_000
}

export function isAuthDisabled() {
  return process.env.AUTH_DISABLED === 'true'
}

export function isProduction() {
  return process.env.NODE_ENV === 'production'
}

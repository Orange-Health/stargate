import type {
  ConnectionConfig,
  DashboardProgress,
  EligibilityReason,
  JiraIssue,
  PullRequest,
  ReleaseDashboard,
  ReleaseItem,
  ServiceRelease,
} from '../../src/shared/types.js'
import { isClosedWithoutMerge } from '../../src/shared/pullRequests.js'
import { discoverPullRequests } from '../providers/github.js'
import { getVersion, listVersionIssues } from '../providers/jira.js'

const CACHE_TTL_MS = 60_000
const cache = new Map<
  string,
  { expiresAt: number; dashboard: ReleaseDashboard }
>()

export function clearReleaseCache() {
  cache.clear()
}

export function evaluateEligibility(
  issue: JiraIssue,
  pullRequest?: PullRequest,
): ReleaseItem {
  if (isClosedWithoutMerge(pullRequest)) pullRequest = undefined
  const blockingReasons: EligibilityReason[] = []
  const warningReasons: EligibilityReason[] = []

  if (!pullRequest) {
    blockingReasons.push('NO_MATCHING_PR')
  } else {
    if (pullRequest.merged) {
      blockingReasons.push('ALREADY_MERGED')
    } else {
      if (pullRequest.draft) blockingReasons.push('DRAFT')
      if (pullRequest.baseBranch !== 'dev') {
        blockingReasons.push('WRONG_BASE_BRANCH')
      }
      if (pullRequest.reviewDecision === 'review_required') {
        blockingReasons.push('REVIEW_REQUIRED')
      }
      if (pullRequest.reviewDecision === 'changes_requested') {
        blockingReasons.push('CHANGES_REQUESTED')
      }
      if (
        pullRequest.mergeable === false ||
        pullRequest.mergeableState === 'dirty'
      ) {
        blockingReasons.push('HAS_CONFLICTS')
      } else if (pullRequest.mergeable === null) {
        blockingReasons.push('MERGEABILITY_PENDING')
      }
    }

    if (pullRequest.checks === 'pending') {
      warningReasons.push('CHECKS_PENDING')
    }
    if (pullRequest.checks === 'failure') {
      warningReasons.push('CHECKS_FAILED')
    }
  }

  return {
    issue,
    pullRequest,
    eligible: blockingReasons.length === 0,
    blockingReasons,
    warningReasons,
  }
}

export function isClearedMerge(pullRequest?: PullRequest) {
  return (
    Boolean(pullRequest?.merged) &&
    (pullRequest?.baseBranch === 'dev' || pullRequest?.baseBranch === 'main')
  )
}

function summarizeService(
  repository: string,
  items: ReleaseItem[],
): ServiceRelease {
  const visibleItems = items.filter(
    (item) => !isClosedWithoutMerge(item.pullRequest),
  )
  return {
    repository,
    items: visibleItems.sort((a, b) => a.issue.key.localeCompare(b.issue.key)),
    eligibleCount: visibleItems.filter((item) => item.eligible).length,
    blockedCount: visibleItems.filter(
      (item) => !item.eligible && !item.pullRequest?.merged,
    ).length,
    mergedCount: visibleItems.filter((item) =>
      isClearedMerge(item.pullRequest),
    ).length,
    backMergePending: false,
  }
}

export async function aggregateRelease(
  config: ConnectionConfig,
  versionId: string,
  forceRefresh = false,
  reportProgress?: (progress: DashboardProgress) => void,
): Promise<ReleaseDashboard> {
  const cacheKey = `${config.jiraSite}:${config.jiraProject ?? 'OH'}:${config.githubOrg}:${versionId}`
  const cached = cache.get(cacheKey)
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    reportProgress?.({
      phase: 'mapping',
      message: 'Using recently cached release data…',
    })
    return { ...cached.dashboard, cached: true }
  }

  reportProgress?.({
    phase: 'jira',
    message: `Loading Jira release ${versionId} and its tickets…`,
  })
  const [version, issues] = await Promise.all([
    getVersion(config, versionId),
    listVersionIssues(config, versionId),
  ])
  reportProgress?.({
    phase: 'jira',
    message: `Found ${issues.length} Jira tickets in ${version.name}.`,
    current: issues.length,
    total: issues.length,
  })
  const discovery = await discoverPullRequests(
    config,
    issues.map((issue) => ({
      key: issue.key,
      developmentSummary: issue.developmentSummary,
    })),
    reportProgress,
  )
  reportProgress?.({
    phase: 'mapping',
    message: 'Grouping matched pull requests by service…',
  })
  const serviceItems = new Map<string, ReleaseItem[]>()
  const unmatched: ReleaseItem[] = []

  for (const issue of issues) {
    const pulls = discovery.byIssue.get(issue.key) ?? []
    if (pulls.length === 0) {
      unmatched.push(evaluateEligibility(issue))
      continue
    }
    for (const pull of pulls) {
      const items = serviceItems.get(pull.repository) ?? []
      items.push(evaluateEligibility(issue, pull))
      serviceItems.set(pull.repository, items)
    }
  }

  const services = [...serviceItems.entries()]
    .map(([repository, items]) => summarizeService(repository, items))
    .sort((a, b) => a.repository.localeCompare(b.repository))
  reportProgress?.({
    phase: 'mapping',
    message: `Mapped ${issues.length - unmatched.length} tickets across ${services.length} services.`,
    current: services.length,
    total: services.length,
  })

  const dashboard: ReleaseDashboard = {
    version: { ...version, issueCount: issues.length },
    services,
    unmatched: unmatched.sort((a, b) =>
      a.issue.key.localeCompare(b.issue.key),
    ),
    warnings: discovery.warnings.map((message) => ({
      provider: 'github' as const,
      message,
    })),
    githubRateLimit: discovery.rateLimit,
    fetchedAt: new Date().toISOString(),
    cached: false,
  }

  cache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    dashboard,
  })
  return dashboard
}

export async function refreshServiceRelease(
  config: ConnectionConfig,
  versionId: string,
  repository: string,
  issueKeys: string[],
): Promise<ServiceRelease> {
  const requestedKeys = new Set(issueKeys.map((key) => key.toUpperCase()))
  const issues = (await listVersionIssues(config, versionId)).filter((issue) =>
    requestedKeys.has(issue.key.toUpperCase()),
  )
  const discovery = await discoverPullRequests(
    config,
    issues.map((issue) => ({
      key: issue.key,
      developmentSummary: issue.developmentSummary,
    })),
  )
  const items: ReleaseItem[] = []
  for (const issue of issues) {
    const pulls = (discovery.byIssue.get(issue.key) ?? []).filter(
      (pull) => pull.repository.toLowerCase() === repository.toLowerCase(),
    )
    if (pulls.length === 0) {
      items.push(evaluateEligibility(issue))
      continue
    }
    for (const pull of pulls) items.push(evaluateEligibility(issue, pull))
  }
  return summarizeService(repository, items)
}

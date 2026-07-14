import type {
  ConnectionConfig,
  EligibilityReason,
  JiraIssue,
  PullRequest,
  ReleaseDashboard,
  ReleaseItem,
  ServiceRelease,
} from '../../src/shared/types.js'
import { discoverPullRequests } from '../providers/github.js'
import { getRepositoryBackMergeStatus } from '../providers/githubOperations.js'
import { getVersion, listVersionIssues } from '../providers/jira.js'

const CACHE_TTL_MS = 45_000
const cache = new Map<
  string,
  { expiresAt: number; dashboard: ReleaseDashboard }
>()

async function settledConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
) {
  const results: PromiseSettledResult<R>[] = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++
      try {
        results[index] = {
          status: 'fulfilled',
          value: await mapper(values[index]),
        }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  )
  return results
}

export function clearReleaseCache() {
  cache.clear()
}

export function evaluateEligibility(
  issue: JiraIssue,
  pullRequest?: PullRequest,
): ReleaseItem {
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

function summarizeService(
  repository: string,
  items: ReleaseItem[],
): ServiceRelease {
  return {
    repository,
    items: items.sort((a, b) => a.issue.key.localeCompare(b.issue.key)),
    eligibleCount: items.filter((item) => item.eligible).length,
    blockedCount: items.filter(
      (item) => !item.eligible && !item.pullRequest?.merged,
    ).length,
    mergedCount: items.filter(
      (item) =>
        item.pullRequest?.merged && item.pullRequest.baseBranch === 'dev',
    ).length,
    backMergePending: false,
  }
}

export async function aggregateRelease(
  config: ConnectionConfig,
  versionId: string,
  forceRefresh = false,
): Promise<ReleaseDashboard> {
  const cacheKey = `${config.jiraSite}:${config.jiraProject ?? 'OH'}:${config.githubOrg}:${versionId}`
  const cached = cache.get(cacheKey)
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return { ...cached.dashboard, cached: true }
  }

  const [version, issues] = await Promise.all([
    getVersion(config, versionId),
    listVersionIssues(config, versionId),
  ])
  const discovery = await discoverPullRequests(
    config,
    issues.map((issue) => issue.key),
  )
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
  const riskResults = await settledConcurrent(services, 4, (service) =>
    getRepositoryBackMergeStatus(config, service.repository),
  )
  const riskWarnings: string[] = []
  riskResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      services[index].backMergePending = result.value.length > 0
    } else {
      services[index].riskCheckFailed = true
      riskWarnings.push(
        `Could not check pending back-merges for ${services[index].repository}.`,
      )
    }
  })

  const dashboard: ReleaseDashboard = {
    version: { ...version, issueCount: issues.length },
    services,
    unmatched: unmatched.sort((a, b) =>
      a.issue.key.localeCompare(b.issue.key),
    ),
    warnings: [...discovery.warnings, ...riskWarnings].map((message) => ({
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

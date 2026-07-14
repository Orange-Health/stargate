import type {
  BuildStatus,
  CheckStatus,
  ConnectionConfig,
  MergePromotionPullRequestResult,
  PendingBackMerge,
  PromotionPullRequest,
  PromotionRoute,
  PromotionStep,
  RepositoryReleaseState,
  RepositoryRisk,
  ReviewDecision,
  StagingEnvironment,
  TrackedStagingRelease,
  WorkflowRun,
} from '../../src/shared/types.js'
import { ProviderError } from '../errors.js'
import {
  clearGitHubProviderCache,
  githubApi,
  repositoryPath,
} from './github.js'
import { servicesForRepository } from './jenkins.js'

type GitHubRepository = {
  full_name: string
  default_branch: string
}

type GitHubRelease = {
  id: number
  tag_name: string
  html_url: string
  prerelease: boolean
  created_at: string
}

type GitHubWorkflowRun = {
  id: number
  name: string
  event: string
  head_branch: string | null
  status: string
  conclusion: string | null
  html_url: string
  run_started_at: string
  updated_at: string
}

type GitHubPull = {
  number: number
  title: string
  body: string | null
  html_url: string
  draft: boolean
  merged_at: string | null
  mergeable: boolean | null
  mergeable_state: string
  base: { ref: string }
  head: { ref: string; sha: string }
}

type GitHubReview = {
  user: { login: string }
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  submitted_at?: string
}

type GitHubChecks = {
  check_runs: Array<{
    status: 'queued' | 'in_progress' | 'completed'
    conclusion: string | null
  }>
}

const stagingTagPattern =
  /^v-(qa|s1|s2|s3|s4|s5|s6)-v\d{2}\.\d{4}\.\d+$/
const RISK_CACHE_MS = 45_000
const riskCache = new Map<
  string,
  { expiresAt: number; value: Promise<PendingBackMerge[]> }
>()
const qaBuildCache = new Map<
  string,
  { expiresAt: number; value: Promise<string | undefined> }
>()

export function clearRepositoryCaches(
  config: ConnectionConfig,
  repository: string,
  includeSearches = false,
) {
  clearGitHubProviderCache(repository, includeSearches)
  const key = `${config.githubOrg}:${repository}`.toLowerCase()
  riskCache.delete(key)
  qaBuildCache.delete(key)
}

function assertConnectedRepository(
  config: ConnectionConfig,
  repository: string,
) {
  const [owner] = repository.split('/')
  repositoryPath(repository)
  if (owner.toLowerCase() !== config.githubOrg.toLowerCase()) {
    throw new ProviderError(
      'Repository is outside the connected GitHub organization.',
      'REPOSITORY_NOT_ALLOWED',
      'github',
      403,
    )
  }
}

export function aggregateBuildStatus(runs: WorkflowRun[]): BuildStatus {
  if (runs.length === 0) return 'starting'
  if (
    runs.some(
      (run) =>
        run.status === 'completed' &&
        [
          'failure',
          'timed_out',
          'action_required',
          'startup_failure',
          'stale',
        ].includes(run.conclusion ?? ''),
    )
  ) {
    return 'failed'
  }
  if (runs.some((run) => run.status === 'in_progress')) return 'running'
  if (runs.some((run) => run.status !== 'completed')) return 'starting'
  if (runs.some((run) => run.conclusion === 'cancelled')) return 'canceled'
  return 'succeeded'
}

export function promotionBranches(
  route: PromotionRoute,
  defaultBranch: string,
) {
  return route === 'dev-to-release'
    ? { fromBranch: 'dev', toBranch: 'release' }
    : { fromBranch: 'release', toBranch: defaultBranch }
}

export function hasActualMergeConflict(
  mergeable: boolean | null,
  mergeableState: string,
) {
  return mergeable === false || mergeableState === 'dirty'
}

async function listReleaseRuns(
  config: ConnectionConfig,
  repository: string,
  release: GitHubRelease,
): Promise<WorkflowRun[]> {
  const query = new URLSearchParams({
    branch: release.tag_name,
    per_page: '100',
  })
  const response = await githubApi<{ workflow_runs: GitHubWorkflowRun[] }>(
    config,
    `/repos/${repositoryPath(repository)}/actions/runs?${query}`,
  )

  return response.workflow_runs
    .filter(
      (run) =>
        run.head_branch === release.tag_name ||
        new Date(run.run_started_at).getTime() >=
          new Date(release.created_at).getTime() - 60_000,
    )
    .map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? undefined,
      url: run.html_url,
      startedAt: run.run_started_at,
      updatedAt: run.updated_at,
    }))
}

async function listTrackedReleases(
  config: ConnectionConfig,
  repository: string,
): Promise<TrackedStagingRelease[]> {
  const releases = await githubApi<GitHubRelease[]>(
    config,
    `/repos/${repositoryPath(repository)}/releases?per_page=30`,
  )
  const staging = releases
    .filter(
      (release) =>
        release.prerelease && stagingTagPattern.test(release.tag_name),
    )
    .slice(0, 12)

  return Promise.all(
    staging.map(async (release) => {
      const runs = await listReleaseRuns(config, repository, release)
      return {
        id: release.id,
        tag: release.tag_name,
        environment: stagingTagPattern.exec(
          release.tag_name,
        )?.[1] as StagingEnvironment,
        url: release.html_url,
        createdAt: release.created_at,
        buildStatus: aggregateBuildStatus(runs),
        runs,
      }
    }),
  )
}

export async function getLatestSuccessfulQaTag(
  config: ConnectionConfig,
  repository: string,
): Promise<string | undefined> {
  assertConnectedRepository(config, repository)
  const cacheKey = `${config.githubOrg}:${repository}`.toLowerCase()
  const cached = qaBuildCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const value = (async () => {
    const releases = await githubApi<GitHubRelease[]>(
      config,
      `/repos/${repositoryPath(repository)}/releases?per_page=30`,
    )
    const qaReleases = releases
      .filter(
        (release) =>
          release.prerelease && /^v-qa-v\d{2}\.\d{4}\.\d+$/.test(release.tag_name),
      )
      .slice(0, 8)
    for (const release of qaReleases) {
      const runs = await listReleaseRuns(config, repository, release)
      if (aggregateBuildStatus(runs) === 'succeeded') return release.tag_name
    }
    return undefined
  })()
  qaBuildCache.set(cacheKey, {
    expiresAt: Date.now() + 30_000,
    value,
  })
  value.catch(() => qaBuildCache.delete(cacheKey))
  return value
}

function latestReviewDecision(reviews: GitHubReview[]): ReviewDecision {
  const latest = new Map<string, GitHubReview>()
  for (const review of reviews) {
    if (review.state === 'PENDING') continue
    const current = latest.get(review.user.login)
    if (
      !current ||
      (review.submitted_at ?? '').localeCompare(current.submitted_at ?? '') >= 0
    ) {
      latest.set(review.user.login, review)
    }
  }
  const states = [...latest.values()].map((review) => review.state)
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested'
  if (states.includes('APPROVED')) return 'approved'
  return 'review_required'
}

function checksStatus(checks: GitHubChecks): CheckStatus {
  if (checks.check_runs.length === 0) return 'none'
  if (checks.check_runs.some((check) => check.status !== 'completed')) {
    return 'pending'
  }
  const failures = [
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'stale',
  ]
  return checks.check_runs.some((check) =>
    failures.includes(check.conclusion ?? ''),
  )
    ? 'failure'
    : 'success'
}

async function promotionPullDetails(
  config: ConnectionConfig,
  repository: string,
  pull: GitHubPull,
): Promise<PromotionPullRequest> {
  const base = `/repos/${repositoryPath(repository)}`
  const [reviews, checks] = await Promise.all([
    githubApi<GitHubReview[]>(
      config,
      `${base}/pulls/${pull.number}/reviews?per_page=100`,
    ),
    githubApi<GitHubChecks>(
      config,
      `${base}/commits/${pull.head.sha}/check-runs?per_page=100`,
    ),
  ])
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body ?? undefined,
    url: pull.html_url,
    baseBranch: pull.base.ref,
    headBranch: pull.head.ref,
    draft: pull.draft,
    mergeable: pull.mergeable,
    mergeableState: pull.mergeable_state,
    reviewDecision: latestReviewDecision(reviews),
    checks: checksStatus(checks),
  }
}

async function findPulls(
  config: ConnectionConfig,
  repository: string,
  state: 'open' | 'closed',
  head: string,
  base: string,
) {
  const owner = repository.split('/')[0]
  const query = new URLSearchParams({
    state,
    head: `${owner}:${head}`,
    base,
    sort: 'updated',
    direction: 'desc',
    per_page: '30',
  })
  return githubApi<GitHubPull[]>(
    config,
    `/repos/${repositoryPath(repository)}/pulls?${query}`,
  )
}

async function promotionStep(
  config: ConnectionConfig,
  repository: string,
  route: PromotionRoute,
  defaultBranch: string,
): Promise<PromotionStep> {
  const { fromBranch, toBranch } = promotionBranches(route, defaultBranch)
  const [comparison, openPulls, closedPulls] = await Promise.all([
    githubApi<{ ahead_by: number }>(
      config,
      `/repos/${repositoryPath(repository)}/compare/${encodeURIComponent(toBranch)}...${encodeURIComponent(fromBranch)}`,
    ),
    findPulls(config, repository, 'open', fromBranch, toBranch),
    findPulls(config, repository, 'closed', fromBranch, toBranch),
  ])
  const openPull = openPulls[0]
  const previous = closedPulls.find((pull) => pull.merged_at)
  return {
    route,
    fromBranch,
    toBranch,
    commitsAhead: comparison.ahead_by,
    state: openPull
      ? 'pr_open'
      : comparison.ahead_by > 0
        ? 'needs_pr'
        : 'up_to_date',
    pullRequest: openPull
      ? await promotionPullDetails(config, repository, openPull)
      : undefined,
    previousTemplate: previous
      ? {
          title: previous.title,
          body: previous.body ?? undefined,
          url: previous.html_url,
        }
      : undefined,
  }
}

async function pendingBackMerges(
  config: ConnectionConfig,
  repository: string,
  defaultBranch: string,
): Promise<PendingBackMerge[]> {
  const [defaultToRelease, releaseToDev] = await Promise.all([
    findPulls(config, repository, 'open', defaultBranch, 'release'),
    findPulls(config, repository, 'open', 'release', 'dev'),
  ])
  return [
    ...defaultToRelease.map((pull) => ({
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      fromBranch: defaultBranch,
      toBranch: 'release',
    })),
    ...releaseToDev.map((pull) => ({
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      fromBranch: 'release',
      toBranch: 'dev',
    })),
  ]
}

export async function getRepositoryReleaseState(
  config: ConnectionConfig,
  repository: string,
): Promise<RepositoryReleaseState> {
  assertConnectedRepository(config, repository)
  const metadata = await githubApi<GitHubRepository>(
    config,
    `/repos/${repositoryPath(repository)}`,
  )
  const [stagingReleases, promotionSteps, backMerges] = await Promise.all([
    listTrackedReleases(config, repository),
    Promise.all([
      promotionStep(
        config,
        repository,
        'dev-to-release',
        metadata.default_branch,
      ),
      promotionStep(
        config,
        repository,
        'release-to-default',
        metadata.default_branch,
      ),
    ]),
    pendingBackMerges(config, repository, metadata.default_branch),
  ])
  return {
    repository,
    defaultBranch: metadata.default_branch,
    stagingReleases,
    deployedTags: [],
    deploymentLookupFailed: false,
    promotionSteps,
    pendingBackMerges: backMerges,
    jenkinsServices: servicesForRepository(repository),
    fetchedAt: new Date().toISOString(),
  }
}

export async function getRepositoryBackMergeStatus(
  config: ConnectionConfig,
  repository: string,
) {
  assertConnectedRepository(config, repository)
  const key = `${config.githubOrg}:${repository}`.toLowerCase()
  const cached = riskCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const value = (async () => {
    const metadata = await githubApi<GitHubRepository>(
      config,
      `/repos/${repositoryPath(repository)}`,
    )
    return pendingBackMerges(config, repository, metadata.default_branch)
  })()
  riskCache.set(key, { expiresAt: Date.now() + RISK_CACHE_MS, value })
  value.catch(() => riskCache.delete(key))
  return value
}

export async function getRepositoryRisks(
  config: ConnectionConfig,
  repositories: string[],
): Promise<RepositoryRisk[]> {
  const results: RepositoryRisk[] = new Array(repositories.length)
  let cursor = 0
  async function worker() {
    while (cursor < repositories.length) {
      const index = cursor++
      const repository = repositories[index]
      try {
        const backMerges = await getRepositoryBackMergeStatus(
          config,
          repository,
        )
        results[index] = {
          repository,
          backMergePending: backMerges.length > 0,
          checkFailed: false,
        }
      } catch {
        results[index] = {
          repository,
          backMergePending: false,
          checkFailed: true,
        }
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(6, repositories.length) },
      () => worker(),
    ),
  )
  return results
}

export async function createPromotionPullRequest(
  config: ConnectionConfig,
  repository: string,
  route: PromotionRoute,
): Promise<PromotionPullRequest> {
  assertConnectedRepository(config, repository)
  const metadata = await githubApi<GitHubRepository>(
    config,
    `/repos/${repositoryPath(repository)}`,
  )
  const step = await promotionStep(
    config,
    repository,
    route,
    metadata.default_branch,
  )
  if (step.pullRequest) return step.pullRequest
  if (step.commitsAhead === 0) {
    throw new ProviderError(
      `${step.fromBranch} has no changes to promote to ${step.toBranch}.`,
      'NO_CHANGES_TO_PROMOTE',
      'github',
      409,
    )
  }
  const created = await githubApi<GitHubPull>(
    config,
    `/repos/${repositoryPath(repository)}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        title:
          step.previousTemplate?.title ??
          `Promote ${step.fromBranch} to ${step.toBranch}`,
        body:
          step.previousTemplate?.body ??
          `Promotes the current ${step.fromBranch} branch to ${step.toBranch}.`,
        head: step.fromBranch,
        base: step.toBranch,
        draft: false,
      }),
    },
  )
  return promotionPullDetails(config, repository, created)
}

export async function mergePromotionPullRequest(
  config: ConnectionConfig,
  repository: string,
  pullNumber: number,
): Promise<MergePromotionPullRequestResult> {
  assertConnectedRepository(config, repository)
  const metadata = await githubApi<GitHubRepository>(
    config,
    `/repos/${repositoryPath(repository)}`,
  )
  const backMerges = await pendingBackMerges(
    config,
    repository,
    metadata.default_branch,
  )
  if (backMerges.length > 0) {
    throw new ProviderError(
      `Resolve pending back-merge PRs first: ${backMerges.map((pull) => `#${pull.number}`).join(', ')}.`,
      'PENDING_BACK_MERGES',
      'github',
      409,
    )
  }
  const pull = await githubApi<GitHubPull>(
    config,
    `/repos/${repositoryPath(repository)}/pulls/${pullNumber}`,
  )
  const validRoute =
    (pull.head.ref === 'dev' && pull.base.ref === 'release') ||
    (pull.head.ref === 'release' &&
      pull.base.ref === metadata.default_branch)
  if (!validRoute) {
    throw new ProviderError(
      'Only Dev → Release or Release → default branch PRs can be merged here.',
      'INVALID_PROMOTION_PR',
      'github',
      409,
    )
  }
  const result = await githubApi<MergePromotionPullRequestResult>(
    config,
    `/repos/${repositoryPath(repository)}/pulls/${pullNumber}/merge`,
    {
      method: 'PUT',
      body: JSON.stringify({ merge_method: 'merge' }),
    },
  )
  clearRepositoryCaches(config, repository)
  return result
}

export async function mergeFeaturePullRequest(
  config: ConnectionConfig,
  repository: string,
  pullNumber: number,
): Promise<MergePromotionPullRequestResult> {
  assertConnectedRepository(config, repository)
  const metadata = await githubApi<GitHubRepository>(
    config,
    `/repos/${repositoryPath(repository)}`,
  )
  const backMerges = await pendingBackMerges(
    config,
    repository,
    metadata.default_branch,
  )
  if (backMerges.length > 0) {
    throw new ProviderError(
      `Resolve pending back-merge PRs first: ${backMerges.map((pull) => `#${pull.number}`).join(', ')}.`,
      'PENDING_BACK_MERGES',
      'github',
      409,
    )
  }

  const pull = await githubApi<GitHubPull>(
    config,
    `/repos/${repositoryPath(repository)}/pulls/${pullNumber}`,
  )
  if (pull.base.ref !== 'dev') {
    throw new ProviderError(
      'Only feature PRs targeting dev can be merged from this action.',
      'INVALID_FEATURE_PR',
      'github',
      409,
    )
  }
  if (!/\bOH-\d+\b/i.test(pull.title)) {
    throw new ProviderError(
      'The PR title must contain an OH Jira ticket key.',
      'MISSING_JIRA_KEY',
      'github',
      409,
    )
  }
  if (pull.draft || pull.merged_at) {
    throw new ProviderError(
      pull.draft ? 'Draft PRs cannot be merged.' : 'This PR is already merged.',
      'FEATURE_PR_NOT_OPEN',
      'github',
      409,
    )
  }
  const details = await promotionPullDetails(config, repository, pull)
  if (details.reviewDecision !== 'approved') {
    throw new ProviderError(
      details.reviewDecision === 'changes_requested'
        ? 'The PR has requested changes.'
        : 'The PR requires approval.',
      'FEATURE_PR_NOT_APPROVED',
      'github',
      409,
    )
  }
  if (details.mergeable === null) {
    throw new ProviderError(
      'GitHub is still calculating mergeability.',
      'FEATURE_PR_NOT_MERGEABLE',
      'github',
      409,
    )
  }
  if (hasActualMergeConflict(details.mergeable, details.mergeableState)) {
    throw new ProviderError(
      'The PR has merge conflicts.',
      'FEATURE_PR_NOT_MERGEABLE',
      'github',
      409,
    )
  }
  if (details.checks === 'pending') {
    throw new ProviderError(
      'Required checks are still pending.',
      'FEATURE_PR_CHECKS_BLOCKING',
      'github',
      409,
    )
  }

  const result = await githubApi<MergePromotionPullRequestResult>(
    config,
    `/repos/${repositoryPath(repository)}/pulls/${pullNumber}/merge`,
    {
      method: 'PUT',
      body: JSON.stringify({ merge_method: 'merge' }),
    },
  )
  clearRepositoryCaches(config, repository)
  return result
}

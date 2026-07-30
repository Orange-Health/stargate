import type {
  BackMergeRoute,
  BackMergeStep,
  BuildStatus,
  CheckStatus,
  ConnectionConfig,
  LatestProductionTagDelta,
  MergePromotionPullRequestResult,
  PendingBackMerge,
  PromotionPullRequest,
  PromotionRoute,
  PromotionStep,
  ReleaseBuildStatusInput,
  ReleaseBuildStatusResult,
  ReleaseControlRoomState,
  RepositoryReleaseHistory,
  RepositoryReleaseState,
  RepositoryPullRequestList,
  RepositoryRisk,
  ReviewDecision,
  StagingEnvironment,
  TrackedProductionRelease,
  TrackedStagingRelease,
  WorkflowRun,
} from '../../src/shared/types.js'
import { ProviderError } from '../errors.js'
import {
  clearGitHubProviderCache,
  githubApi,
  mergePullRequestViaGraphql,
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
  published_at?: string | null
  body?: string | null
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
  node_id: string
  title: string
  body: string | null
  html_url: string
  draft: boolean
  state: 'open' | 'closed'
  merged_at: string | null
  mergeable: boolean | null
  mergeable_state: string
  updated_at: string
  user: { login: string }
  base: { ref: string }
  head: {
    ref: string
    sha: string
    repo: { full_name: string } | null
  }
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
const productionTagPattern = /^(?:v-prod-|v-?)\d{2}\.\d{4}\.\d+$/
const RISK_CACHE_MS = 45_000
const REPOSITORY_STATE_CACHE_MS = 30_000
type BackMergeRiskStatus = {
  pendingPulls: PendingBackMerge[]
  outdated: boolean
}
const riskCache = new Map<
  string,
  { expiresAt: number; value: Promise<BackMergeRiskStatus> }
>()
const qaBuildCache = new Map<
  string,
  { expiresAt: number; value: Promise<string | undefined> }
>()
const repositoryStateCache = new Map<
  string,
  { expiresAt: number; value: Promise<RepositoryReleaseState> }
>()
const controlRoomStateCache = new Map<
  string,
  { expiresAt: number; value: Promise<ReleaseControlRoomState> }
>()
const terminalBuildCache = new Map<string, WorkflowRun[]>()

export function clearRepositoryCaches(
  config: ConnectionConfig,
  repository: string,
  searchIssueKeys: string[] = [],
  includeBuilds = false,
) {
  clearGitHubProviderCache(repository, searchIssueKeys)
  const key = `${config.githubOrg}:${repository}`.toLowerCase()
  riskCache.delete(key)
  qaBuildCache.delete(key)
  repositoryStateCache.delete(key)
  repositoryStateCache.delete(`${key}:all-v`)
  controlRoomStateCache.delete(key)
  if (includeBuilds) {
    const buildPrefix = `${key}:`
    for (const buildKey of terminalBuildCache.keys()) {
      if (buildKey.startsWith(buildPrefix)) terminalBuildCache.delete(buildKey)
    }
  }
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

export function releaseTimestamp(release: {
  created_at: string
  published_at?: string | null
}) {
  return release.published_at ?? release.created_at
}

export function sortReleasesNewestFirst<
  T extends { created_at: string; published_at?: string | null },
>(releases: T[]) {
  return [...releases].sort(
    (left, right) =>
      new Date(releaseTimestamp(right)).getTime() -
      new Date(releaseTimestamp(left)).getTime(),
  )
}

function mapWorkflowRun(run: GitHubWorkflowRun): WorkflowRun {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion ?? undefined,
    url: run.html_url,
    startedAt: run.run_started_at,
    updatedAt: run.updated_at,
  }
}

async function listReleaseRuns(
  config: ConnectionConfig,
  repository: string,
  release: GitHubRelease,
  forceRefresh = false,
): Promise<WorkflowRun[]> {
  const cacheKey =
    `${config.githubOrg}:${repository}:${release.tag_name}`.toLowerCase()
  const cached = terminalBuildCache.get(cacheKey)
  if (cached && !forceRefresh) return cached
  const query = new URLSearchParams({
    branch: release.tag_name,
    per_page: '100',
  })
  const response = await githubApi<{ workflow_runs: GitHubWorkflowRun[] }>(
    config,
    `/repos/${repositoryPath(repository)}/actions/runs?${query}`,
  )

  const runs = response.workflow_runs
    .filter(
      (run) =>
        run.head_branch === release.tag_name ||
        new Date(run.run_started_at).getTime() >=
          new Date(releaseTimestamp(release)).getTime() - 60_000,
    )
    .map(mapWorkflowRun)
  if (
    ['succeeded', 'failed', 'canceled'].includes(aggregateBuildStatus(runs))
  ) {
    terminalBuildCache.set(cacheKey, runs)
  }
  return runs
}

export async function getReleaseBuildStatuses(
  config: ConnectionConfig,
  releases: ReleaseBuildStatusInput[],
  forceRefresh = false,
): Promise<ReleaseBuildStatusResult[]> {
  const results: ReleaseBuildStatusResult[] = new Array(releases.length)
  let cursor = 0
  async function worker() {
    while (cursor < releases.length) {
      const index = cursor++
      const release = releases[index]
      assertConnectedRepository(config, release.repository)
      const runs = await listReleaseRuns(
        config,
        release.repository,
        {
          id: 0,
          tag_name: release.tag,
          html_url: '',
          prerelease: false,
          created_at: release.createdAt,
        },
        forceRefresh,
      )
      results[index] = {
        ...release,
        buildStatus: aggregateBuildStatus(runs),
        runs,
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(3, releases.length) }, () => worker()),
  )
  return results
}

async function listTrackedReleases(
  config: ConnectionConfig,
  repository: string,
  limit = 3,
  includeAllVReleases = false,
): Promise<{
  stagingReleases: TrackedStagingRelease[]
  productionReleases: TrackedProductionRelease[]
}> {
  const [releases, recentRuns] = await Promise.all([
    githubApi<GitHubRelease[]>(
      config,
      `/repos/${repositoryPath(repository)}/releases?per_page=30`,
    ),
    includeAllVReleases
      ? githubApi<{ workflow_runs: GitHubWorkflowRun[] }>(
          config,
          `/repos/${repositoryPath(repository)}/actions/runs?per_page=100`,
        ).then((response) => response.workflow_runs)
      : Promise.resolve([]),
  ])
  const staging = sortReleasesNewestFirst(
    releases.filter(
      (release) =>
        includeAllVReleases
          ? release.tag_name.startsWith('v-') &&
            !productionTagPattern.test(release.tag_name)
          : release.prerelease && stagingTagPattern.test(release.tag_name),
    ),
  )
    .slice(0, limit)

  const production = sortReleasesNewestFirst(
    releases.filter(
      (release) =>
        !release.prerelease &&
        productionTagPattern.test(release.tag_name),
    ),
  )
    .slice(0, limit)

  const releaseBackedStaging: TrackedStagingRelease[] = await Promise.all(
    staging.map(async (release) => {
      const runs = await listReleaseRuns(config, repository, release)
      return {
        id: release.id,
        tag: release.tag_name,
        environment:
          (stagingTagPattern.exec(release.tag_name)?.[1] as
            | StagingEnvironment
            | undefined) ?? 'custom',
        url: release.html_url,
        createdAt: releaseTimestamp(release),
        buildStatus: aggregateBuildStatus(runs),
        runs,
      }
    }),
  )
  const releaseTags = new Set(
    [
      ...releaseBackedStaging.map((release) => release.tag),
      ...production.map((release) => release.tag_name),
    ],
  )
  const runsByTag = new Map<string, GitHubWorkflowRun[]>()
  if (includeAllVReleases) {
    for (const run of recentRuns) {
      const tag = run.head_branch
      if (!tag?.startsWith('v-') || releaseTags.has(tag)) continue
      const current = runsByTag.get(tag) ?? []
      current.push(run)
      runsByTag.set(tag, current)
    }
  }
  const actionOnlyBuilds: TrackedStagingRelease[] = [...runsByTag]
    .filter(([tag]) => !productionTagPattern.test(tag))
    .map(([tag, tagRuns]) => {
      const runs = tagRuns.map(mapWorkflowRun)
      const latest = [...runs].sort(
        (left, right) =>
          new Date(right.startedAt).getTime() -
          new Date(left.startedAt).getTime(),
      )[0]
      return {
        id: latest.id,
        tag,
        environment:
          (stagingTagPattern.exec(tag)?.[1] as
            | StagingEnvironment
            | undefined) ?? 'custom',
        url: latest.url,
        createdAt: latest.startedAt,
        buildStatus: aggregateBuildStatus(runs),
        runs,
      }
    })
  const stagingReleases = [
    ...releaseBackedStaging,
    ...actionOnlyBuilds,
  ]
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    )
    .slice(0, limit)
  const releaseBackedProduction = await Promise.all(
    production.map(async (release) => {
      const runs = await listReleaseRuns(config, repository, release)
      return {
        id: release.id,
        tag: release.tag_name,
        url: release.html_url,
        createdAt: releaseTimestamp(release),
        description: release.body?.trim() || undefined,
        buildStatus: aggregateBuildStatus(runs),
        runs,
      }
    }),
  )
  const actionOnlyProduction: TrackedProductionRelease[] = [...runsByTag]
    .filter(([tag]) => productionTagPattern.test(tag))
    .map(([tag, tagRuns]) => {
      const runs = tagRuns.map(mapWorkflowRun)
      const latest = [...runs].sort(
        (left, right) =>
          new Date(right.startedAt).getTime() -
          new Date(left.startedAt).getTime(),
      )[0]
      return {
        id: latest.id,
        tag,
        url: latest.url,
        createdAt: latest.startedAt,
        buildStatus: aggregateBuildStatus(runs),
        runs,
      }
    })
  const productionReleases = [
    ...releaseBackedProduction,
    ...actionOnlyProduction,
  ]
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    )
    .slice(0, limit)
  return { stagingReleases, productionReleases }
}

async function listControlRoomProductionReleases(
  config: ConnectionConfig,
  repository: string,
  limit = 3,
): Promise<TrackedProductionRelease[]> {
  const [releases, recentRuns] = await Promise.all([
    githubApi<GitHubRelease[]>(
      config,
      `/repos/${repositoryPath(repository)}/releases?per_page=30`,
    ),
    githubApi<{ workflow_runs: GitHubWorkflowRun[] }>(
      config,
      `/repos/${repositoryPath(repository)}/actions/runs?per_page=100`,
    ).then((response) => response.workflow_runs),
  ])
  const production = sortReleasesNewestFirst(
    releases.filter(
      (release) =>
        !release.prerelease && productionTagPattern.test(release.tag_name),
    ),
  ).slice(0, limit)
  const runsByTag = new Map<string, GitHubWorkflowRun[]>()
  for (const run of recentRuns) {
    if (!run.head_branch) continue
    const runs = runsByTag.get(run.head_branch) ?? []
    runs.push(run)
    runsByTag.set(run.head_branch, runs)
  }
  return production.map((release) => {
    const runs = (runsByTag.get(release.tag_name) ?? []).map(mapWorkflowRun)
    return {
      id: release.id,
      tag: release.tag_name,
      url: release.html_url,
      createdAt: releaseTimestamp(release),
      description: release.body?.trim() || undefined,
      buildStatus: aggregateBuildStatus(runs),
      runs,
    }
  })
}

export async function getRepositoryReleaseHistory(
  config: ConnectionConfig,
  repository: string,
  includeAllVReleases = false,
): Promise<RepositoryReleaseHistory> {
  assertConnectedRepository(config, repository)
  return {
    repository,
    ...(await listTrackedReleases(
      config,
      repository,
      includeAllVReleases ? 30 : 12,
      includeAllVReleases,
    )),
  }
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
  const query = new URLSearchParams({
    state,
    base,
    sort: 'updated',
    direction: 'desc',
    per_page: '100',
  })
  const pulls = await githubApi<GitHubPull[]>(
    config,
    `/repos/${repositoryPath(repository)}/pulls?${query}`,
  )
  const normalizedRepository = repository.toLowerCase()
  return pulls.filter(
    (pull) =>
      pull.base.ref === base &&
      pull.head.ref === head &&
      pull.head.repo?.full_name.toLowerCase() === normalizedRepository,
  )
}

async function listPullsByState(
  config: ConnectionConfig,
  repository: string,
  state: 'open' | 'closed',
) {
  const query = new URLSearchParams({
    state,
    sort: 'updated',
    direction: 'desc',
    per_page: '100',
  })
  return githubApi<GitHubPull[]>(
    config,
    `/repos/${repositoryPath(repository)}/pulls?${query}`,
  )
}

function pullsForRoute(
  pulls: GitHubPull[],
  repository: string,
  head: string,
  base: string,
) {
  const normalizedRepository = repository.toLowerCase()
  return pulls.filter(
    (pull) =>
      pull.base.ref === base &&
      pull.head.ref === head &&
      pull.head.repo?.full_name.toLowerCase() === normalizedRepository,
  )
}

export async function listRepositoryPullRequests(
  config: ConnectionConfig,
  repository: string,
  options: {
    state: 'open' | 'closed' | 'all'
    base?: string
    author?: string
    page: number
  },
): Promise<RepositoryPullRequestList> {
  assertConnectedRepository(config, repository)
  const metadataPromise = githubApi<GitHubRepository>(
    config,
    `/repos/${repositoryPath(repository)}`,
  )
  let hasMore = false
  let pullsPromise: Promise<GitHubPull[]>
  if (options.author) {
    const qualifiers = [
      `repo:${repository}`,
      'is:pr',
      `author:${options.author}`,
      ...(options.state === 'all' ? [] : [`is:${options.state}`]),
      ...(options.base ? [`base:${options.base}`] : []),
    ]
    const searchQuery = new URLSearchParams({
      q: qualifiers.join(' '),
      sort: 'updated',
      order: 'desc',
      per_page: '5',
      page: String(options.page),
    })
    pullsPromise = githubApi<{
      total_count: number
      items: Array<{ number: number }>
    }>(config, `/search/issues?${searchQuery}`).then(async (search) => {
      hasMore = options.page * 5 < search.total_count
      return Promise.all(
        search.items.map((item) =>
          githubApi<GitHubPull>(
            config,
            `/repos/${repositoryPath(repository)}/pulls/${item.number}`,
          ),
        ),
      )
    })
  } else {
    const query = new URLSearchParams({
      state: options.state,
      sort: 'updated',
      direction: 'desc',
      per_page: '5',
      page: String(options.page),
    })
    if (options.base) query.set('base', options.base)
    pullsPromise = githubApi<GitHubPull[]>(
      config,
      `/repos/${repositoryPath(repository)}/pulls?${query}`,
    ).then((pulls) => {
      hasMore = pulls.length === 5
      return pulls
    })
  }
  const [metadata, pulls] = await Promise.all([metadataPromise, pullsPromise])
  return {
    repository,
    defaultBranch: metadata.default_branch,
    items: pulls.map((pull) => ({
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      state: pull.state,
      draft: pull.draft,
      merged: Boolean(pull.merged_at),
      author: pull.user.login,
      headBranch: pull.head.ref,
      baseBranch: pull.base.ref,
      updatedAt: pull.updated_at,
    })),
    page: options.page,
    hasMore,
  }
}

export async function listRepositoryPullRequestAuthors(
  config: ConnectionConfig,
  repository: string,
): Promise<string[]> {
  assertConnectedRepository(config, repository)
  const query = new URLSearchParams({
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: '100',
  })
  const pulls = await githubApi<GitHubPull[]>(
    config,
    `/repos/${repositoryPath(repository)}/pulls?${query}`,
  )
  return [...new Set(pulls.map((pull) => pull.user.login))].sort((left, right) =>
    left.localeCompare(right),
  )
}

type GitHubBranchComparison = {
  ahead_by: number
  behind_by: number
  files?: unknown[]
}

export function comparisonHasSourceFileChanges(
  comparison: GitHubBranchComparison,
) {
  return (
    comparison.ahead_by > 0 &&
    (!Array.isArray(comparison.files) || comparison.files.length > 0)
  )
}

export function comparisonHasAnyFileChanges(
  comparison: GitHubBranchComparison,
) {
  return Array.isArray(comparison.files)
    ? comparison.files.length > 0
    : comparison.ahead_by > 0 || comparison.behind_by > 0
}

async function promotionStep(
  config: ConnectionConfig,
  repository: string,
  route: PromotionRoute,
  defaultBranch: string,
  sharedOpenPulls?: GitHubPull[],
  includePreviousTemplate = true,
): Promise<PromotionStep> {
  const { fromBranch, toBranch } = promotionBranches(route, defaultBranch)
  const [comparison, openPulls] = await Promise.all([
    githubApi<GitHubBranchComparison>(
      config,
      `/repos/${repositoryPath(repository)}/compare/${encodeURIComponent(toBranch)}...${encodeURIComponent(fromBranch)}`,
    ),
    sharedOpenPulls
      ? Promise.resolve(
          pullsForRoute(sharedOpenPulls, repository, fromBranch, toBranch),
        )
      : findPulls(config, repository, 'open', fromBranch, toBranch),
  ])
  const openPull = openPulls[0]
  const hasFileChanges = comparisonHasSourceFileChanges(comparison)
  const previous =
    includePreviousTemplate && hasFileChanges && !openPull
      ? (
          await findPulls(
            config,
            repository,
            'closed',
            fromBranch,
            toBranch,
          )
        ).find((pull) => pull.merged_at)
      : undefined
  return {
    route,
    fromBranch,
    toBranch,
    commitsAhead: comparison.ahead_by,
    commitsBehind: comparison.behind_by,
    filesChanged: comparison.files?.length,
    state: !hasFileChanges
      ? 'up_to_date'
      : openPull
      ? 'pr_open'
      : 'needs_pr',
    pullRequest: hasFileChanges && openPull
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
  const [
    defaultToRelease,
    releaseToDev,
    defaultToReleaseComparison,
    releaseToDevComparison,
  ] = await Promise.all([
    findPulls(config, repository, 'open', defaultBranch, 'release'),
    findPulls(config, repository, 'open', 'release', 'dev'),
    githubApi<GitHubBranchComparison>(
      config,
      `/repos/${repositoryPath(repository)}/compare/release...${encodeURIComponent(defaultBranch)}`,
    ),
    githubApi<GitHubBranchComparison>(
      config,
      `/repos/${repositoryPath(repository)}/compare/dev...release`,
    ),
  ])
  return [
    ...(comparisonHasSourceFileChanges(defaultToReleaseComparison)
      ? defaultToRelease.map((pull) => ({
          number: pull.number,
          title: pull.title,
          url: pull.html_url,
          fromBranch: defaultBranch,
          toBranch: 'release',
        }))
      : []),
    ...(comparisonHasSourceFileChanges(releaseToDevComparison)
      ? releaseToDev.map((pull) => ({
          number: pull.number,
          title: pull.title,
          url: pull.html_url,
          fromBranch: 'release',
          toBranch: 'dev',
        }))
      : []),
  ]
}

export function backMergeBranches(
  route: BackMergeRoute,
  defaultBranch: string,
) {
  return route === 'default-to-release'
    ? { fromBranch: defaultBranch, toBranch: 'release' }
    : { fromBranch: 'release', toBranch: 'dev' }
}

async function backMergeStep(
  config: ConnectionConfig,
  repository: string,
  route: BackMergeRoute,
  defaultBranch: string,
  sharedOpenPulls?: GitHubPull[],
): Promise<BackMergeStep> {
  const { fromBranch, toBranch } = backMergeBranches(route, defaultBranch)
  const [comparison, openPulls] = await Promise.all([
    githubApi<GitHubBranchComparison>(
      config,
      `/repos/${repositoryPath(repository)}/compare/${encodeURIComponent(toBranch)}...${encodeURIComponent(fromBranch)}`,
    ),
    sharedOpenPulls
      ? Promise.resolve(
          pullsForRoute(sharedOpenPulls, repository, fromBranch, toBranch),
        )
      : findPulls(config, repository, 'open', fromBranch, toBranch),
  ])
  const openPull = openPulls[0]
  const hasFileChanges = comparisonHasSourceFileChanges(comparison)
  return {
    route,
    fromBranch,
    toBranch,
    commitsAhead: comparison.ahead_by,
    commitsBehind: comparison.behind_by,
    filesChanged: comparison.files?.length,
    state: !hasFileChanges
      ? 'up_to_date'
      : openPull
      ? 'pr_open'
      : 'needs_pr',
    pullRequest: hasFileChanges && openPull
      ? await promotionPullDetails(config, repository, openPull)
      : undefined,
  }
}

async function latestProductionTagDelta(
  config: ConnectionConfig,
  repository: string,
  defaultBranch: string,
  productionReleases: TrackedProductionRelease[],
): Promise<LatestProductionTagDelta | undefined> {
  const latest = productionReleases[0]
  if (!latest) return undefined
  const comparison = await githubApi<GitHubBranchComparison>(
    config,
    `/repos/${repositoryPath(repository)}/compare/${encodeURIComponent(latest.tag)}...${encodeURIComponent(defaultBranch)}`,
  )
  return {
    tag: latest.tag,
    commitsAhead: comparison.ahead_by,
    filesChanged: comparison.files?.length ?? 0,
    hasSourceChanges: comparisonHasSourceFileChanges(comparison),
  }
}

async function loadRepositoryReleaseState(
  config: ConnectionConfig,
  repository: string,
  includeAllVReleases = false,
): Promise<RepositoryReleaseState> {
  assertConnectedRepository(config, repository)
  const metadata = await githubApi<GitHubRepository>(
    config,
    `/repos/${repositoryPath(repository)}`,
  )
  const openPullsPromise = listPullsByState(config, repository, 'open')
  const [trackedReleases, openPulls] = await Promise.all([
    listTrackedReleases(
      config,
      repository,
      includeAllVReleases ? 30 : 3,
      includeAllVReleases,
    ),
    openPullsPromise,
  ])
  const [promotionSteps, backMergeSteps] = await Promise.all([
    Promise.all([
      promotionStep(
        config,
        repository,
        'dev-to-release',
        metadata.default_branch,
        openPulls,
      ),
      promotionStep(
        config,
        repository,
        'release-to-default',
        metadata.default_branch,
        openPulls,
      ),
    ]),
    Promise.all([
      backMergeStep(
        config,
        repository,
        'default-to-release',
        metadata.default_branch,
        openPulls,
      ),
      backMergeStep(
        config,
        repository,
        'release-to-dev',
        metadata.default_branch,
        openPulls,
      ),
    ]),
  ])
  const backMerges = backMergeSteps.flatMap((step) =>
    step.pullRequest
      ? [
          {
            number: step.pullRequest.number,
            title: step.pullRequest.title,
            url: step.pullRequest.url,
            fromBranch: step.fromBranch,
            toBranch: step.toBranch,
          },
        ]
      : [],
  )
  const tagDelta = await latestProductionTagDelta(
    config,
    repository,
    metadata.default_branch,
    trackedReleases.productionReleases,
  )
  return {
    repository,
    defaultBranch: metadata.default_branch,
    stagingReleases: trackedReleases.stagingReleases,
    productionReleases: trackedReleases.productionReleases,
    latestProductionTagDelta: tagDelta,
    deployedTags: [],
    deploymentLookupFailed: false,
    productionReady: promotionSteps.some(
      (step) =>
        step.route === 'release-to-default' &&
        (step.filesChanged === 0 ||
          (step.filesChanged === undefined &&
            step.commitsAhead === 0 &&
            step.commitsBehind === 0)),
    ),
    promotionSteps,
    backMergeSteps,
    pendingBackMerges: backMerges,
    jenkinsServices: servicesForRepository(repository),
    fetchedAt: new Date().toISOString(),
  }
}

export function getRepositoryReleaseState(
  config: ConnectionConfig,
  repository: string,
  includeAllVReleases = false,
): Promise<RepositoryReleaseState> {
  assertConnectedRepository(config, repository)
  const baseKey = `${config.githubOrg}:${repository}`.toLowerCase()
  const key = includeAllVReleases ? `${baseKey}:all-v` : baseKey
  const cached = repositoryStateCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const value = loadRepositoryReleaseState(
    config,
    repository,
    includeAllVReleases,
  )
  repositoryStateCache.set(key, {
    expiresAt: Date.now() + REPOSITORY_STATE_CACHE_MS,
    value,
  })
  value.catch(() => repositoryStateCache.delete(key))
  return value
}

async function loadReleaseControlRoomState(
  config: ConnectionConfig,
  repository: string,
): Promise<ReleaseControlRoomState> {
  assertConnectedRepository(config, repository)
  const [metadata, productionReleases, openPulls] = await Promise.all([
    githubApi<GitHubRepository>(
      config,
      `/repos/${repositoryPath(repository)}`,
    ),
    listControlRoomProductionReleases(config, repository),
    listPullsByState(config, repository, 'open'),
  ])
  const promotionSteps = await Promise.all([
    promotionStep(
      config,
      repository,
      'dev-to-release',
      metadata.default_branch,
      openPulls,
      false,
    ),
    promotionStep(
      config,
      repository,
      'release-to-default',
      metadata.default_branch,
      openPulls,
      false,
    ),
  ])
  const tagDelta = await latestProductionTagDelta(
    config,
    repository,
    metadata.default_branch,
    productionReleases,
  )
  return {
    repository,
    defaultBranch: metadata.default_branch,
    productionReleases,
    latestProductionTagDelta: tagDelta,
    deployedTags: [],
    deploymentLookupFailed: false,
    productionReady: promotionSteps.some(
      (step) =>
        step.route === 'release-to-default' &&
        (step.filesChanged === 0 ||
          (step.filesChanged === undefined &&
            step.commitsAhead === 0 &&
            step.commitsBehind === 0)),
    ),
    promotionSteps,
    jenkinsServices: servicesForRepository(repository),
    fetchedAt: new Date().toISOString(),
  }
}

export function getReleaseControlRoomState(
  config: ConnectionConfig,
  repository: string,
): Promise<ReleaseControlRoomState> {
  assertConnectedRepository(config, repository)
  const key = `${config.githubOrg}:${repository}`.toLowerCase()
  const cached = controlRoomStateCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const value = loadReleaseControlRoomState(config, repository)
  controlRoomStateCache.set(key, {
    expiresAt: Date.now() + REPOSITORY_STATE_CACHE_MS,
    value,
  })
  value.catch(() => controlRoomStateCache.delete(key))
  return value
}

export async function assertProductionBranchesIdentical(
  config: ConnectionConfig,
  repository: string,
) {
  assertConnectedRepository(config, repository)
  const metadata = await githubApi<GitHubRepository>(
    config,
    `/repos/${repositoryPath(repository)}`,
  )
  const comparison = await githubApi<GitHubBranchComparison>(
    config,
    `/repos/${repositoryPath(repository)}/compare/${encodeURIComponent(metadata.default_branch)}...release`,
  )
  if (comparisonHasAnyFileChanges(comparison)) {
    throw new ProviderError(
      `Production deployment is blocked: release and ${metadata.default_branch} are not identical.`,
      'PRODUCTION_BRANCHES_DIFFER',
      'github',
      409,
    )
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
    const steps = await Promise.all([
      backMergeStep(
        config,
        repository,
        'default-to-release',
        metadata.default_branch,
      ),
      backMergeStep(
        config,
        repository,
        'release-to-dev',
        metadata.default_branch,
      ),
    ])
    const pendingPulls = steps.flatMap((step) =>
      step.state === 'pr_open' && step.pullRequest
        ? [
            {
              number: step.pullRequest.number,
              title: step.pullRequest.title,
              url: step.pullRequest.url,
              fromBranch: step.fromBranch,
              toBranch: step.toBranch,
            },
          ]
        : [],
    )
    return {
      pendingPulls,
      outdated: steps.some((step) => step.state !== 'up_to_date'),
    }
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
        const backMergeStatus = await getRepositoryBackMergeStatus(
          config,
          repository,
        )
        results[index] = {
          repository,
          backMergePending: backMergeStatus.pendingPulls.length > 0,
          backMergeOutdated: backMergeStatus.outdated,
          checkFailed: false,
        }
      } catch {
        results[index] = {
          repository,
          backMergePending: false,
          backMergeOutdated: false,
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
  if (step.pullRequest) {
    return { ...step.pullRequest, resolution: 'existing' }
  }
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
  clearRepositoryCaches(config, repository)
  return {
    ...(await promotionPullDetails(config, repository, created)),
    resolution: 'created',
  }
}

export async function createBackMergePullRequest(
  config: ConnectionConfig,
  repository: string,
  route: BackMergeRoute,
): Promise<PromotionPullRequest> {
  assertConnectedRepository(config, repository)
  const metadata = await githubApi<GitHubRepository>(
    config,
    `/repos/${repositoryPath(repository)}`,
  )
  const step = await backMergeStep(
    config,
    repository,
    route,
    metadata.default_branch,
  )
  if (step.pullRequest) return step.pullRequest
  if (step.commitsAhead === 0) {
    throw new ProviderError(
      `${step.fromBranch} has no changes to back-merge into ${step.toBranch}.`,
      'NO_CHANGES_TO_BACK_MERGE',
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
        title: `Back-merge ${step.fromBranch} into ${step.toBranch}`,
        body: `Back-merges the current ${step.fromBranch} branch into ${step.toBranch} to keep the branches synchronized.`,
        head: step.fromBranch,
        base: step.toBranch,
        draft: false,
      }),
    },
  )
  clearRepositoryCaches(config, repository)
  return promotionPullDetails(config, repository, created)
}

async function forceMergePullRequest(
  config: ConnectionConfig,
  repository: string,
  pull: GitHubPull,
): Promise<MergePromotionPullRequestResult> {
  if (!pull.node_id) {
    throw new ProviderError(
      'Pull request node_id is required for force merge.',
      'PR_MISSING_NODE_ID',
      'github',
      502,
    )
  }
  const merged = await mergePullRequestViaGraphql(config, pull.node_id, 'MERGE')
  clearRepositoryCaches(config, repository)
  return {
    merged: merged.merged,
    message: 'Force-merged with branch protection bypass.',
    sha: merged.sha,
  }
}

export async function mergeRepositoryPullRequest(
  config: ConnectionConfig,
  repository: string,
  pullNumber: number,
): Promise<MergePromotionPullRequestResult> {
  assertConnectedRepository(config, repository)
  const pull = await githubApi<GitHubPull>(
    config,
    `/repos/${repositoryPath(repository)}/pulls/${pullNumber}`,
  )
  if (pull.state !== 'open' || pull.merged_at) {
    throw new ProviderError(
      'Only open, unmerged pull requests can be merged.',
      'PULL_REQUEST_NOT_OPEN',
      'github',
      409,
    )
  }
  if (pull.draft) {
    throw new ProviderError(
      'Draft pull requests cannot be merged.',
      'PULL_REQUEST_IS_DRAFT',
      'github',
      409,
    )
  }
  if (pull.mergeable === false) {
    throw new ProviderError(
      'This pull request has merge conflicts.',
      'PULL_REQUEST_CONFLICT',
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
  if (result.merged) clearRepositoryCaches(config, repository)
  return result
}

export async function mergePromotionPullRequest(
  config: ConnectionConfig,
  repository: string,
  pullNumber: number,
  bypassBranchProtection = false,
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
  if (bypassBranchProtection) {
    if (pull.draft || pull.merged_at) {
      throw new ProviderError(
        pull.draft
          ? 'Draft promotion PRs cannot be merged.'
          : 'This promotion PR is already merged.',
        'PROMOTION_PR_NOT_OPEN',
        'github',
        409,
      )
    }
    const details = await promotionPullDetails(config, repository, pull)
    if (details.mergeable === null) {
      throw new ProviderError(
        'GitHub is still calculating mergeability.',
        'PROMOTION_PR_NOT_MERGEABLE',
        'github',
        409,
      )
    }
    if (hasActualMergeConflict(details.mergeable, details.mergeableState)) {
      throw new ProviderError(
        'The promotion PR has merge conflicts.',
        'PROMOTION_PR_NOT_MERGEABLE',
        'github',
        409,
      )
    }
    return forceMergePullRequest(config, repository, pull)
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

export async function mergeBackMergePullRequest(
  config: ConnectionConfig,
  repository: string,
  pullNumber: number,
  bypassBranchProtection = false,
): Promise<MergePromotionPullRequestResult> {
  assertConnectedRepository(config, repository)
  const metadata = await githubApi<GitHubRepository>(
    config,
    `/repos/${repositoryPath(repository)}`,
  )
  const pull = await githubApi<GitHubPull>(
    config,
    `/repos/${repositoryPath(repository)}/pulls/${pullNumber}`,
  )
  const validRoute =
    (pull.head.ref === metadata.default_branch &&
      pull.base.ref === 'release') ||
    (pull.head.ref === 'release' && pull.base.ref === 'dev')
  if (!validRoute) {
    throw new ProviderError(
      'Only default → release or release → dev back-merge PRs can be merged here.',
      'INVALID_BACK_MERGE_PR',
      'github',
      409,
    )
  }
  if (pull.draft || pull.merged_at) {
    throw new ProviderError(
      pull.draft
        ? 'Draft back-merge PRs cannot be merged.'
        : 'This back-merge PR is already merged.',
      'BACK_MERGE_PR_NOT_OPEN',
      'github',
      409,
    )
  }
  const details = await promotionPullDetails(config, repository, pull)
  if (details.mergeable === null) {
    throw new ProviderError(
      'GitHub is still calculating mergeability.',
      'BACK_MERGE_NOT_MERGEABLE',
      'github',
      409,
    )
  }
  if (hasActualMergeConflict(details.mergeable, details.mergeableState)) {
    throw new ProviderError(
      'The back-merge PR has merge conflicts.',
      'BACK_MERGE_NOT_MERGEABLE',
      'github',
      409,
    )
  }
  if (!bypassBranchProtection && details.checks === 'pending') {
    throw new ProviderError(
      'Required checks are still pending.',
      'BACK_MERGE_CHECKS_PENDING',
      'github',
      409,
    )
  }
  if (bypassBranchProtection) {
    return forceMergePullRequest(config, repository, pull)
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
  retargetToDev = false,
  bypassBranchProtection = false,
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

  let pull = await githubApi<GitHubPull>(
    config,
    `/repos/${repositoryPath(repository)}/pulls/${pullNumber}`,
  )
  if (pull.base.ref !== 'dev') {
    if (retargetToDev && pull.base.ref === metadata.default_branch) {
      pull = await githubApi<GitHubPull>(
        config,
        `/repos/${repositoryPath(repository)}/pulls/${pullNumber}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ base: 'dev' }),
        },
      )
    } else {
      throw new ProviderError(
        retargetToDev
          ? 'Only feature PRs targeting the default branch can be retargeted to dev.'
          : 'Only feature PRs targeting dev can be merged from this action.',
        'INVALID_FEATURE_PR',
        'github',
        409,
      )
    }
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
  if (!bypassBranchProtection && details.reviewDecision !== 'approved') {
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
  if (!bypassBranchProtection && details.checks === 'pending') {
    throw new ProviderError(
      'Required checks are still pending.',
      'FEATURE_PR_CHECKS_BLOCKING',
      'github',
      409,
    )
  }

  if (bypassBranchProtection) {
    return forceMergePullRequest(config, repository, pull)
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

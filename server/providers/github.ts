import type {
  CheckStatus,
  ConnectionConfig,
  CreatedProductionRelease,
  CreatedStagingRelease,
  DashboardProgress,
  PullRequest,
  RateLimit,
  ReviewDecision,
  StagingEnvironment,
} from '../../src/shared/types.js'
import { isClosedWithoutMerge } from '../../src/shared/pullRequests.js'
import { usesFrontendProductionTag } from '../../src/shared/productionRepositories.js'
import { ProviderError, providerResponseError } from '../errors.js'

type GitHubSearchItem = {
  id: number
  number: number
  title: string
  repository_url: string
  state?: 'open' | 'closed'
  pull_request?: { merged_at?: string | null }
}

type GitHubPull = {
  id: number
  number: number
  title: string
  html_url: string
  state: 'open' | 'closed'
  draft: boolean
  merged: boolean
  mergeable: boolean | null
  mergeable_state: string
  base: { ref: string; repo: { full_name: string } }
  head: { ref: string; sha: string }
  user: { login: string; avatar_url: string }
  assignees: Array<{ login: string; avatar_url: string }>
  updated_at: string
}

type GitHubReview = {
  user: { login: string; avatar_url: string }
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  submitted_at?: string
}

export type GitHubDiscovery = {
  byIssue: Map<string, PullRequest[]>
  rateLimit?: RateLimit
  warnings: string[]
}

type GraphqlActor = {
  login?: string
  avatarUrl?: string
}

type GraphqlPullRequest = {
  databaseId: number | null
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED'
  isDraft: boolean
  merged: boolean
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null
  mergeStateStatus: string
  baseRefName: string
  headRefName: string
  updatedAt: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  author: GraphqlActor | null
  assignees: { nodes: GraphqlActor[] }
  latestReviews: {
    nodes: Array<{
      author: GraphqlActor | null
      state: string
    }>
  }
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: { state: string } | null
      }
    }>
  }
}

type GraphqlRepositoryPull = {
  pullRequest: GraphqlPullRequest | null
} | null

let latestRateLimit: RateLimit | undefined
const PROVIDER_CACHE_MS = 30_000
const CONDITIONAL_CACHE_MAX_ENTRIES = 2_000
// 15 keeps GraphQL complexity under GitHub's per-query budget; raise if point cost stays low
const GRAPHQL_PULL_BATCH_SIZE = 15
type ConditionalCacheEntry = {
  etag: string
  body: unknown
}
const conditionalCaches = new WeakMap<
  ConnectionConfig,
  Map<string, ConditionalCacheEntry>
>()
const knownConditionalCaches = new Set<
  Map<string, ConditionalCacheEntry>
>()
const pullCache = new Map<
  string,
  { expiresAt: number; value: Promise<PullRequest> }
>()
const searchCache = new Map<
  string,
  {
    expiresAt: number
    value: Promise<Array<{ issueKey: string; item: GitHubSearchItem }>>
  }
>()

function conditionalCache(config: ConnectionConfig) {
  let cache = conditionalCaches.get(config)
  if (!cache) {
    cache = new Map()
    conditionalCaches.set(config, cache)
  }
  knownConditionalCaches.add(cache)
  return cache
}

function cacheConditionalResponse(
  cache: Map<string, ConditionalCacheEntry>,
  key: string,
  entry: ConditionalCacheEntry,
) {
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > CONDITIONAL_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) cache.delete(oldestKey)
  }
}

export function clearGitHubProviderCache(
  repository?: string,
  searchIssueKeys: string[] = [],
) {
  if (!repository) {
    pullCache.clear()
    searchCache.clear()
    latestRateLimit = undefined
    for (const cache of knownConditionalCaches) cache.clear()
    knownConditionalCaches.clear()
    githubRequestScheduler.reset()
    return
  }
  const prefix = `${repository.toLowerCase()}#`
  for (const key of pullCache.keys()) {
    if (key.startsWith(prefix)) pullCache.delete(key)
  }
  const normalizedIssueKeys = searchIssueKeys.map((key) => key.toLowerCase())
  for (const key of searchCache.keys()) {
    if (
      normalizedIssueKeys.some((issueKey) =>
        key.toLowerCase().endsWith(`:${issueKey}`),
      )
    ) {
      searchCache.delete(key)
    }
  }
  const repositoryMarker = `/repos/${repository.toLowerCase()}`
  for (const cache of knownConditionalCaches) {
    for (const key of cache.keys()) {
      const normalized = key.toLowerCase()
      if (
        normalized.includes(repositoryMarker) ||
        (normalized.includes('/search/') &&
          normalizedIssueKeys.some((issueKey) =>
            normalized.includes(issueKey),
          ))
      ) {
        cache.delete(key)
      }
    }
  }
}

function githubHeaders(config: ConnectionConfig) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.githubToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

type ScheduledGitHubRequest = {
  id: number
  method: string
  task: () => Promise<Response>
  resolve: (response: Response) => void
  reject: (error: unknown) => void
  maxRetries: number
}

const MAX_CONCURRENT_GITHUB_READS = 5
const MUTATION_PAUSE_MS = 1_000
const MAX_GITHUB_RETRIES = 2
const MAX_GITHUB_SEARCH_RETRIES = 5
const SEARCH_CONCURRENCY = 2
const SEARCH_SPACING_MS = 1_000
// GitHub Search allows at most 5 AND/OR/NOT operators → max 6 keys per OR batch
const SEARCH_ISSUE_BATCH_SIZE = 6
const MAX_SEARCH_BOOLEAN_OPERATORS = 5

function retryAfterMs(response: Response) {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

async function rateLimitDelay(response: Response, attempt: number) {
  if (response.status !== 429 && response.status !== 403) return undefined
  const retryAfter = retryAfterMs(response)
  if (retryAfter !== undefined) return retryAfter

  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    if (Number.isFinite(reset)) {
      return Math.max(0, reset * 1_000 - Date.now())
    }
  }

  if (response.status === 403) {
    const detail = await response.clone().text().catch(() => '')
    if (!/secondary rate limit|abuse detection/i.test(detail)) return undefined
  }
  return 60_000 * 2 ** attempt
}

class GitHubRequestScheduler {
  private queue: ScheduledGitHubRequest[] = []
  private activeReads = 0
  private mutationActive = false
  private lastMutationFinishedAt = 0
  private blockedUntil = 0
  private pumpTimer?: ReturnType<typeof setTimeout>
  private nextId = 0

  schedule(
    method: string,
    task: () => Promise<Response>,
    maxRetries = MAX_GITHUB_RETRIES,
  ) {
    return new Promise<Response>((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        method,
        task,
        resolve,
        reject,
        maxRetries,
      })
      this.queue.sort(
        (left, right) =>
          Number(left.method === 'GET') - Number(right.method === 'GET') ||
          left.id - right.id,
      )
      this.pump()
    })
  }

  reset() {
    if (this.queue.length > 0 || this.activeReads > 0 || this.mutationActive) {
      return
    }
    this.blockedUntil = 0
    this.lastMutationFinishedAt = 0
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    this.pumpTimer = undefined
  }

  private schedulePump(delay: number) {
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined
      this.pump()
    }, Math.max(1, delay))
  }

  private pump() {
    if (this.pumpTimer) return
    const blockedFor = this.blockedUntil - Date.now()
    if (blockedFor > 0) {
      this.schedulePump(blockedFor)
      return
    }
    if (this.mutationActive) return

    const mutationIndex = this.queue.findIndex((item) => item.method !== 'GET')
    if (mutationIndex >= 0) {
      if (this.activeReads > 0) return
      const spacing = this.lastMutationFinishedAt + MUTATION_PAUSE_MS - Date.now()
      if (spacing > 0) {
        this.schedulePump(spacing)
        return
      }
      const [item] = this.queue.splice(mutationIndex, 1)
      this.mutationActive = true
      void this.run(item, true)
      return
    }

    while (
      this.activeReads < MAX_CONCURRENT_GITHUB_READS &&
      this.queue.length > 0
    ) {
      const item = this.queue.shift()!
      this.activeReads += 1
      void this.run(item, false)
    }
  }

  private async execute(item: ScheduledGitHubRequest) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await item.task()
      const rateDelay = await rateLimitDelay(response, attempt)
      const transientDelay =
        item.method === 'GET' && response.status >= 500
          ? 1_000 * 2 ** attempt
          : undefined
      const delay = rateDelay ?? transientDelay
      if (delay === undefined || attempt >= item.maxRetries) {
        return response
      }
      this.blockedUntil = Math.max(this.blockedUntil, Date.now() + delay)
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }

  private async run(item: ScheduledGitHubRequest, mutation: boolean) {
    try {
      item.resolve(await this.execute(item))
    } catch (error) {
      item.reject(error)
    } finally {
      if (mutation) {
        this.mutationActive = false
        this.lastMutationFinishedAt = Date.now()
      } else {
        this.activeReads -= 1
      }
      this.pump()
    }
  }
}

const githubRequestScheduler = new GitHubRequestScheduler()

async function githubFetch<T>(
  config: ConnectionConfig,
  path: string,
  init?: RequestInit,
  options?: { maxRetries?: number },
): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const cache = conditionalCache(config)
  const cacheKey = method === 'GET' && !init?.body ? path : undefined
  const cached = cacheKey ? cache.get(cacheKey) : undefined
  const headers = new Headers(githubHeaders(config))
  if (init?.body) headers.set('Content-Type', 'application/json')
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }
  if (cached && !headers.has('If-None-Match')) {
    headers.set('If-None-Match', cached.etag)
  }
  const response = await githubRequestScheduler.schedule(
    method,
    () =>
      fetch(`https://api.github.com${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(20_000),
      }),
    options?.maxRetries,
  )

  recordGitHubRateLimit(response)

  if (response.status === 304 && cached) {
    cache.delete(cacheKey!)
    cache.set(cacheKey!, cached)
    return cached.body as T
  }
  if (!response.ok) {
    throw await providerResponseError(response, 'github')
  }

  const body = (await response.json()) as T
  const etag = response.headers.get('etag')
  if (cacheKey && etag) {
    cacheConditionalResponse(cache, cacheKey, { etag, body })
  }
  return body
}

function recordGitHubRateLimit(response: Response) {
  const remaining = response.headers.get('x-ratelimit-remaining')
  const limit = response.headers.get('x-ratelimit-limit')
  const reset = response.headers.get('x-ratelimit-reset')
  if (remaining && limit && reset) {
    latestRateLimit = {
      remaining: Number(remaining),
      limit: Number(limit),
      resetsAt: new Date(Number(reset) * 1000).toISOString(),
    }
  }
}

type GraphqlVariables = Record<
  string,
  string | number | boolean | null | Record<string, string | number | boolean | null>
>

async function githubGraphql<T extends Record<string, unknown>>(
  config: ConnectionConfig,
  query: string,
  variables: GraphqlVariables,
  options?: { asMutation?: boolean },
): Promise<T> {
  // GraphQL is always POST; schedule reads as GET so read concurrency applies.
  // Mutations use POST scheduling so they serialize with other writes.
  const scheduleMethod = options?.asMutation ? 'POST' : 'GET'
  const response = await githubRequestScheduler.schedule(scheduleMethod, () =>
    fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        ...githubHeaders(config),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    }),
  )

  recordGitHubRateLimit(response)
  if (!response.ok) {
    throw await providerResponseError(response, 'github')
  }

  const body = (await response.json()) as {
    data?: T
    errors?: Array<{ message?: string }>
  }
  // Partial success is common (missing repo/PR aliases); prefer data when present
  if (body.data) return body.data
  const detail = body.errors
    ?.map((error) => error.message)
    .filter(Boolean)
    .join('; ')
  throw new ProviderError(
    detail
      ? `GitHub GraphQL request failed. ${detail}`
      : 'GitHub GraphQL request failed.',
    'PROVIDER_REQUEST_FAILED',
    'github',
    502,
    false,
  )
}

export type GraphqlMergeMethod = 'MERGE' | 'SQUASH' | 'REBASE'

export async function mergePullRequestViaGraphql(
  config: ConnectionConfig,
  pullRequestNodeId: string,
  mergeMethod: GraphqlMergeMethod = 'MERGE',
): Promise<{ merged: boolean; sha?: string }> {
  const data = await githubGraphql<{
    mergePullRequest: {
      pullRequest: {
        merged: boolean
        mergeCommit: { oid: string } | null
      } | null
    } | null
  }>(
    config,
    `
    mutation MergePullRequest($input: MergePullRequestInput!) {
      mergePullRequest(input: $input) {
        pullRequest {
          merged
          mergeCommit {
            oid
          }
        }
      }
    }
    `,
    {
      input: {
        pullRequestId: pullRequestNodeId,
        mergeMethod,
      },
    },
    { asMutation: true },
  )

  const pull = data.mergePullRequest?.pullRequest
  if (!pull?.merged) {
    throw new ProviderError(
      'GitHub GraphQL merge did not report success.',
      'PROVIDER_REQUEST_FAILED',
      'github',
      502,
      false,
    )
  }
  return {
    merged: true,
    sha: pull.mergeCommit?.oid,
  }
}

export function repositoryPath(repository: string) {
  const [owner, name, ...rest] = repository.split('/')
  if (
    !owner ||
    !name ||
    rest.length > 0 ||
    ['.', '..'].includes(owner) ||
    ['.', '..'].includes(name)
  ) {
    throw new Error('Repository must use the owner/name format.')
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

export function githubApi<T>(
  config: ConnectionConfig,
  path: string,
  init?: RequestInit,
) {
  return githubFetch<T>(config, path, init)
}

export function stagingTagPrefix(
  environment: StagingEnvironment,
  date: string,
) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) throw new Error('Release date must use YYYY-MM-DD.')
  const [, year, month, day] = match
  const parsed = new Date(`${date}T00:00:00Z`)
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    throw new Error('Release date is invalid.')
  }
  return `v-${environment}-v${year.slice(-2)}.${month}${day}.`
}

export function nextStagingTag(
  environment: StagingEnvironment,
  date: string,
  existingTags: string[],
) {
  const prefix = stagingTagPrefix(environment, date)
  const highest = existingTags.reduce((current, tag) => {
    if (!tag.startsWith(prefix)) return current
    const suffix = tag.slice(prefix.length)
    return /^\d+$/.test(suffix) ? Math.max(current, Number(suffix)) : current
  }, 0)
  return `${prefix}${highest + 1}`
}

export function productionTagPrefix(repository: string, date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) throw new Error('Release date must use YYYY-MM-DD.')
  const [, year, month, day] = match
  const parsed = new Date(`${date}T00:00:00Z`)
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    throw new Error('Release date is invalid.')
  }
  const prefix = usesFrontendProductionTag(repository)
    ? 'v-prod-'
    : 'v-'
  return `${prefix}${year.slice(-2)}.${month}${day}.`
}

export function nextProductionTag(
  repository: string,
  date: string,
  existingTags: string[],
) {
  const prefix = productionTagPrefix(repository, date)
  const highest = existingTags.reduce((current, tag) => {
    if (!tag.startsWith(prefix)) return current
    const suffix = tag.slice(prefix.length)
    return /^\d+$/.test(suffix) ? Math.max(current, Number(suffix)) : current
  }, 0)
  return `${prefix}${highest + 1}`
}

async function existingTags(
  config: ConnectionConfig,
  repository: string,
  prefix: string,
) {
  const refs = await githubFetch<Array<{ ref: string }>>(
    config,
    `/repos/${repositoryPath(repository)}/git/matching-refs/tags/${encodeURIComponent(prefix)}`,
  )
  return refs.map((item) => item.ref.replace(/^refs\/tags\//, ''))
}

export async function createStagingRelease(
  config: ConnectionConfig,
  repository: string,
  environment: StagingEnvironment,
  date: string,
): Promise<CreatedStagingRelease> {
  const [owner] = repository.split('/')
  if (owner.toLowerCase() !== config.githubOrg.toLowerCase()) {
    throw new Error('Releases can only be created in the connected organization.')
  }

  const path = repositoryPath(repository)
  await githubFetch(config, `/repos/${path}/branches/dev`)
  const prefix = stagingTagPrefix(environment, date)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tag = nextStagingTag(
      environment,
      date,
      await existingTags(config, repository, prefix),
    )
    try {
      const release = await githubFetch<{
        id: number
        html_url: string
        created_at: string
      }>(config, `/repos/${path}/releases`, {
        method: 'POST',
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: 'dev',
          name: tag,
          draft: false,
          prerelease: true,
          generate_release_notes: true,
        }),
      })
      return {
        id: release.id,
        repository,
        environment,
        tag,
        sourceBranch: 'dev',
        url: release.html_url,
        createdAt: release.created_at,
      }
    } catch (error) {
      if (attempt < 2 && error instanceof ProviderError && error.status === 422) {
        continue
      }
      throw error
    }
  }

  throw new Error('Could not reserve the next staging tag.')
}

export async function createProductionRelease(
  config: ConnectionConfig,
  repository: string,
  date: string,
  operationId?: string,
): Promise<CreatedProductionRelease> {
  const [owner] = repository.split('/')
  if (owner.toLowerCase() !== config.githubOrg.toLowerCase()) {
    throw new Error('Releases can only be created in the connected organization.')
  }

  const path = repositoryPath(repository)
  const metadata = await githubFetch<{ default_branch: string }>(
    config,
    `/repos/${path}`,
  )
  const sourceBranch = metadata.default_branch
  const prefix = productionTagPrefix(repository, date)
  const operationMarker = operationId
    ? `<!-- release-desk-operation:${operationId} -->`
    : undefined

  if (operationMarker) {
    const releases = await githubFetch<
      Array<{
        id: number
        tag_name: string
        target_commitish: string
        html_url: string
        created_at: string
        body: string | null
      }>
    >(config, `/repos/${path}/releases?per_page=100`)
    const existing = releases.find(
      (release) =>
        release.tag_name.startsWith(prefix) &&
        release.body?.includes(operationMarker),
    )
    if (existing) {
      const runs = await githubFetch<{
        workflow_runs: Array<{
          conclusion: string | null
        }>
      }>(
        config,
        `/repos/${path}/actions/runs?branch=${encodeURIComponent(existing.tag_name)}&per_page=100`,
      )
      const canceled = runs.workflow_runs.some(
        (run) => run.conclusion === 'cancelled',
      )
      if (!canceled) {
        return {
          id: existing.id,
          repository,
          tag: existing.tag_name,
          sourceBranch: existing.target_commitish || sourceBranch,
          url: existing.html_url,
          createdAt: existing.created_at,
        }
      }
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tag = nextProductionTag(
      repository,
      date,
      await existingTags(config, repository, prefix),
    )
    try {
      const release = await githubFetch<{
        id: number
        html_url: string
        created_at: string
      }>(config, `/repos/${path}/releases`, {
        method: 'POST',
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: sourceBranch,
          name: tag,
          draft: false,
          prerelease: false,
          generate_release_notes: true,
          ...(operationMarker ? { body: operationMarker } : {}),
        }),
      })
      return {
        id: release.id,
        repository,
        tag,
        sourceBranch,
        url: release.html_url,
        createdAt: release.created_at,
      }
    } catch (error) {
      if (attempt < 2 && error instanceof ProviderError && error.status === 422) {
        continue
      }
      throw error
    }
  }

  throw new Error('Could not reserve the next production tag.')
}

export async function testGitHubConnection(config: ConnectionConfig) {
  const [user, org] = await Promise.all([
    githubFetch<{ login: string }>(config, '/user'),
    githubFetch<{ login: string }>(
      config,
      `/orgs/${encodeURIComponent(config.githubOrg)}`,
    ),
  ])
  return { user: user.login, org: org.login }
}

export function titleContainsIssueKey(title: string, issueKey: string) {
  const escaped = issueKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Z0-9])${escaped}(?=$|[^A-Z0-9])`, 'i').test(title)
}

export function developmentPullRequests(summary?: string) {
  if (!summary) return []
  const normalized = summary
    .replaceAll('\\/', '/')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
  const matches = new Map<
    string,
    { repository: string; number: number }
  >()
  const patterns = [
    /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/gi,
    /https?:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls\/(\d+)/gi,
  ]
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const repository = `${match[1]}/${match[2]}`
      const number = Number(match[3])
      matches.set(`${repository.toLowerCase()}#${number}`, {
        repository,
        number,
      })
    }
  }
  return [...matches.values()]
}

function reviewDecision(reviews: GitHubReview[]): ReviewDecision {
  const latestByUser = new Map<string, GitHubReview>()
  for (const review of reviews) {
    if (review.state === 'PENDING') continue
    const current = latestByUser.get(review.user.login)
    if (
      !current ||
      (review.submitted_at ?? '').localeCompare(current.submitted_at ?? '') >= 0
    ) {
      latestByUser.set(review.user.login, review)
    }
  }

  const states = [...latestByUser.values()].map((review) => review.state)
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested'
  if (states.includes('APPROVED')) return 'approved'
  return 'review_required'
}

function pullParticipants(pull: GitHubPull, reviews: GitHubReview[]) {
  const participants = new Map<
    string,
    {
      login: string
      avatarUrl: string
      role: 'author' | 'assignee' | 'reviewer'
    }
  >()
  participants.set(pull.user.login, {
    login: pull.user.login,
    avatarUrl: pull.user.avatar_url,
    role: 'author',
  })
  for (const assignee of pull.assignees) {
    if (!participants.has(assignee.login)) {
      participants.set(assignee.login, {
        login: assignee.login,
        avatarUrl: assignee.avatar_url,
        role: 'assignee',
      })
    }
  }
  for (const review of reviews) {
    if (!participants.has(review.user.login)) {
      participants.set(review.user.login, {
        login: review.user.login,
        avatarUrl: review.user.avatar_url,
        role: 'reviewer',
      })
    }
  }
  return [...participants.values()]
}

function graphqlCheckStatus(
  rollupState: string | undefined,
): CheckStatus {
  if (!rollupState) return 'none'
  switch (rollupState) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return 'none'
  }
}

function graphqlReviewDecision(
  decision: GraphqlPullRequest['reviewDecision'],
  reviews: GitHubReview[],
): ReviewDecision {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes_requested'
  if (decision === 'REVIEW_REQUIRED') return 'review_required'
  return reviewDecision(reviews)
}

function mapGraphqlPullRequest(
  repository: string,
  pull: GraphqlPullRequest,
): PullRequest {
  const reviews: GitHubReview[] = pull.latestReviews.nodes
    .filter((review) => review.author?.login)
    .map((review) => ({
      user: {
        login: review.author!.login!,
        avatar_url: review.author!.avatarUrl ?? '',
      },
      state: review.state as GitHubReview['state'],
    }))
  const authorLogin = pull.author?.login ?? 'unknown'
  const authorAvatar = pull.author?.avatarUrl ?? ''
  let mergeable: boolean | null = null
  if (pull.mergeable === 'MERGEABLE') mergeable = true
  else if (pull.mergeable === 'CONFLICTING') mergeable = false
  const restShape: GitHubPull = {
    id: pull.databaseId ?? pull.number,
    number: pull.number,
    title: pull.title,
    html_url: pull.url,
    state: pull.state === 'OPEN' ? 'open' : 'closed',
    draft: pull.isDraft,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.mergeStateStatus.toLowerCase(),
    base: { ref: pull.baseRefName, repo: { full_name: repository } },
    head: { ref: pull.headRefName, sha: '' },
    user: { login: authorLogin, avatar_url: authorAvatar },
    assignees: pull.assignees.nodes
      .filter((assignee) => assignee.login)
      .map((assignee) => ({
        login: assignee.login!,
        avatar_url: assignee.avatarUrl ?? '',
      })),
    updated_at: pull.updatedAt,
  }

  return {
    id: restShape.id,
    number: restShape.number,
    repository,
    title: restShape.title,
    url: restShape.html_url,
    state: restShape.state,
    draft: restShape.draft,
    merged: restShape.merged,
    baseBranch: restShape.base.ref,
    headBranch: restShape.head.ref,
    author: authorLogin,
    assignees: restShape.assignees.map((assignee) => assignee.login),
    reviewDecision: graphqlReviewDecision(pull.reviewDecision, reviews),
    mergeable: restShape.mergeable,
    mergeableState: restShape.mergeable_state,
    checks: graphqlCheckStatus(
      pull.commits.nodes[0]?.commit.statusCheckRollup?.state,
    ),
    updatedAt: restShape.updated_at,
    participants: pullParticipants(restShape, reviews),
  }
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

const GRAPHQL_PULL_FIELDS = `
  databaseId
  number
  title
  url
  state
  isDraft
  merged
  mergeable
  mergeStateStatus
  baseRefName
  headRefName
  updatedAt
  reviewDecision
  author { login avatarUrl }
  assignees(first: 20) { nodes { login avatarUrl } }
  latestReviews(first: 50) {
    nodes { author { login avatarUrl } state }
  }
  commits(last: 1) {
    nodes { commit { statusCheckRollup { state } } }
  }
`

async function fetchPullRequestBatch(
  config: ConnectionConfig,
  pulls: Array<{ id: string; repository: string; number: number }>,
): Promise<Map<string, PullRequest>> {
  const byId = new Map<string, PullRequest>()
  if (pulls.length === 0) return byId

  const variableDeclarations: string[] = []
  const selections: string[] = []
  const variables: Record<string, string | number> = {}

  pulls.forEach((pull, index) => {
    const [owner, name] = pull.repository.split('/')
    variableDeclarations.push(
      `$owner${index}: String!`,
      `$name${index}: String!`,
      `$number${index}: Int!`,
    )
    selections.push(`
      p${index}: repository(owner: $owner${index}, name: $name${index}) {
        pullRequest(number: $number${index}) { ${GRAPHQL_PULL_FIELDS} }
      }
    `)
    variables[`owner${index}`] = owner
    variables[`name${index}`] = name
    variables[`number${index}`] = pull.number
  })

  const query = `query (${variableDeclarations.join(', ')}) { ${selections.join('\n')} }`
  const data = await githubGraphql<Record<string, GraphqlRepositoryPull>>(
    config,
    query,
    variables,
  )

  pulls.forEach((pull, index) => {
    const node = data[`p${index}`]?.pullRequest
    if (!node) return
    const mapped = mapGraphqlPullRequest(pull.repository, node)
    byId.set(pull.id, mapped)
    const cacheKey = `${pull.repository.toLowerCase()}#${pull.number}`
    pullCache.set(cacheKey, {
      expiresAt: Date.now() + PROVIDER_CACHE_MS,
      value: Promise.resolve(mapped),
    })
  })

  return byId
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++
      try {
        results[index] = { status: 'fulfilled', value: await mapper(values[index]) }
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function createSearchSlotScheduler(spacingMs: number) {
  let nextSlotAt = 0
  return async function acquireSearchSlot() {
    const now = Date.now()
    const startAt = Math.max(now, nextSlotAt)
    nextSlotAt = startAt + spacingMs
    if (startAt > now) await sleep(startAt - now)
  }
}

function searchCacheKey(org: string, issueKey: string) {
  return `${org}:${issueKey}`.toLowerCase()
}

export function buildIssueSearchQuery(org: string, issueKeys: string[]) {
  // Avoid `in:title (...)` — GitHub often 422s that form for OR groups.
  // Client-side titleContainsIssueKey still attributes matches correctly.
  // Also: GitHub rejects queries with more than 5 AND/OR/NOT operators.
  if (issueKeys.length === 0) {
    throw new Error('Search batch requires at least one issue key.')
  }
  if (issueKeys.length - 1 > MAX_SEARCH_BOOLEAN_OPERATORS) {
    throw new Error(
      `Search batch size ${issueKeys.length} needs ${issueKeys.length - 1} OR operators; GitHub allows ${MAX_SEARCH_BOOLEAN_OPERATORS}.`,
    )
  }
  const titleClause = issueKeys.map((key) => `"${key}"`).join(' OR ')
  return `org:${org} is:pr (${titleClause})`
}

/** Exported for tests — counts boolean operators that GitHub Search limits. */
export function countSearchBooleanOperators(query: string) {
  return (query.match(/\b(?:AND|OR|NOT)\b/gi) ?? []).length
}

function matchSearchItemsToIssues(
  items: GitHubSearchItem[],
  issueKeys: string[],
): Array<{ issueKey: string; item: GitHubSearchItem }> {
  const matches: Array<{ issueKey: string; item: GitHubSearchItem }> = []
  for (const item of items) {
    if (item.state === 'closed' && !item.pull_request?.merged_at) continue
    for (const issueKey of issueKeys) {
      if (titleContainsIssueKey(item.title, issueKey)) {
        matches.push({ issueKey, item })
      }
    }
  }
  return matches
}

async function searchIssueKeyBatch(
  config: ConnectionConfig,
  issueKeys: string[],
): Promise<Array<{ issueKey: string; item: GitHubSearchItem }>> {
  if (issueKeys.length === 0) return []

  const query = encodeURIComponent(
    buildIssueSearchQuery(config.githubOrg, issueKeys),
  )
  const response = await githubFetch<{
    items: GitHubSearchItem[]
    incomplete_results: boolean
  }>(
    config,
    `/search/issues?q=${query}&per_page=100`,
    undefined,
    { maxRetries: MAX_GITHUB_SEARCH_RETRIES },
  )

  const matches = matchSearchItemsToIssues(response.items, issueKeys)
  for (const issueKey of issueKeys) {
    const forKey = matches.filter((match) => match.issueKey === issueKey)
    searchCache.set(searchCacheKey(config.githubOrg, issueKey), {
      expiresAt: Date.now() + PROVIDER_CACHE_MS,
      value: Promise.resolve(forKey),
    })
  }
  return matches
}

function formatErrorDetail(reason: unknown) {
  if (reason instanceof Error) return reason.message
  return String(reason)
}

export async function discoverPullRequests(
  config: ConnectionConfig,
  issues: Array<{ key: string; developmentSummary?: string }>,
  reportProgress?: (progress: DashboardProgress) => void,
): Promise<GitHubDiscovery> {
  // Keep the last known rate limit when provider caches satisfy the request
  // without new GitHub HTTP calls (otherwise the UI shows "—").
  const byIssue = new Map<string, PullRequest[]>(
    issues.map((issue) => [issue.key, []]),
  )
  const warnings: string[] = []
  const linkedByIssue = new Map(
    issues.map((issue) => [
      issue.key,
      developmentPullRequests(issue.developmentSummary).filter(
        (pull) =>
          pull.repository.split('/')[0].toLowerCase() ===
          config.githubOrg.toLowerCase(),
      ),
    ]),
  )
  const issuesNeedingSearch = issues.filter(
    (issue) => linkedByIssue.get(issue.key)?.length === 0,
  )
  const cachedSearchMatches: Array<{ issueKey: string; item: GitHubSearchItem }> =
    []
  const uncachedIssueKeys: string[] = []
  for (const issue of issuesNeedingSearch) {
    const cacheKey = searchCacheKey(config.githubOrg, issue.key)
    const cached = searchCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      try {
        cachedSearchMatches.push(...(await cached.value))
        continue
      } catch {
        searchCache.delete(cacheKey)
      }
    }
    uncachedIssueKeys.push(issue.key)
  }

  const searchBatches = chunkArray(uncachedIssueKeys, SEARCH_ISSUE_BATCH_SIZE)
  const acquireSearchSlot = createSearchSlotScheduler(SEARCH_SPACING_MS)
  let searchesStarted = 0
  const searches = await mapConcurrent(
    searchBatches,
    SEARCH_CONCURRENCY,
    async (batch) => {
      await acquireSearchSlot()
      searchesStarted += 1
      reportProgress?.({
        phase: 'github-search',
        message: 'Searching GitHub for pull requests…',
        current: Math.min(
          searchesStarted * SEARCH_ISSUE_BATCH_SIZE,
          uncachedIssueKeys.length,
        ),
        total: issuesNeedingSearch.length,
      })
      return searchIssueKeyBatch(config, batch)
    },
  )

  const uniquePulls = new Map<string, GitHubSearchItem>()
  const pullToIssues = new Map<string, Set<string>>()

  for (const [issueKey, linkedPulls] of linkedByIssue) {
    for (const linked of linkedPulls) {
      const id = `${linked.repository}#${linked.number}`
      uniquePulls.set(id, {
        id: linked.number,
        number: linked.number,
        title: issueKey,
        repository_url: `https://api.github.com/repos/${linked.repository}`,
      })
      const matches = pullToIssues.get(id) ?? new Set<string>()
      matches.add(issueKey)
      pullToIssues.set(id, matches)
    }
  }

  function recordSearchMatch(issueKey: string, item: GitHubSearchItem) {
    const repository = item.repository_url.split('/').slice(-2).join('/')
    const id = `${repository}#${item.number}`
    uniquePulls.set(id, item)
    const matches = pullToIssues.get(id) ?? new Set<string>()
    matches.add(issueKey)
    pullToIssues.set(id, matches)
  }

  for (const { issueKey, item } of cachedSearchMatches) {
    recordSearchMatch(issueKey, item)
  }

  const keysNeedingFallback: string[] = []
  searches.forEach((result, index) => {
    if (result.status === 'rejected') {
      const batch = searchBatches[index]
      if (batch.length === 1) {
        console.error(
          `GitHub search failed for ${batch[0]}:`,
          formatErrorDetail(result.reason),
          result.reason,
        )
        warnings.push(`Could not search GitHub for ${batch[0]}.`)
        return
      }
      console.error(
        `GitHub OR search failed for ${batch.join(', ')}; falling back to per-ticket search:`,
        formatErrorDetail(result.reason),
        result.reason,
      )
      keysNeedingFallback.push(...batch)
      return
    }
    for (const { issueKey, item } of result.value) {
      recordSearchMatch(issueKey, item)
    }
  })

  if (keysNeedingFallback.length > 0) {
    let fallbackStarted = 0
    const fallbackResults = await mapConcurrent(
      keysNeedingFallback,
      1,
      async (issueKey) => {
        await acquireSearchSlot()
        fallbackStarted += 1
        reportProgress?.({
          phase: 'github-search',
          message: 'Searching GitHub for pull requests…',
          current: fallbackStarted,
          total: keysNeedingFallback.length,
        })
        return searchIssueKeyBatch(config, [issueKey])
      },
    )
    fallbackResults.forEach((result, index) => {
      const issueKey = keysNeedingFallback[index]
      if (result.status === 'rejected') {
        console.error(
          `GitHub search failed for ${issueKey}:`,
          formatErrorDetail(result.reason),
          result.reason,
        )
        warnings.push(`Could not search GitHub for ${issueKey}.`)
        return
      }
      for (const { issueKey: key, item } of result.value) {
        recordSearchMatch(key, item)
      }
    })
  }
  const entries = [...uniquePulls.entries()].map(([id, item]) => ({
    id,
    repository: item.repository_url.split('/').slice(-2).join('/'),
    number: item.number,
  }))
  const uncached: typeof entries = []
  const resolved = new Map<string, PullRequest>()
  for (const entry of entries) {
    const cacheKey = `${entry.repository.toLowerCase()}#${entry.number}`
    const cached = pullCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      try {
        resolved.set(entry.id, await cached.value)
        continue
      } catch {
        pullCache.delete(cacheKey)
      }
    }
    uncached.push(entry)
  }

  const batches = chunkArray(uncached, GRAPHQL_PULL_BATCH_SIZE)
  let batchesCompleted = 0
  const batchResults = await mapConcurrent(
    batches,
    MAX_CONCURRENT_GITHUB_READS,
    async (batch) => {
      batchesCompleted += 1
      reportProgress?.({
        phase: 'github-details',
        message: 'Loading pull request details…',
        current: Math.min(
          batchesCompleted * GRAPHQL_PULL_BATCH_SIZE,
          uncached.length,
        ),
        total: entries.length,
      })
      return fetchPullRequestBatch(config, batch)
    },
  )
  batchResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(
        `GitHub pull detail batch failed for ${batches[index].map((entry) => entry.id).join(', ')}:`,
        formatErrorDetail(result.reason),
        result.reason,
      )
      for (const entry of batches[index]) {
        warnings.push(`Could not load details for ${entry.id}.`)
      }
      return
    }
    for (const [id, pull] of result.value) {
      resolved.set(id, pull)
    }
    for (const entry of batches[index]) {
      if (!result.value.has(entry.id)) {
        warnings.push(`Could not load details for ${entry.id}.`)
      }
    }
  })

  for (const entry of entries) {
    const pull = resolved.get(entry.id)
    if (!pull || isClosedWithoutMerge(pull)) continue
    for (const issueKey of pullToIssues.get(entry.id) ?? []) {
      byIssue.get(issueKey)?.push(pull)
    }
  }

  return { byIssue, rateLimit: latestRateLimit, warnings }
}

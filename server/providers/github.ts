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

type GitHubChecks = {
  check_runs: Array<{
    status: 'queued' | 'in_progress' | 'completed'
    conclusion:
      | 'success'
      | 'failure'
      | 'neutral'
      | 'cancelled'
      | 'skipped'
      | 'timed_out'
      | 'action_required'
      | 'stale'
      | null
  }>
}

export type GitHubDiscovery = {
  byIssue: Map<string, PullRequest[]>
  rateLimit?: RateLimit
  warnings: string[]
}

let latestRateLimit: RateLimit | undefined
const PROVIDER_CACHE_MS = 30_000
const CONDITIONAL_CACHE_MAX_ENTRIES = 2_000
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
}

const MAX_CONCURRENT_GITHUB_READS = 3
const MUTATION_PAUSE_MS = 1_000
const MAX_GITHUB_RETRIES = 2

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

  schedule(method: string, task: () => Promise<Response>) {
    return new Promise<Response>((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        method,
        task,
        resolve,
        reject,
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
      if (delay === undefined || attempt >= MAX_GITHUB_RETRIES) {
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
  const response = await githubRequestScheduler.schedule(method, () =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(20_000),
    }),
  )

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
    const existing = releases.find((release) =>
      release.body?.includes(operationMarker),
    )
    if (existing) {
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

function checkStatus(checks: GitHubChecks): CheckStatus {
  if (checks.check_runs.length === 0) return 'none'
  if (checks.check_runs.some((check) => check.status !== 'completed')) {
    return 'pending'
  }
  if (
    checks.check_runs.some((check) =>
      [
        'failure',
        'cancelled',
        'timed_out',
        'action_required',
        'stale',
      ].includes(check.conclusion ?? ''),
    )
  ) {
    return 'failure'
  }
  return 'success'
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

async function getPullRequest(
  config: ConnectionConfig,
  repository: string,
  number: number,
): Promise<PullRequest> {
  const cacheKey = `${repository.toLowerCase()}#${number}`
  const cached = pullCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const value = (async () => {
    const base = `/repos/${repository}`
    const pull = await githubFetch<GitHubPull>(
      config,
      `${base}/pulls/${number}`,
    )
    const [reviews, checks] =
      pull.state === 'closed' && !pull.merged
        ? [[], { check_runs: [] }]
        : await Promise.all([
            githubFetch<GitHubReview[]>(
              config,
              `${base}/pulls/${number}/reviews?per_page=100`,
            ),
            githubFetch<GitHubChecks>(
              config,
              `${base}/commits/${pull.head.sha}/check-runs?per_page=100`,
            ),
          ])

    return {
      id: pull.id,
      number: pull.number,
      repository: pull.base.repo.full_name,
      title: pull.title,
      url: pull.html_url,
      state: pull.state,
      draft: pull.draft,
      merged: pull.merged,
      baseBranch: pull.base.ref,
      headBranch: pull.head.ref,
      author: pull.user.login,
      assignees: pull.assignees.map((assignee) => assignee.login),
      reviewDecision: reviewDecision(reviews),
      mergeable: pull.mergeable,
      mergeableState: pull.mergeable_state,
      checks: checkStatus(checks),
      updatedAt: pull.updated_at,
      participants: pullParticipants(pull, reviews),
    }
  })()
  pullCache.set(cacheKey, {
    expiresAt: Date.now() + PROVIDER_CACHE_MS,
    value,
  })
  value.catch(() => pullCache.delete(cacheKey))
  return value
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

async function searchIssueKey(
  config: ConnectionConfig,
  issueKey: string,
): Promise<Array<{ issueKey: string; item: GitHubSearchItem }>> {
  const cacheKey = `${config.githubOrg}:${issueKey}`.toLowerCase()
  const cached = searchCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const value = (async () => {
    const query = encodeURIComponent(
      `org:${config.githubOrg} is:pr in:title "${issueKey}"`,
    )
    const response = await githubFetch<{
      items: GitHubSearchItem[]
      incomplete_results: boolean
    }>(config, `/search/issues?q=${query}&per_page=100`)

    return response.items
      .filter(
        (item) =>
          titleContainsIssueKey(item.title, issueKey) &&
          (item.state !== 'closed' || Boolean(item.pull_request?.merged_at)),
      )
      .map((item) => ({ issueKey, item }))
  })()
  searchCache.set(cacheKey, {
    expiresAt: Date.now() + PROVIDER_CACHE_MS,
    value,
  })
  value.catch(() => searchCache.delete(cacheKey))
  return value
}

export async function discoverPullRequests(
  config: ConnectionConfig,
  issues: Array<{ key: string; developmentSummary?: string }>,
  reportProgress?: (progress: DashboardProgress) => void,
): Promise<GitHubDiscovery> {
  latestRateLimit = undefined
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
  const issuesToSearch = issues.filter(
    (issue) => linkedByIssue.get(issue.key)?.length === 0,
  )
  let searchesStarted = 0
  const searches = await mapConcurrent(issuesToSearch, 6, (issue) => {
    searchesStarted += 1
    reportProgress?.({
      phase: 'github-search',
      message: `Searching GitHub for pull requests linked to ${issue.key}…`,
      current: searchesStarted,
      total: issuesToSearch.length,
    })
    return searchIssueKey(config, issue.key)
  })
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
  searches.forEach((result, index) => {
    if (result.status === 'rejected') {
      warnings.push(
        `Could not search GitHub for ${issuesToSearch[index].key}.`,
      )
      return
    }
    for (const { issueKey, item } of result.value) {
      const repository = item.repository_url.split('/').slice(-2).join('/')
      const id = `${repository}#${item.number}`
      uniquePulls.set(id, item)
      const matches = pullToIssues.get(id) ?? new Set<string>()
      matches.add(issueKey)
      pullToIssues.set(id, matches)
    }
  })

  const entries = [...uniquePulls.entries()]
  let detailsStarted = 0
  const pulls = await mapConcurrent(entries, 6, async ([id, item]) => {
    const repository = item.repository_url.split('/').slice(-2).join('/')
    detailsStarted += 1
    reportProgress?.({
      phase: 'github-details',
      message: `Loading ${repository} pull request #${item.number}…`,
      current: detailsStarted,
      total: entries.length,
    })
    return { id, pull: await getPullRequest(config, repository, item.number) }
  })

  pulls.forEach((result, index) => {
    if (result.status === 'rejected') {
      warnings.push(`Could not load details for ${entries[index][0]}.`)
      return
    }
    if (isClosedWithoutMerge(result.value.pull)) return
    for (const issueKey of pullToIssues.get(result.value.id) ?? []) {
      byIssue.get(issueKey)?.push(result.value.pull)
    }
  })

  return { byIssue, rateLimit: latestRateLimit, warnings }
}

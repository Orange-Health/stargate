import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../shared/api'
import type {
  BuildStatus,
  CreatedProductionRelease,
  PromotionPullRequest,
  PromotionRoute,
  ReleaseDashboard,
  RepositoryReleaseState,
  TrackedProductionRelease,
} from '../../shared/types'
import { ProductionDeployDialog } from './ProductionDeployDialog'

type Props = {
  dashboard: ReleaseDashboard
  productionEnabled: boolean
  onClose: () => void
}

type OperationLog = {
  id: string
  at: string
  repository?: string
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
}

type RepositoryProgress = {
  productionRelease?: CreatedProductionRelease
  productionReleaseError?: string
  error?: string
}

type BatchSession = {
  versionId: string
  operationId: string
  releaseDate: string
  startedAt: string
  selectedRepositories: string[]
  repositories: Record<string, RepositoryProgress>
  logs: OperationLog[]
}

type DeployTarget = {
  repository: string
  release: CreatedProductionRelease
  services: string[]
}

type CellOperation = {
  repository: string
  route: PromotionRoute
  label: string
}

type RepositorySyncStatus = 'queued' | 'syncing' | 'synced' | 'failed'

type ReleaseDeveloper = {
  login: string
  avatarUrl: string
  roles: Array<'author' | 'assignee' | 'reviewer'>
  pullRequests: number[]
}

type DeveloperModalState = {
  repository: string
  developers: ReleaseDeveloper[]
  loading: boolean
}

const POLL_INTERVAL = 15_000
const MAX_CONCURRENCY = 3
const REPOSITORY_SYNC_CONCURRENCY = 2
const REPOSITORY_STATE_CACHE_MS = 60_000

type CachedRepositoryStates = {
  cachedAt: number
  states: Record<string, RepositoryReleaseState>
}

type LegacyCachedRepositoryStates = Record<
  string,
  { syncedAt: number; state: RepositoryReleaseState }
>

type CachedReleaseDevelopers = Record<
  string,
  { cachedAt: number; developers: ReleaseDeveloper[] }
>

function localDate() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function releaseCreatedOnOrBeforeDate(
  createdAt: string,
  releaseDate: string,
) {
  return /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)
    ? createdAt.slice(0, 10) <= releaseDate
    : false
}

export function latestProductionReleaseOnOrBeforeDate(
  releases: TrackedProductionRelease[],
  releaseDate: string,
) {
  return releases
    .filter((release) =>
      releaseCreatedOnOrBeforeDate(release.createdAt, releaseDate),
    )
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    )[0]
}

export function releaseNotesForDashboard(
  dashboard: ReleaseDashboard,
  releasesByRepository: Record<string, TrackedProductionRelease[]>,
  releaseDate: string,
) {
  const sections = dashboard.services.map((service) => {
    const release = latestProductionReleaseOnOrBeforeDate(
      releasesByRepository[service.repository] ?? [],
      releaseDate,
    )
    if (!release) {
      return `## ${service.repository}\n\n**Release tag:** Not created\n\n_No production release found on or before ${releaseDate}._`
    }
    const description = release.description
      ?.replace(/<!--\s*release-desk-operation:[^>]+-->\s*/gi, '')
      .trim()
    return `## ${service.repository}\n\n**Release tag:** [${release.tag}](${release.url})\n\n${description || '_No release description provided._'}`
  })
  return `# ${dashboard.version.name} Release Notes\n\n**Release date:** ${releaseDate}\n\n${sections.join('\n\n')}`
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

function sessionKey(versionId: string) {
  return `release-day-operations:${versionId}`
}

function repositoryStateCacheKey(versionId: string) {
  return `release-day-repository-states:${versionId}`
}

function releaseDevelopersCacheKey(versionId: string) {
  return `release-day-developers:${versionId}`
}

export function developersForReleaseService(
  service: ReleaseDashboard['services'][number],
) {
  const developers = new Map<
    string,
    {
      login: string
      avatarUrl: string
      roles: Set<'author' | 'assignee' | 'reviewer'>
      pullRequests: Set<number>
    }
  >()
  for (const item of service.items) {
    const pull = item.pullRequest
    if (!pull) continue
    const participants =
      pull.participants?.length
        ? pull.participants
        : [
            {
              login: pull.author,
              avatarUrl: `https://github.com/${pull.author}.png?size=80`,
              role: 'author' as const,
            },
            ...pull.assignees.map((login) => ({
              login,
              avatarUrl: `https://github.com/${login}.png?size=80`,
              role: 'assignee' as const,
            })),
          ]
    for (const participant of participants) {
      const key = participant.login.toLowerCase()
      const existing = developers.get(key) ?? {
        login: participant.login,
        avatarUrl: participant.avatarUrl,
        roles: new Set(),
        pullRequests: new Set(),
      }
      existing.roles.add(participant.role)
      existing.pullRequests.add(pull.number)
      developers.set(key, existing)
    }
  }
  return [...developers.values()]
    .map((developer) => ({
      login: developer.login,
      avatarUrl: developer.avatarUrl,
      roles: [...developer.roles],
      pullRequests: [...developer.pullRequests],
    }))
    .sort((left, right) => left.login.localeCompare(right.login))
}

function restoreRepositoryStates(dashboard: ReleaseDashboard) {
  const states: Record<string, RepositoryReleaseState | undefined> = {}
  let cachedAt = 0
  try {
    const raw = window.localStorage.getItem(
      repositoryStateCacheKey(dashboard.version.id),
    )
    if (!raw) return { states, cachedAt }
    const parsed = JSON.parse(raw) as
      | CachedRepositoryStates
      | LegacyCachedRepositoryStates
    const currentCache = parsed as CachedRepositoryStates
    const cached: CachedRepositoryStates =
      typeof currentCache.cachedAt === 'number' &&
      typeof currentCache.states === 'object'
        ? currentCache
        : {
            cachedAt: Math.max(
              0,
              ...Object.values(
                parsed as LegacyCachedRepositoryStates,
              ).map((entry) => entry.syncedAt),
            ),
            states: Object.fromEntries(
              Object.entries(
                parsed as LegacyCachedRepositoryStates,
              ).map(([repository, entry]) => [repository, entry.state]),
            ),
          }
    cachedAt = cached.cachedAt
    if (Date.now() - cachedAt >= REPOSITORY_STATE_CACHE_MS) {
      return { states, cachedAt: 0 }
    }
    const available = new Set(
      dashboard.services.map((service) => service.repository),
    )
    for (const [repository, state] of Object.entries(cached.states)) {
      if (
        available.has(repository) &&
        state?.repository === repository
      ) {
        states[repository] = state
      }
    }
  } catch {
    // Ignore invalid or expired local cache data.
  }
  return { states, cachedAt }
}

function newSession(dashboard: ReleaseDashboard): BatchSession {
  return {
    versionId: dashboard.version.id,
    operationId: crypto.randomUUID(),
    releaseDate: dashboard.version.releaseDate ?? localDate(),
    startedAt: new Date().toISOString(),
    selectedRepositories: dashboard.services.map((service) => service.repository),
    repositories: Object.fromEntries(
      dashboard.services.map((service) => [service.repository, {}]),
    ),
    logs: [],
  }
}

function restoreSession(dashboard: ReleaseDashboard): BatchSession {
  try {
    const raw = window.localStorage.getItem(sessionKey(dashboard.version.id))
    if (!raw) return newSession(dashboard)
    const saved = JSON.parse(raw) as BatchSession
    if (
      saved.versionId !== dashboard.version.id ||
      !saved.operationId ||
      !Array.isArray(saved.selectedRepositories) ||
      !Array.isArray(saved.logs)
    ) {
      return newSession(dashboard)
    }
    const available = new Set(
      dashboard.services.map((service) => service.repository),
    )
    return {
      ...saved,
      selectedRepositories: saved.selectedRepositories.filter((repository) =>
        available.has(repository),
      ),
      repositories: Object.fromEntries(
        dashboard.services.map((service) => [
          service.repository,
          saved.repositories?.[service.repository] ?? {},
        ]),
      ),
    }
  } catch {
    return newSession(dashboard)
  }
}

async function mapConcurrent<T>(
  values: T[],
  task: (value: T) => Promise<void>,
  concurrency = MAX_CONCURRENCY,
) {
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const value = values[cursor++]
      await task(value)
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  )
}

function routeStep(state: RepositoryReleaseState | undefined, route: PromotionRoute) {
  return state?.promotionSteps.find((step) => step.route === route)
}

function mergeBlockReason(pull: PromotionPullRequest) {
  if (pull.draft) return 'PR is still a draft'
  if (pull.mergeable === null) return 'GitHub is still checking mergeability'
  if (pull.mergeable === false || pull.mergeableState === 'dirty') {
    return 'PR has merge conflicts'
  }
  if (pull.checks === 'pending') return 'Checks are pending'
  if (pull.checks === 'failure') return 'Checks are failing'
  return undefined
}

function phaseState(
  state: RepositoryReleaseState | undefined,
  route: PromotionRoute,
  mode: 'create' | 'merge',
) {
  const step = routeStep(state, route)
  if (!step) return { label: 'Checking', tone: 'pending' }
  if (step.state === 'up_to_date') {
    return { label: mode === 'merge' ? 'Merged' : 'Ready', tone: 'success' }
  }
  if (step.state === 'needs_pr') {
    return { label: 'PR needed', tone: 'pending' }
  }
  const blocked = step.pullRequest
    ? mergeBlockReason(step.pullRequest)
    : 'PR details unavailable'
  if (mode === 'merge' && blocked) {
    return { label: blocked, tone: 'error' }
  }
  return {
    label: step.pullRequest ? `PR #${step.pullRequest.number}` : 'PR open',
    tone: 'success',
  }
}

const buildLabels: Record<BuildStatus, string> = {
  starting: 'Waiting for workflow',
  running: 'Build running',
  succeeded: 'Build succeeded',
  failed: 'Build failed',
  canceled: 'Build canceled',
}

export function ReleaseDayOperations({
  dashboard,
  productionEnabled,
  onClose,
}: Props) {
  const [session, setSession] = useState(() => restoreSession(dashboard))
  const restoredRepositoryStates = useRef(
    restoreRepositoryStates(dashboard),
  ).current
  const [states, setStates] = useState<
    Record<string, RepositoryReleaseState | undefined>
  >(restoredRepositoryStates.states)
  const [refreshing, setRefreshing] = useState(false)
  const [busyAction, setBusyAction] = useState('')
  const [activeProductionRelease, setActiveProductionRelease] =
    useState('')
  const [checkingBuildRepository, setCheckingBuildRepository] = useState('')
  const [developerLists, setDeveloperLists] = useState<
    Record<string, ReleaseDeveloper[]>
  >(() =>
    Object.fromEntries(
      dashboard.services.map((service) => [
        service.repository,
        developersForReleaseService(service),
      ]),
    ),
  )
  const [developerModal, setDeveloperModal] =
    useState<DeveloperModalState>()
  const [copyNotesStatus, setCopyNotesStatus] = useState<
    'idle' | 'copying' | 'copied' | 'error'
  >('idle')
  const [cellOperation, setCellOperation] = useState<CellOperation>()
  const [repositorySync, setRepositorySync] = useState<
    Record<string, RepositorySyncStatus>
  >(
    Object.fromEntries(
      Object.keys(restoredRepositoryStates.states).map((repository) => [
        repository,
        'synced' as const,
      ]),
    ),
  )
  const [deployTarget, setDeployTarget] = useState<DeployTarget>()
  const sessionRef = useRef(session)
  const loadSequence = useRef(0)
  const repositoryCacheTimestamp = useRef(restoredRepositoryStates.cachedAt)

  useEffect(() => {
    sessionRef.current = session
    window.localStorage.setItem(
      sessionKey(session.versionId),
      JSON.stringify(session),
    )
  }, [session])

  useEffect(() => {
    const cachedStates = Object.fromEntries(
      Object.entries(states).filter(
        (entry): entry is [string, RepositoryReleaseState] =>
          entry[1] !== undefined,
      ),
    )
    if (
      Object.keys(cachedStates).length === 0 ||
      !repositoryCacheTimestamp.current
    ) {
      window.localStorage.removeItem(repositoryStateCacheKey(dashboard.version.id))
      return
    }
    window.localStorage.setItem(
      repositoryStateCacheKey(dashboard.version.id),
      JSON.stringify({
        cachedAt: repositoryCacheTimestamp.current,
        states: cachedStates,
      } satisfies CachedRepositoryStates),
    )
  }, [dashboard.version.id, states])

  const selected = session.selectedRepositories
  const selectedSet = useMemo(() => new Set(selected), [selected])

  const log = useCallback(
    (
      level: OperationLog['level'],
      message: string,
      repository?: string,
    ) => {
      setSession((current) => ({
        ...current,
        logs: [
          ...current.logs,
          {
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            repository,
            level,
            message,
          },
        ].slice(-500),
      }))
    },
    [],
  )

  const setRepositoryError = useCallback(
    (repository: string, error?: string) => {
      setSession((current) => ({
        ...current,
        repositories: {
          ...current.repositories,
          [repository]: {
            ...current.repositories[repository],
            error,
          },
        },
      }))
    },
    [],
  )

  const openDevelopers = useCallback(
    async (repository: string) => {
      const includedDevelopers = developerLists[repository]
      if (includedDevelopers) {
        const cacheKey = releaseDevelopersCacheKey(dashboard.version.id)
        let cached: CachedReleaseDevelopers = {}
        try {
          cached = JSON.parse(
            window.localStorage.getItem(cacheKey) ?? '{}',
          ) as CachedReleaseDevelopers
        } catch {
          cached = {}
        }
        cached[repository] = {
          cachedAt: Date.now(),
          developers: includedDevelopers,
        }
        window.localStorage.setItem(cacheKey, JSON.stringify(cached))
        setDeveloperModal({
          repository,
          developers: includedDevelopers,
          loading: false,
        })
        return
      }
      setDeveloperModal({ repository, developers: [], loading: true })
      await Promise.resolve()
      const cacheKey = releaseDevelopersCacheKey(dashboard.version.id)
      let cachedDevelopers: ReleaseDeveloper[] | undefined
      let cached: CachedReleaseDevelopers = {}
      try {
        cached = JSON.parse(
          window.localStorage.getItem(cacheKey) ?? '{}',
        ) as CachedReleaseDevelopers
        const entry = cached[repository]
        if (
          entry &&
          Date.now() - entry.cachedAt < REPOSITORY_STATE_CACHE_MS &&
          Array.isArray(entry.developers)
        ) {
          cachedDevelopers = entry.developers
        }
      } catch {
        cached = {}
      }
      const service = dashboard.services.find(
        (item) => item.repository === repository,
      )
      const developers =
        cachedDevelopers ?? (service ? developersForReleaseService(service) : [])
      if (!cachedDevelopers) {
        cached[repository] = { cachedAt: Date.now(), developers }
        window.localStorage.setItem(cacheKey, JSON.stringify(cached))
      }
      setDeveloperLists((current) => ({
        ...current,
        [repository]: developers,
      }))
      setDeveloperModal({ repository, developers, loading: false })
    },
    [dashboard.services, dashboard.version.id, developerLists],
  )

  const syncRepository = useCallback(
    async (repository: string, force: boolean, sequence: number) => {
      setRepositoryError(repository)
      setRepositorySync((current) => ({
        ...current,
        [repository]: 'syncing',
      }))
      try {
        log('info', 'Checking repository promotion and release state.', repository)
        if (force) {
          log('info', 'Invalidating cached repository state.', repository)
          await api.refreshRepository(repository)
        }
        const repositoryState = await api.repositoryState(repository)
        if (sequence !== loadSequence.current) return
        repositoryCacheTimestamp.current = Date.now()
        setStates((current) => ({
          ...current,
          [repository]: repositoryState,
        }))
        for (const step of repositoryState.promotionSteps) {
          if (step.state === 'pr_open' && step.pullRequest) {
            log(
              'success',
              `Discovered open ${step.fromBranch} → ${step.toBranch} PR #${step.pullRequest.number}: ${step.pullRequest.title}.`,
              repository,
            )
          } else if (step.state === 'up_to_date') {
            log(
              'success',
              step.filesChanged === 0 && step.commitsAhead > 0
                ? `Discovered ${step.fromBranch} → ${step.toBranch} has different merge history but identical content.`
                : `Discovered ${step.fromBranch} → ${step.toBranch} is already up to date.`,
              repository,
            )
          } else {
            log(
              'warning',
              `Discovered ${step.fromBranch} → ${step.toBranch} needs a PR (${step.commitsAhead} commits waiting).`,
              repository,
            )
          }
        }
        setRepositorySync((current) => ({
          ...current,
          [repository]: 'synced',
        }))
      } catch (reason) {
        if (sequence !== loadSequence.current) return
        const message =
          reason instanceof Error
            ? reason.message
            : 'Could not refresh repository state.'
        setRepositoryError(repository, message)
        setRepositorySync((current) => ({
          ...current,
          [repository]: 'failed',
        }))
        log('error', `Repository state check failed: ${message}`, repository)
      }
    },
    [log, setRepositoryError],
  )

  const refreshStates = useCallback(
    async (silent = false, force = false) => {
      const repositories = sessionRef.current.selectedRepositories
      if (repositories.length === 0) return
      const sequence = ++loadSequence.current
      if (!silent) setRefreshing(true)
      setRepositorySync((current) => ({
        ...current,
        ...Object.fromEntries(
          repositories.map((repository) => [repository, 'queued' as const]),
        ),
      }))
      await mapConcurrent(
        repositories,
        (repository) => syncRepository(repository, force, sequence),
        REPOSITORY_SYNC_CONCURRENCY,
      )
      if (!silent && sequence === loadSequence.current) setRefreshing(false)
    },
    [syncRepository],
  )

  const refreshOneRepository = useCallback(
    async (repository: string) => {
      await syncRepository(repository, true, loadSequence.current)
    },
    [syncRepository],
  )

  useEffect(() => {
    const activeReleases = selected.flatMap((repository) => {
      const release = session.repositories[repository]?.productionRelease
      if (!release) return []
      const status = states[repository]?.productionReleases.find(
        (item) => item.tag === release.tag,
      )?.buildStatus
      return status && ['succeeded', 'failed', 'canceled'].includes(status)
        ? []
        : [
            {
              repository,
              tag: release.tag,
              createdAt: release.createdAt,
            },
          ]
    })
    if (activeReleases.length === 0) return

    let active = true
    let running = false
    let timeout: number | undefined
    const schedule = () => {
      if (!active || document.hidden) return
      timeout = window.setTimeout(() => void poll(), POLL_INTERVAL)
    }
    const poll = async () => {
      if (!active || running || document.hidden) return
      running = true
      try {
        const results = await api.releaseBuildStatuses(activeReleases)
        if (!active) return
        setStates((current) => {
          const next = { ...current }
          for (const result of results) {
            const repositoryState = next[result.repository]
            const created =
              session.repositories[result.repository]?.productionRelease
            if (!repositoryState || !created) continue
            const tracked = repositoryState.productionReleases.find(
              (release) => release.tag === result.tag,
            )
            const updated = {
              id: tracked?.id ?? created.id,
              tag: result.tag,
              url: tracked?.url ?? created.url,
              createdAt: result.createdAt,
              buildStatus: result.buildStatus,
              runs: result.runs,
            }
            next[result.repository] = {
              ...repositoryState,
              productionReleases: tracked
                ? repositoryState.productionReleases.map((release) =>
                    release.tag === result.tag ? updated : release,
                  )
                : [updated, ...repositoryState.productionReleases],
              fetchedAt: new Date().toISOString(),
            }
          }
          return next
        })
      } catch {
        // Keep the last known build state and retry on the next scheduled poll.
      } finally {
        running = false
        schedule()
      }
    }
    const visibilityChanged = () => {
      if (timeout) window.clearTimeout(timeout)
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    schedule()
    return () => {
      active = false
      if (timeout) window.clearTimeout(timeout)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [selected, session.repositories, states])

  const everySelected = useCallback(
    (predicate: (repository: string) => boolean) =>
      selected.length > 0 && selected.every(predicate),
    [selected],
  )
  const syncCompleted = selected.filter((repository) =>
    ['synced', 'failed'].includes(repositorySync[repository]),
  ).length
  const devPrsReady = everySelected((repository) => {
    const step = routeStep(states[repository], 'dev-to-release')
    return step?.state === 'pr_open' || step?.state === 'up_to_date'
  })
  const devMerged = everySelected(
    (repository) =>
      routeStep(states[repository], 'dev-to-release')?.state === 'up_to_date',
  )
  const defaultPrsReady = everySelected((repository) => {
    const step = routeStep(states[repository], 'release-to-default')
    return step?.state === 'pr_open' || step?.state === 'up_to_date'
  })
  const defaultMerged = everySelected(
    (repository) =>
      routeStep(states[repository], 'release-to-default')?.state ===
      'up_to_date',
  )
  const releasesCreated = everySelected(
    (repository) =>
      Boolean(session.repositories[repository]?.productionRelease),
  )
  const buildsSucceeded = everySelected((repository) => {
    const release = session.repositories[repository]?.productionRelease
    if (!release) return false
    return states[repository]?.productionReleases.find(
      (item) => item.tag === release.tag,
    )?.buildStatus === 'succeeded'
  })
  const hasSavedProgress =
    session.logs.length > 0 ||
    Object.values(session.repositories).some((item) => item.productionRelease)

  async function runAction(
    action: string,
    task: (repository: string) => Promise<void>,
    options: {
      sequential?: boolean
      reconcile?: boolean
      attemptLabel?: string
    } = {},
  ) {
    if (busyAction || refreshing || selected.length === 0) return
    const repositories = dashboard.services
      .map((service) => service.repository)
      .filter((repository) => selectedSet.has(repository))
    setBusyAction(action)
    log('info', `${action} started for ${repositories.length} services.`)
    const execute = async (repository: string, index: number) => {
      setRepositoryError(repository)
      log(
        'info',
        `Attempting ${options.attemptLabel ?? action.toLowerCase()} (${index + 1}/${repositories.length}).`,
        repository,
      )
      try {
        await task(repository)
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : `${action} failed.`
        setRepositoryError(repository, message)
        log('error', message, repository)
      }
    }
    if (options.sequential) {
      for (const [index, repository] of repositories.entries()) {
        await execute(repository, index)
      }
    } else {
      await mapConcurrent(repositories, async (repository) => {
        await execute(repository, repositories.indexOf(repository))
      })
    }
    if (options.reconcile !== false) await refreshStates(true)
    log('info', `${action} finished. Review flagged services before continuing.`)
    setBusyAction('')
  }

  async function createPullRequests(route: PromotionRoute) {
    const title =
      route === 'dev-to-release'
        ? 'Create Dev → Release PRs'
        : 'Create Release → Default PRs'
    await runAction(
      title,
      async (repository) => {
        const step = routeStep(states[repository], route)
        const fromBranch =
          step?.fromBranch ?? (route === 'dev-to-release' ? 'dev' : 'release')
        const toBranch =
          step?.toBranch ??
          (route === 'dev-to-release'
            ? 'release'
            : states[repository]?.defaultBranch ?? 'default')
        log(
          'info',
          `Checking for an open ${fromBranch} → ${toBranch} PR.`,
          repository,
        )
        if (step?.state === 'up_to_date') {
          log(
            'success',
            `Discovery: ${step.fromBranch} and ${step.toBranch} are already aligned; no PR needed.`,
            repository,
          )
          return
        }
        let pull = step?.pullRequest
        if (pull) {
          log(
            'success',
            `Discovery: found existing open PR #${pull.number}: ${pull.title}.`,
            repository,
          )
        }
        if (!pull) {
          log(
            'info',
            `Discovery: no open ${fromBranch} → ${toBranch} PR in loaded state.`,
            repository,
          )
          log(
            'info',
            'Submitting GitHub check-and-create request.',
            repository,
          )
          setCellOperation({ repository, route, label: 'Creating PR' })
          try {
            pull = await api.createPromotionPullRequest({ repository, route })
          } finally {
            setCellOperation((current) =>
              current?.repository === repository && current.route === route
                ? undefined
                : current,
            )
          }
          log(
            pull.resolution === 'existing' ? 'success' : 'info',
            pull.resolution === 'existing'
              ? `GitHub discovered existing PR #${pull.number}; no duplicate was created.`
              : `GitHub created PR #${pull.number}.`,
            repository,
          )
        }
        setStates((current) => {
          const repositoryState = current[repository]
          if (!repositoryState) return current
          return {
            ...current,
            [repository]: {
              ...repositoryState,
              promotionSteps: repositoryState.promotionSteps.map((item) =>
                item.route === route
                  ? { ...item, state: 'pr_open', pullRequest: pull }
                  : item,
              ),
              fetchedAt: new Date().toISOString(),
            },
          }
        })
        log(
          'success',
          `Result: PR #${pull.number} is ready for tracking: ${pull.title} (${pull.headBranch} → ${pull.baseBranch}).`,
          repository,
        )
      },
      {
        sequential: true,
        reconcile: false,
        attemptLabel:
          route === 'dev-to-release'
            ? 'Dev → Release PR creation'
            : 'Release → Default PR creation',
      },
    )
  }

  async function mergePullRequests(route: PromotionRoute) {
    const title =
      route === 'dev-to-release'
        ? 'Merge Dev → Release PRs'
        : 'Merge Release → Default PRs'
    await runAction(
      title,
      async (repository) => {
        const step = routeStep(states[repository], route)
        log(
          'info',
          `Checking merge target for ${step?.fromBranch ?? route} → ${step?.toBranch ?? 'target branch'}.`,
          repository,
        )
        if (step?.state === 'up_to_date') {
          log(
            'success',
            'Discovery: branches are already aligned; no merge required.',
            repository,
          )
          return
        }
        if (!step?.pullRequest) {
          log('warning', 'Discovery: no open promotion PR to merge.', repository)
          throw new Error('No open promotion PR was found.')
        }
        log(
          'info',
          `Discovery: validating PR #${step.pullRequest.number}: ${step.pullRequest.title}.`,
          repository,
        )
        const blocked = mergeBlockReason(step.pullRequest)
        if (blocked) {
          log(
            'warning',
            `Validation blocked PR #${step.pullRequest.number}: ${blocked}.`,
            repository,
          )
          throw new Error(`${blocked} on PR #${step.pullRequest.number}.`)
        }
        log(
          'success',
          `Validation passed for PR #${step.pullRequest.number}; submitting merge to ${step.toBranch}.`,
          repository,
        )
        setCellOperation({
          repository,
          route,
          label: `Merging to ${step.toBranch}`,
        })
        let result
        try {
          result = await api.mergePromotionPullRequest({
            repository,
            pullNumber: step.pullRequest.number,
          })
        } finally {
          setCellOperation((current) =>
            current?.repository === repository && current.route === route
              ? undefined
              : current,
          )
        }
        if (!result.merged) {
          log(
            'error',
            `GitHub rejected merge for PR #${step.pullRequest.number}: ${result.message || 'No reason returned.'}`,
            repository,
          )
          throw new Error(result.message || 'GitHub did not merge the PR.')
        }
        setStates((current) => {
          const repositoryState = current[repository]
          if (!repositoryState) return current
          return {
            ...current,
            [repository]: {
              ...repositoryState,
              promotionSteps: repositoryState.promotionSteps.map((item) => {
                if (item.route === route) {
                  return {
                    ...item,
                    commitsAhead: 0,
                    filesChanged: 0,
                    state: 'up_to_date',
                    pullRequest: undefined,
                  }
                }
                if (
                  route === 'dev-to-release' &&
                  item.route === 'release-to-default'
                ) {
                  return { ...item, state: 'needs_pr' }
                }
                return item
              }),
              productionReady:
                route === 'release-to-default'
                  ? true
                  : repositoryState.productionReady,
              fetchedAt: new Date().toISOString(),
            },
          }
        })
        log(
          'success',
          `Result: merged PR #${step.pullRequest.number} into ${step.toBranch}${result.sha ? ` at ${result.sha.slice(0, 8)}` : ''}.`,
          repository,
        )
      },
      {
        sequential: true,
        reconcile: false,
        attemptLabel:
          route === 'dev-to-release'
            ? 'Dev → Release PR merge'
            : 'Release → Default PR merge',
      },
    )
  }

  async function createProductionRelease(repository: string) {
    const saved = sessionRef.current.repositories[repository]?.productionRelease
    if (saved) {
      log('success', `${saved.tag} was already created for this run.`, repository)
      return
    }
    setSession((current) => ({
      ...current,
      repositories: {
        ...current.repositories,
        [repository]: {
          ...current.repositories[repository],
          productionReleaseError: undefined,
        },
      },
    }))
    try {
      const release = await api.createProductionRelease({
        repository,
        date: sessionRef.current.releaseDate,
        operationId: sessionRef.current.operationId,
      })
      setSession((current) => ({
        ...current,
        repositories: {
          ...current.repositories,
          [repository]: {
            ...current.repositories[repository],
            productionRelease: release,
            productionReleaseError: undefined,
            error: undefined,
          },
        },
      }))
      log(
        'success',
        `Created ${release.tag} from ${release.sourceBranch}.`,
        repository,
      )
      window.dispatchEvent(
        new CustomEvent('production-release-created', {
          detail: { repository },
        }),
      )
    } catch (reason) {
      const message =
        reason instanceof Error
          ? reason.message
          : 'Could not create the production tag.'
      setSession((current) => ({
        ...current,
        repositories: {
          ...current.repositories,
          [repository]: {
            ...current.repositories[repository],
            productionReleaseError: message,
          },
        },
      }))
      throw reason
    }
  }

  async function createProductionReleases() {
    await runAction('Create production releases', createProductionRelease)
  }

  async function checkLatestBuild(repository: string) {
    if (checkingBuildRepository) return
    setCheckingBuildRepository(repository)
    log('info', 'Finding the latest eligible production tag.', repository)
    try {
      await api.refreshRepository(repository)
      const repositoryState = await api.repositoryState(repository)
      const latest = latestProductionReleaseOnOrBeforeDate(
        repositoryState.productionReleases,
        sessionRef.current.releaseDate,
      )
      if (!latest) {
        log(
          'warning',
          `No production tag was created on or before ${sessionRef.current.releaseDate}.`,
          repository,
        )
        return
      }
      const release: CreatedProductionRelease = {
        id: latest.id,
        repository,
        tag: latest.tag,
        sourceBranch: repositoryState.defaultBranch,
        url: latest.url,
        createdAt: latest.createdAt,
      }
      repositoryCacheTimestamp.current = Date.now()
      setStates((current) => ({
        ...current,
        [repository]: repositoryState,
      }))
      setSession((current) => ({
        ...current,
        repositories: {
          ...current.repositories,
          [repository]: {
            ...current.repositories[repository],
            productionRelease: release,
            productionReleaseError: undefined,
          },
        },
      }))
      log('info', `Checking the latest build for ${release.tag}.`, repository)
      const [result] = await api.releaseBuildStatuses(
        [
          {
            repository,
            tag: release.tag,
            createdAt: release.createdAt,
          },
        ],
        true,
      )
      if (!result) return
      setStates((current) => {
        const repositoryState = current[repository]
        if (!repositoryState) return current
        const tracked = repositoryState.productionReleases.find(
          (item) => item.tag === result.tag,
        )
        const updated = {
          id: tracked?.id ?? release.id,
          tag: result.tag,
          url: tracked?.url ?? release.url,
          createdAt: result.createdAt,
          buildStatus: result.buildStatus,
          runs: result.runs,
        }
        return {
          ...current,
          [repository]: {
            ...repositoryState,
            productionReleases: tracked
              ? repositoryState.productionReleases.map((item) =>
                  item.tag === result.tag ? updated : item,
                )
              : [updated, ...repositoryState.productionReleases],
            fetchedAt: new Date().toISOString(),
          },
        }
      })
      log(
        'success',
        `${release.tag}: ${buildLabels[result.buildStatus]}.`,
        repository,
      )
    } catch (reason) {
      log(
        'error',
        reason instanceof Error
          ? reason.message
          : 'Could not refresh the latest production build.',
        repository,
      )
    } finally {
      setCheckingBuildRepository('')
    }
  }

  async function createSingleProductionRelease(repository: string) {
    if (busyAction || refreshing || activeProductionRelease) return
    const retrying = Boolean(
      sessionRef.current.repositories[repository]?.productionReleaseError,
    )
    setActiveProductionRelease(repository)
    setRepositoryError(repository)
    log(
      'info',
      retrying
        ? 'Retrying production tag creation.'
        : 'Creating production tag.',
      repository,
    )
    try {
      await createProductionRelease(repository)
      await syncRepository(repository, false, loadSequence.current)
    } catch (reason) {
      const message =
        reason instanceof Error
          ? reason.message
          : 'Could not create the production tag.'
      setRepositoryError(repository, message)
      log('error', message, repository)
    } finally {
      setActiveProductionRelease('')
    }
  }

  function toggleRepository(repository: string) {
    if (busyAction) return
    setSession((current) => {
      const included = current.selectedRepositories.includes(repository)
      return {
        ...current,
        selectedRepositories: included
          ? current.selectedRepositories.filter((item) => item !== repository)
          : [...current.selectedRepositories, repository],
      }
    })
  }

  async function copyReleaseNotes() {
    if (copyNotesStatus === 'copying') return
    setCopyNotesStatus('copying')
    const releasesByRepository: Record<string, TrackedProductionRelease[]> = {}
    const failures: string[] = []
    try {
      await mapConcurrent(
        dashboard.services,
        async (service) => {
          try {
            const history = await api.releaseHistory(service.repository)
            releasesByRepository[service.repository] =
              history.productionReleases
          } catch {
            const cached = states[service.repository]?.productionReleases
            if (cached) {
              releasesByRepository[service.repository] = cached
            } else {
              failures.push(service.repository)
            }
          }
        },
        REPOSITORY_SYNC_CONCURRENCY,
      )
      if (failures.length > 0) {
        throw new Error(
          `Could not load release notes for: ${failures.join(', ')}.`,
        )
      }
      await copyText(
        releaseNotesForDashboard(
          dashboard,
          releasesByRepository,
          sessionRef.current.releaseDate,
        ),
      )
      setCopyNotesStatus('copied')
      log(
        'success',
        `Copied release notes for ${dashboard.services.length} repositories.`,
      )
    } catch (reason) {
      setCopyNotesStatus('error')
      log(
        'error',
        reason instanceof Error
          ? reason.message
          : 'Could not copy release notes.',
      )
    }
  }

  function resetSession() {
    if (
      hasSavedProgress &&
      !window.confirm('Start a new run and clear the saved operation log?')
    ) {
      return
    }
    const next = newSession(dashboard)
    setSession(next)
    sessionRef.current = next
    loadSequence.current += 1
    repositoryCacheTimestamp.current = 0
    setStates({})
    setRepositorySync({})
    window.localStorage.removeItem(
      repositoryStateCacheKey(dashboard.version.id),
    )
  }

  return (
    <>
      <section className="release-day-page" aria-labelledby="release-day-title">
            <header className="release-day-header">
              <div className="release-day-title">
                <h2 id="release-day-title">{dashboard.version.name}</h2>
                <span>
                  {selected.length}/{dashboard.services.length} selected
                  {refreshing && ` · Syncing ${syncCompleted}/${selected.length}`}
                </span>
              </div>
              <div className="release-day-toolbar">
                <label>
                  <span>Production date</span>
                  <input
                    type="date"
                    value={session.releaseDate}
                    disabled={
                      releasesCreated || refreshing || Boolean(busyAction)
                    }
                    onChange={(event) =>
                      setSession((current) => ({
                        ...current,
                        releaseDate: event.target.value,
                      }))
                    }
                  />
                </label>
                <button
                  className="text-button"
                  type="button"
                  disabled={refreshing || Boolean(busyAction)}
                  onClick={resetSession}
                >
                  New run
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void refreshStates(false, true)}
                  disabled={refreshing || Boolean(busyAction)}
                >
                  {refreshing
                    ? `Syncing ${syncCompleted}/${selected.length}`
                    : '↻ Refresh status'}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void copyReleaseNotes()}
                  disabled={
                    refreshing ||
                    Boolean(busyAction) ||
                    copyNotesStatus === 'copying'
                  }
                >
                  {copyNotesStatus === 'copying'
                    ? 'Copying…'
                    : copyNotesStatus === 'copied'
                      ? '✓ Copied!'
                      : copyNotesStatus === 'error'
                        ? 'Retry Copy Release Notes'
                        : 'Copy Release Notes'}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={onClose}
                >
                  ← Dashboard
                </button>
              </div>
            </header>

            {!productionEnabled && (
              <div className="alert warning">
                Production Jenkins is not connected. Promotion and release
                creation are available, but deploy buttons will remain disabled.
              </div>
            )}

            <div className="release-day-steps">
              <article className="release-day-step">
                <span>1</span>
                <div>
                  <strong>Create Dev → Release PRs</strong>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={
                    refreshing || Boolean(busyAction) || selected.length === 0
                  }
                  onClick={() => void createPullRequests('dev-to-release')}
                >
                  {busyAction === 'Create Dev → Release PRs'
                    ? 'Creating…'
                    : devPrsReady
                      ? 'Recheck / create'
                      : 'Create PRs'}
                </button>
              </article>
              <article className={`release-day-step ${!devPrsReady ? 'locked' : ''}`}>
                <span>2</span>
                <div>
                  <strong>Merge Dev → Release PRs</strong>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!devPrsReady || refreshing || Boolean(busyAction)}
                  onClick={() => void mergePullRequests('dev-to-release')}
                >
                  {busyAction === 'Merge Dev → Release PRs'
                    ? 'Merging…'
                    : devMerged
                      ? 'All merged'
                      : 'Merge ready PRs'}
                </button>
              </article>
              <article className={`release-day-step ${!devMerged ? 'locked' : ''}`}>
                <span>3</span>
                <div>
                  <strong>Create Release → Default PRs</strong>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!devMerged || refreshing || Boolean(busyAction)}
                  onClick={() => void createPullRequests('release-to-default')}
                >
                  {busyAction === 'Create Release → Default PRs'
                    ? 'Creating…'
                    : defaultPrsReady
                      ? 'Recheck / create'
                      : 'Create PRs'}
                </button>
              </article>
              <article className={`release-day-step ${!defaultPrsReady ? 'locked' : ''}`}>
                <span>4</span>
                <div>
                  <strong>Merge Release → Default PRs</strong>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={
                    !defaultPrsReady || refreshing || Boolean(busyAction)
                  }
                  onClick={() => void mergePullRequests('release-to-default')}
                >
                  {busyAction === 'Merge Release → Default PRs'
                    ? 'Merging…'
                    : defaultMerged
                      ? 'All merged'
                      : 'Merge ready PRs'}
                </button>
              </article>
              <article className={`release-day-step ${!defaultMerged ? 'locked' : ''}`}>
                <span>5</span>
                <div>
                  <strong>Create production releases</strong>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!defaultMerged || refreshing || Boolean(busyAction)}
                  onClick={() => void createProductionReleases()}
                >
                  {busyAction === 'Create production releases'
                    ? 'Creating…'
                    : releasesCreated
                      ? 'Reconcile releases'
                      : 'Create releases'}
                </button>
              </article>
              <article className={`release-day-step ${!releasesCreated ? 'locked' : ''}`}>
                <span>6</span>
                <div>
                  <strong>Monitor builds and deploy</strong>
                </div>
                <span className={`batch-status ${buildsSucceeded ? 'success' : 'running'}`}>
                  {buildsSucceeded ? 'Ready' : 'Live'}
                </span>
              </article>
            </div>

            <div className="release-day-workspace">
            <div className="release-day-table-wrap">
              <table className="release-day-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <input
                        type="checkbox"
                        aria-label="Select all services"
                        checked={
                          selected.length === dashboard.services.length
                        }
                        ref={(input) => {
                          if (input) {
                            input.indeterminate =
                              selected.length > 0 &&
                              selected.length < dashboard.services.length
                          }
                        }}
                        disabled={refreshing || Boolean(busyAction)}
                        onChange={(event) =>
                          setSession((current) => ({
                            ...current,
                            selectedRepositories: event.target.checked
                              ? dashboard.services.map(
                                  (service) => service.repository,
                                )
                              : [],
                          }))
                        }
                      />
                    </th>
                    <th scope="col">Service</th>
                    <th scope="col">Developers</th>
                    <th scope="col">Dev → Release</th>
                    <th scope="col">Release → Default</th>
                    <th scope="col">Production build</th>
                    <th scope="col">Deploy</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.services.map((service) => {
                    const repository = service.repository
                    const progress = session.repositories[repository]
                    const syncStatus = repositorySync[repository]
                    const repositoryState = states[repository]
                    const release = progress?.productionRelease
                    const releaseCreationError =
                      progress?.productionReleaseError
                    const trackedRelease = release
                      ? states[repository]?.productionReleases.find(
                          (item) => item.tag === release.tag,
                        )
                      : undefined
                    const productionDeployments =
                      repositoryState?.deployedTags.filter(
                        (deployment) =>
                          deployment.environment === 'production',
                      ) ?? []
                    const latestTagAlreadyDeployed =
                      Boolean(release) &&
                      Boolean(repositoryState?.jenkinsServices.length) &&
                      repositoryState?.jenkinsServices.every((jenkinsService) =>
                        productionDeployments.some(
                          (deployment) =>
                            deployment.service === jenkinsService &&
                            deployment.tag === release?.tag,
                        ),
                      )
                    const dev = phaseState(
                      states[repository],
                      'dev-to-release',
                      devPrsReady ? 'merge' : 'create',
                    )
                    const main = phaseState(
                      states[repository],
                      'release-to-default',
                      defaultPrsReady ? 'merge' : 'create',
                    )
                    const devOperation =
                      cellOperation?.repository === repository &&
                      cellOperation.route === 'dev-to-release'
                        ? cellOperation
                        : undefined
                    const mainOperation =
                      cellOperation?.repository === repository &&
                      cellOperation.route === 'release-to-default'
                        ? cellOperation
                        : undefined
                    return (
                      <tr
                        key={repository}
                        className={!selectedSet.has(repository) ? 'unselected' : ''}
                      >
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedSet.has(repository)}
                            disabled={refreshing || Boolean(busyAction)}
                            onChange={() => toggleRepository(repository)}
                            aria-label={`Include ${repository}`}
                          />
                        </td>
                        <td>
                          <strong>{repository.split('/').at(-1)}</strong>
                          <small>{repository}</small>
                          <button
                            className="release-day-row-sync"
                            type="button"
                            onClick={() => void refreshOneRepository(repository)}
                            disabled={
                              refreshing ||
                              Boolean(busyAction) ||
                              syncStatus === 'syncing'
                            }
                            aria-label={`Sync ${repository.split('/').at(-1)}`}
                          >
                            {syncStatus === 'syncing' ? (
                              <>
                                <span className="spinner" /> Syncing…
                              </>
                            ) : (
                              '↻ Sync'
                            )}
                          </button>
                          {syncStatus && syncStatus !== 'syncing' && (
                            <span
                              className={`release-day-repository-sync ${syncStatus}`}
                            >
                              {syncStatus === 'queued'
                                ? 'Queued'
                                : syncStatus === 'synced'
                                  ? 'Synced'
                                  : 'Sync failed'}
                            </span>
                          )}
                          {progress?.error && (
                            <span className="release-day-error">
                              {progress.error}
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="release-day-developers-cell">
                            {developerLists[repository] && (
                              <div
                                className="release-day-developer-avatars"
                                aria-label={`Developers for ${repository}`}
                              >
                                {developerLists[repository]
                                  .slice(0, 5)
                                  .map((developer) => (
                                    <img
                                      src={developer.avatarUrl}
                                      alt={developer.login}
                                      title={developer.login}
                                      key={developer.login}
                                    />
                                  ))}
                                {developerLists[repository].length > 5 && (
                                  <span>
                                    +{developerLists[repository].length - 5}
                                  </span>
                                )}
                                {developerLists[repository].length === 0 && (
                                  <small>No developers found</small>
                                )}
                              </div>
                            )}
                            <button
                              className="release-day-view-developers"
                              type="button"
                              onClick={() => void openDevelopers(repository)}
                            >
                              View Developers
                            </button>
                          </div>
                        </td>
                        <td>
                          {devOperation ? (
                            <span className="release-day-cell-operation">
                              <span className="spinner" />
                              {devOperation.label}
                            </span>
                          ) : (
                            <>
                          <span className={`batch-status ${dev.tone}`}>
                            {dev.label}
                          </span>
                          {routeStep(states[repository], 'dev-to-release')
                            ?.pullRequest && (
                            <a
                              href={
                                routeStep(states[repository], 'dev-to-release')
                                  ?.pullRequest?.url
                              }
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open PR ↗
                            </a>
                          )}
                            </>
                          )}
                        </td>
                        <td>
                          {mainOperation ? (
                            <span className="release-day-cell-operation">
                              <span className="spinner" />
                              {mainOperation.label}
                            </span>
                          ) : (
                            <>
                          <span className={`batch-status ${main.tone}`}>
                            {main.label}
                          </span>
                          {routeStep(states[repository], 'release-to-default')
                            ?.pullRequest && (
                            <a
                              href={
                                routeStep(
                                  states[repository],
                                  'release-to-default',
                                )?.pullRequest?.url
                              }
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open PR ↗
                            </a>
                          )}
                            </>
                          )}
                        </td>
                        <td>
                          {release ? (
                            <div className="release-day-production-build">
                              <a href={release.url} target="_blank" rel="noreferrer">
                                {release.tag} ↗
                              </a>
                              <span
                                className={`batch-status ${
                                  trackedRelease?.buildStatus ?? 'pending'
                                }`}
                              >
                                {trackedRelease
                                  ? buildLabels[trackedRelease.buildStatus]
                                  : 'Waiting for workflow'}
                              </span>
                              <button
                                className="release-day-check-build"
                                type="button"
                                disabled={
                                  refreshing ||
                                  Boolean(busyAction) ||
                                  Boolean(checkingBuildRepository)
                                }
                                title={`Find the newest production tag created on or before ${session.releaseDate} and refresh its workflow status`}
                                onClick={() =>
                                  void checkLatestBuild(repository)
                                }
                              >
                                {checkingBuildRepository === repository ? (
                                  <>
                                    <span className="spinner" /> Checking…
                                  </>
                                ) : (
                                  '↻ Check latest build'
                                )}
                              </button>
                            </div>
                          ) : releaseCreationError ? (
                            <div className="release-day-release-failure">
                              <span className="batch-status error">
                                Tag creation failed
                              </span>
                              <small>{releaseCreationError}</small>
                              <button
                                className="release-day-tag-button retry"
                                type="button"
                                disabled={
                                  refreshing ||
                                  Boolean(busyAction) ||
                                  Boolean(activeProductionRelease)
                                }
                                onClick={() =>
                                  void createSingleProductionRelease(repository)
                                }
                              >
                                {activeProductionRelease === repository ? (
                                  <>
                                    <span className="spinner" /> Retrying…
                                  </>
                                ) : (
                                  '↻ Retry tag creation'
                                )}
                              </button>
                            </div>
                          ) : (
                            <div className="release-day-release-empty">
                              <span className="batch-status pending">
                                Not created
                              </span>
                              <button
                                className="release-day-tag-button"
                                type="button"
                                disabled={
                                  refreshing ||
                                  Boolean(busyAction) ||
                                  Boolean(activeProductionRelease)
                                }
                                onClick={() =>
                                  void createSingleProductionRelease(repository)
                                }
                              >
                                {activeProductionRelease === repository ? (
                                  <>
                                    <span className="spinner" /> Creating…
                                  </>
                                ) : (
                                  '+ Create tag'
                                )}
                              </button>
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="release-day-production-deployment">
                            <button
                              className="production-deploy-button"
                              type="button"
                              disabled={
                                !productionEnabled ||
                                trackedRelease?.buildStatus !== 'succeeded' ||
                                !repositoryState?.jenkinsServices.length ||
                                latestTagAlreadyDeployed
                              }
                              title={
                                latestTagAlreadyDeployed
                                  ? `${release?.tag} is already deployed to production`
                                  : 'Deploy the latest production build'
                              }
                              onClick={() =>
                                release &&
                                setDeployTarget({
                                  repository,
                                  release,
                                  services:
                                    repositoryState?.jenkinsServices ?? [],
                                })
                              }
                            >
                              {latestTagAlreadyDeployed
                                ? 'Already deployed'
                                : 'Deploy'}
                            </button>
                            {productionDeployments.length > 0 ? (
                              productionDeployments.map((deployment) => (
                                <a
                                  className="release-day-production-live"
                                  href={deployment.buildUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  key={deployment.service}
                                  title={`Jenkins build #${deployment.buildNumber}`}
                                >
                                  Live: {deployment.tag}
                                  {productionDeployments.length > 1
                                    ? ` · ${deployment.service}`
                                    : ''}{' '}
                                  ↗
                                </a>
                              ))
                            ) : (
                              <small className="release-day-production-unknown">
                                {repositoryState?.deploymentLookupFailed
                                  ? 'Production status unavailable'
                                  : 'Production deployment unknown'}
                              </small>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <section className="release-day-log" aria-label="Operation log">
              <div>
                <h3>Operation log</h3>
                <span>{session.logs.length} events</span>
              </div>
              {session.logs.length ? (
                <ol>
                  {[...session.logs].reverse().map((entry) => (
                    <li className={entry.level} key={entry.id}>
                      <time>{new Date(entry.at).toLocaleTimeString()}</time>
                      {entry.repository && (
                        <code>{entry.repository.split('/').at(-1)}</code>
                      )}
                      <span>{entry.message}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No operations have run yet.</p>
              )}
            </section>
            </div>
      </section>

      {developerModal && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={() => setDeveloperModal(undefined)}
        >
          <section
            className="release-dialog release-developers-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="release-developers-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="dialog-close"
              type="button"
              onClick={() => setDeveloperModal(undefined)}
              aria-label="Close"
            >
              ×
            </button>
            <p className="eyebrow">Release contributors</p>
            <h2 id="release-developers-title">
              {developerModal.repository.split('/').at(-1)} Developers
            </h2>
            {developerModal.loading ? (
              <div className="operation-loading">
                <span className="spinner" /> Loading developers…
              </div>
            ) : developerModal.developers.length > 0 ? (
              <div className="release-developer-list">
                {developerModal.developers.map((developer) => (
                  <article key={developer.login}>
                    <img src={developer.avatarUrl} alt="" />
                    <div>
                      <strong>{developer.login}</strong>
                      <small>
                        {developer.roles.join(', ')} ·{' '}
                        {developer.pullRequests.length}{' '}
                        {developer.pullRequests.length === 1 ? 'PR' : 'PRs'}
                      </small>
                    </div>
                    <span>
                      {developer.pullRequests.map((pullNumber) => (
                        <a
                          href={`https://github.com/${developerModal.repository}/pull/${pullNumber}`}
                          target="_blank"
                          rel="noreferrer"
                          key={pullNumber}
                        >
                          #{pullNumber}
                        </a>
                      ))}
                    </span>
                  </article>
                ))}
              </div>
            ) : (
              <div className="operation-empty">
                No developers were found on this service&apos;s release PRs.
              </div>
            )}
          </section>
        </div>
      )}

      {deployTarget && (
        <ProductionDeployDialog
          repository={deployTarget.repository}
          services={deployTarget.services}
          sourceTag={deployTarget.release.tag}
          onClose={() => setDeployTarget(undefined)}
        />
      )}
    </>
  )
}

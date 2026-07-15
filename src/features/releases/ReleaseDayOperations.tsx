import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../shared/api'
import type {
  BuildStatus,
  CreatedProductionRelease,
  PromotionPullRequest,
  PromotionRoute,
  ReleaseDashboard,
  RepositoryReleaseState,
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

const POLL_INTERVAL = 15_000
const MAX_CONCURRENCY = 3

function localDate() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function sessionKey(versionId: string) {
  return `release-day-operations:${versionId}`
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
      { length: Math.min(MAX_CONCURRENCY, values.length) },
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
  const [states, setStates] = useState<
    Record<string, RepositoryReleaseState | undefined>
  >({})
  const [refreshing, setRefreshing] = useState(false)
  const [busyAction, setBusyAction] = useState('')
  const [deployTarget, setDeployTarget] = useState<DeployTarget>()
  const sessionRef = useRef(session)
  const loadSequence = useRef(0)

  useEffect(() => {
    sessionRef.current = session
    window.localStorage.setItem(
      sessionKey(session.versionId),
      JSON.stringify(session),
    )
  }, [session])

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

  const refreshStates = useCallback(
    async (silent = false, force = false) => {
      const repositories = sessionRef.current.selectedRepositories
      if (repositories.length === 0) return
      const sequence = ++loadSequence.current
      if (!silent) setRefreshing(true)
      const next: Record<string, RepositoryReleaseState | undefined> = {}
      await mapConcurrent(repositories, async (repository) => {
        try {
          if (force) await api.refreshRepository(repository)
          next[repository] = await api.repositoryState(repository)
        } catch (reason) {
          if (!silent) {
            const message =
              reason instanceof Error
                ? reason.message
                : 'Could not refresh repository state.'
            setRepositoryError(repository, message)
          }
        }
      })
      if (sequence === loadSequence.current) {
        setStates((current) => ({ ...current, ...next }))
        if (!silent) setRefreshing(false)
      }
    },
    [setRepositoryError],
  )

  useEffect(() => {
    void refreshStates()
  }, [refreshStates])

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
  ) {
    if (busyAction || selected.length === 0) return
    setBusyAction(action)
    log('info', `${action} started for ${selected.length} services.`)
    await mapConcurrent(selected, async (repository) => {
      setRepositoryError(repository)
      try {
        await task(repository)
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : `${action} failed.`
        setRepositoryError(repository, message)
        log('error', message, repository)
      }
    })
    await refreshStates(true)
    log('info', `${action} finished. Review flagged services before continuing.`)
    setBusyAction('')
  }

  async function createPullRequests(route: PromotionRoute) {
    const title =
      route === 'dev-to-release'
        ? 'Create Dev → Release PRs'
        : 'Create Release → Default PRs'
    await runAction(title, async (repository) => {
      const step = routeStep(states[repository], route)
      if (step?.state === 'up_to_date') {
        log('success', `${step.fromBranch} and ${step.toBranch} are already aligned.`, repository)
        return
      }
      const pull =
        step?.pullRequest ??
        (await api.createPromotionPullRequest({ repository, route }))
      log(
        'success',
        `PR #${pull.number}: ${pull.title} (${pull.headBranch} → ${pull.baseBranch})`,
        repository,
      )
    })
  }

  async function mergePullRequests(route: PromotionRoute) {
    const title =
      route === 'dev-to-release'
        ? 'Merge Dev → Release PRs'
        : 'Merge Release → Default PRs'
    await runAction(title, async (repository) => {
      const step = routeStep(states[repository], route)
      if (step?.state === 'up_to_date') {
        log('success', 'Branches are already aligned; no merge required.', repository)
        return
      }
      if (!step?.pullRequest) throw new Error('No open promotion PR was found.')
      const blocked = mergeBlockReason(step.pullRequest)
      if (blocked) throw new Error(`${blocked} on PR #${step.pullRequest.number}.`)
      const result = await api.mergePromotionPullRequest({
        repository,
        pullNumber: step.pullRequest.number,
      })
      if (!result.merged) throw new Error(result.message || 'GitHub did not merge the PR.')
      log('success', `Merged PR #${step.pullRequest.number}.`, repository)
    })
  }

  async function createProductionReleases() {
    await runAction('Create production releases', async (repository) => {
      const saved = sessionRef.current.repositories[repository]?.productionRelease
      if (saved) {
        log('success', `${saved.tag} was already created for this run.`, repository)
        return
      }
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
            error: undefined,
          },
        },
      }))
      log('success', `Created ${release.tag} from release.`, repository)
      window.dispatchEvent(
        new CustomEvent('production-release-created', {
          detail: { repository },
        }),
      )
    })
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
    setStates({})
  }

  return (
    <>
      <section className="release-day-page" aria-labelledby="release-day-title">
            <header className="release-day-header">
              <div>
                <p className="eyebrow">Release-day control room</p>
                <h2 id="release-day-title">{dashboard.version.name}</h2>
                <p>
                  Saved locally · canonical state reconciled from GitHub every
                  15 seconds
                </p>
              </div>
              <div className="release-day-header-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void refreshStates(false, true)}
                  disabled={refreshing || Boolean(busyAction)}
                >
                  {refreshing ? 'Refreshing…' : '↻ Refresh status'}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={onClose}
                >
                  ← Back to dashboard
                </button>
              </div>
            </header>

            {!productionEnabled && (
              <div className="alert warning">
                Production Jenkins is not connected. Promotion and release
                creation are available, but deploy buttons will remain disabled.
              </div>
            )}

            <div className="release-day-config">
              <label>
                Production release date
                <input
                  type="date"
                  value={session.releaseDate}
                  disabled={releasesCreated || Boolean(busyAction)}
                  onChange={(event) =>
                    setSession((current) => ({
                      ...current,
                      releaseDate: event.target.value,
                    }))
                  }
                />
              </label>
              <span>
                {selected.length}/{dashboard.services.length} services selected
              </span>
              <button
                className="text-button"
                type="button"
                disabled={Boolean(busyAction)}
                onClick={() =>
                  setSession((current) => ({
                    ...current,
                    selectedRepositories: dashboard.services.map(
                      (service) => service.repository,
                    ),
                  }))
                }
              >
                Select all
              </button>
              <button
                className="text-button"
                type="button"
                disabled={Boolean(busyAction)}
                onClick={resetSession}
              >
                New run
              </button>
            </div>

            <div className="release-day-steps">
              <article className="release-day-step">
                <span>1</span>
                <div>
                  <strong>Create Dev → Release PRs</strong>
                  <small>Existing PRs are detected and logged.</small>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={Boolean(busyAction) || selected.length === 0}
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
                  <small>Conflicts, drafts, and failing checks are flagged.</small>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!devPrsReady || Boolean(busyAction)}
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
                  <small>Default branch is discovered per repository.</small>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!devMerged || Boolean(busyAction)}
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
                  <small>The release cannot advance until every branch is aligned.</small>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!defaultPrsReady || Boolean(busyAction)}
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
                  <small>Backend/frontend tag formats and retries are automatic.</small>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!defaultMerged || Boolean(busyAction)}
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
                  <small>
                    {buildsSucceeded
                      ? 'Every selected build succeeded.'
                      : 'Deploy unlocks separately for each successful build.'}
                  </small>
                </div>
                <span className="auto-refresh">Live · 15s</span>
              </article>
            </div>

            <div className="release-day-workspace">
            <div className="release-day-table-wrap">
              <table className="release-day-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">Selected</span>
                    </th>
                    <th scope="col">Service</th>
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
                    const release = progress?.productionRelease
                    const trackedRelease = release
                      ? states[repository]?.productionReleases.find(
                          (item) => item.tag === release.tag,
                        )
                      : undefined
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
                    return (
                      <tr
                        key={repository}
                        className={!selectedSet.has(repository) ? 'unselected' : ''}
                      >
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedSet.has(repository)}
                            disabled={Boolean(busyAction)}
                            onChange={() => toggleRepository(repository)}
                            aria-label={`Include ${repository}`}
                          />
                        </td>
                        <td>
                          <strong>{repository.split('/').at(-1)}</strong>
                          <small>{repository}</small>
                          {progress?.error && (
                            <span className="release-day-error">
                              {progress.error}
                            </span>
                          )}
                        </td>
                        <td>
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
                        </td>
                        <td>
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
                        </td>
                        <td>
                          {release ? (
                            <>
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
                            </>
                          ) : (
                            <span className="batch-status pending">Not created</span>
                          )}
                        </td>
                        <td>
                          <button
                            className="production-deploy-button"
                            type="button"
                            disabled={
                              !productionEnabled ||
                              trackedRelease?.buildStatus !== 'succeeded' ||
                              !states[repository]?.jenkinsServices.length
                            }
                            onClick={() =>
                              release &&
                              setDeployTarget({
                                repository,
                                release,
                                services:
                                  states[repository]?.jenkinsServices ?? [],
                              })
                            }
                          >
                            Deploy
                          </button>
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

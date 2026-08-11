import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../shared/api'
import type {
  BackMergeStep,
  BuildStatus,
  JenkinsDeployedTag,
  PromotionStep,
  RepositoryReleaseData,
  RepositoryReleaseState,
  TrackedStagingRelease,
  TrackedProductionRelease,
} from '../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { DeployDialog } from './DeployDialog'
import { ProductionDeployDialog } from './ProductionDeployDialog'

type Props = {
  repository: string
  productionEnabled?: boolean
  includeAllVReleases?: boolean
  view?: 'all' | 'releases' | 'branches' | 'hidden'
  onCreateStagingRelease?: () => void
  onCreateProductionRelease?: () => void
}

type PendingServiceMerge = {
  kind: 'promotion' | 'back-merge'
  force: boolean
  pullNumber: number
  fromBranch: string
  toBranch: string
  route: string
}

const buildLabels: Record<BuildStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
}

const BUILD_POLL_INTERVAL_MS = 15_000
const BUILD_POLL_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error('Timed out'))
    }, ms)
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId)
        resolve(value)
      },
      (reason) => {
        window.clearTimeout(timeoutId)
        reject(reason)
      },
    )
  })
}

function deploymentLabel(deployment: JenkinsDeployedTag) {
  const environment = deployment.environment.toUpperCase()
  switch (deployment.status) {
    case 'running':
      return `Running in ${environment}`
    case 'failed':
      return `Failed in ${environment}`
    case 'canceled':
      return `Canceled in ${environment}`
    default:
      return `Live in ${environment}`
  }
}

function timeAgo(value: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  )
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

function hardMergeBlockReason(pull: {
  draft: boolean
  mergeable: boolean | null
  mergeableState: string
}) {
  if (pull.draft) return 'PR is still a draft'
  if (pull.mergeable === null) return 'GitHub is checking mergeability'
  if (pull.mergeable === false || pull.mergeableState === 'dirty') {
    return 'PR has merge conflicts'
  }
  return undefined
}

function checksSoftBlockReason(pull: { checks: string }) {
  if (pull.checks === 'pending') return 'Checks are pending'
  if (pull.checks === 'failure') return 'Checks are failing'
  return undefined
}

function reviewStatusLabel(pull: {
  reviewDecision: string
  unresolvedReviewThreads?: number
}) {
  if (
    (pull.unresolvedReviewThreads ?? 0) > 0 &&
    pull.reviewDecision === 'approved'
  ) {
    return 'unresolved comments'
  }
  return pull.reviewDecision.replaceAll('_', ' ')
}

function mergeBlockReason(
  step: PromotionStep,
  hasBackMerges: boolean,
): string | undefined {
  if (hasBackMerges) return 'Resolve pending back-merges first'
  const pull = step.pullRequest
  if (!pull) return undefined
  if (
    (pull.unresolvedReviewThreads ?? 0) > 0 &&
    pull.reviewDecision === 'approved'
  ) {
    return 'Resolve unresolved review comments'
  }
  return hardMergeBlockReason(pull) ?? checksSoftBlockReason(pull)
}

function canForceMergePromotion(
  step: PromotionStep,
  hasBackMerges: boolean,
): boolean {
  if (hasBackMerges || !step.pullRequest) return false
  const unresolvedComments =
    (step.pullRequest.unresolvedReviewThreads ?? 0) > 0 &&
    step.pullRequest.reviewDecision === 'approved'
  return (
    !hardMergeBlockReason(step.pullRequest) &&
    (Boolean(checksSoftBlockReason(step.pullRequest)) || unresolvedComments)
  )
}

function backMergeBlockReason(step: BackMergeStep) {
  const pull = step.pullRequest
  if (!pull) return undefined
  if (
    (pull.unresolvedReviewThreads ?? 0) > 0 &&
    pull.reviewDecision === 'approved'
  ) {
    return 'Resolve unresolved review comments'
  }
  return hardMergeBlockReason(pull) ?? checksSoftBlockReason(pull)
}

function canForceMergeBackMerge(step: BackMergeStep): boolean {
  if (!step.pullRequest) return false
  const unresolvedComments =
    (step.pullRequest.unresolvedReviewThreads ?? 0) > 0 &&
    step.pullRequest.reviewDecision === 'approved'
  return (
    !hardMergeBlockReason(step.pullRequest) &&
    (Boolean(checksSoftBlockReason(step.pullRequest)) || unresolvedComments)
  )
}

export function ServiceOperations({
  repository,
  productionEnabled = false,
  includeAllVReleases = false,
  view = 'all',
  onCreateStagingRelease,
  onCreateProductionRelease,
}: Props) {
  const [state, setState] = useState<RepositoryReleaseState>()
  const [releaseState, setReleaseState] = useState<RepositoryReleaseData>()
  const [branchLoading, setBranchLoading] = useState(true)
  const [releaseLoading, setReleaseLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyRoute, setBusyRoute] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [releaseLimit, setReleaseLimit] = useState(5)
  const [deployRelease, setDeployRelease] =
    useState<TrackedStagingRelease>()
  const [productionDeployRelease, setProductionDeployRelease] =
    useState<TrackedProductionRelease>()
  const [pendingMerge, setPendingMerge] = useState<PendingServiceMerge>()
  const [browserNotifications, setBrowserNotifications] = useState(
    () =>
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      window.localStorage.getItem('release-build-notifications') === 'true',
  )
  const [notificationToast, setNotificationToast] = useState<{
    message: string
    status?: BuildStatus
  }>()
  const previousBuilds = useRef(new Map<string, BuildStatus>())
  const buildsInitialized = useRef(false)
  const browserNotificationsRef = useRef(browserNotifications)
  const loadSequence = useRef(0)
  const releaseLimitRef = useRef(releaseLimit)
  const releaseStateRef = useRef(releaseState)

  useEffect(() => {
    browserNotificationsRef.current = browserNotifications
  }, [browserNotifications])

  useEffect(() => {
    releaseLimitRef.current = releaseLimit
  }, [releaseLimit])

  useEffect(() => {
    releaseStateRef.current = releaseState
  }, [releaseState])

  const announceCompletedBuilds = useCallback(
    (nextState: RepositoryReleaseData) => {
      const nextBuilds = new Map(
        nextState.stagingReleases.map((release) => [
          release.tag,
          release.buildStatus,
        ]),
      )
      if (!buildsInitialized.current) {
        previousBuilds.current = nextBuilds
        buildsInitialized.current = true
        return
      }
      const completed = nextState.stagingReleases.filter((release) => {
        const previous = previousBuilds.current.get(release.tag)
        return (
          ['succeeded', 'failed', 'canceled'].includes(release.buildStatus) &&
          previous !== release.buildStatus
        )
      })
      previousBuilds.current = nextBuilds
      if (completed.length === 0) return

      const latest = completed[0]
      const statusLabel = buildLabels[latest.buildStatus]
      const message =
        completed.length === 1
          ? `${latest.tag} ${statusLabel.toLowerCase()}`
          : `${completed.length} release builds completed`
      setNotificationToast({ message, status: latest.buildStatus })
      if (
        browserNotificationsRef.current &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        new Notification(`Release build ${statusLabel}`, {
          body: `${repository.split('/').at(-1)} · ${message}`,
          tag: `release-build-${repository}-${latest.tag}`,
        })
      }
    },
    [repository],
  )

  const loadBranches = useCallback(
    async (silent = false) => {
      const sequence = ++loadSequence.current
      if (!silent) setBranchLoading(true)
      setError('')
      try {
        const nextState = await api.repositoryState(repository)
        if (sequence !== loadSequence.current) return
        setState(nextState)
      } catch (reason) {
        if (sequence !== loadSequence.current) return
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not load repository operations.',
        )
      } finally {
        if (!silent && sequence === loadSequence.current) setBranchLoading(false)
      }
    },
    [repository],
  )

  const loadReleases = useCallback(
    async (silent = false, limit = releaseLimitRef.current) => {
      if (!silent) setReleaseLoading(true)
      setError('')
      try {
        const nextState = await api.repositoryReleaseData(
          repository,
          includeAllVReleases,
          limit,
        )
        announceCompletedBuilds(nextState)
        setReleaseState(nextState)
        setReleaseLimit(limit)
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not load repository releases.',
        )
      } finally {
        if (!silent) setReleaseLoading(false)
      }
    },
    [announceCompletedBuilds, includeAllVReleases, repository],
  )

  const load = useCallback(
    async (silent = false) => {
      const requests: Promise<void>[] = []
      if (view === 'all' || view === 'releases') {
        requests.push(loadReleases(silent))
      }
      if (view === 'all' || view === 'branches') {
        requests.push(loadBranches(silent))
      }
      await Promise.allSettled(requests)
    },
    [loadBranches, loadReleases, view],
  )

  useEffect(() => {
    setState(undefined)
    setReleaseState(undefined)
    setBranchLoading(view === 'all' || view === 'branches')
    setReleaseLoading(view === 'all' || view === 'releases')
    setError('')
    setReleaseLimit(5)
    releaseLimitRef.current = 5
    previousBuilds.current = new Map()
    buildsInitialized.current = false
    void load()
    const refresh = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          repository?: string
          state?: RepositoryReleaseState
        }>
      ).detail
      if (!detail?.repository || detail.repository === repository) {
        if (detail?.state) {
          loadSequence.current += 1
          const releases: RepositoryReleaseData = {
            repository: detail.state.repository,
            stagingReleases: detail.state.stagingReleases,
            productionReleases: detail.state.productionReleases,
            hasMoreStaging: false,
            hasMoreProduction: false,
            deployedTags: detail.state.deployedTags,
            deploymentLookupFailed: detail.state.deploymentLookupFailed,
            jenkinsServices: detail.state.jenkinsServices,
            fetchedAt: detail.state.fetchedAt,
          }
          announceCompletedBuilds(releases)
          setReleaseState(releases)
          setState(detail.state)
          setReleaseLoading(false)
          setBranchLoading(false)
          setError('')
          return
        }
        void load(true)
      }
    }
    window.addEventListener('staging-release-created', refresh)
    window.addEventListener('production-release-created', refresh)
    window.addEventListener('service-refresh-requested', refresh)
    return () => {
      window.removeEventListener('staging-release-created', refresh)
      window.removeEventListener('production-release-created', refresh)
      window.removeEventListener('service-refresh-requested', refresh)
    }
  }, [announceCompletedBuilds, load, repository, view])

  const releaseTrackKey =
    releaseState && (view === 'all' || view === 'releases')
      ? [
          ...releaseState.stagingReleases.map((release) => release.tag),
          ...releaseState.productionReleases.map((release) => release.tag),
        ].join('\0')
      : ''

  useEffect(() => {
    if (!releaseTrackKey) return

    let active = true
    let inFlight = false
    const poll = async () => {
      if (!active || inFlight || document.hidden) return
      const current = releaseStateRef.current
      if (!current) return
      const trackedReleases = [
        ...current.stagingReleases,
        ...current.productionReleases,
      ].map((release) => ({
        repository,
        tag: release.tag,
        createdAt: release.createdAt,
      }))
      if (trackedReleases.length === 0) return

      inFlight = true
      try {
        const [buildResult, deploymentResult] = await Promise.allSettled([
          withTimeout(
            api.releaseBuildStatuses(trackedReleases, true),
            BUILD_POLL_TIMEOUT_MS,
          ),
          withTimeout(
            api.repositoryDeploymentStatus(repository, true),
            BUILD_POLL_TIMEOUT_MS,
          ),
        ])
        if (!active) return
        const latest = releaseStateRef.current
        if (!latest) return
        const results =
          buildResult.status === 'fulfilled' ? buildResult.value : []
        const byTag = new Map(results.map((result) => [result.tag, result]))
        const nextState: RepositoryReleaseData = {
          ...latest,
          stagingReleases: latest.stagingReleases.map((release) => {
            const result = byTag.get(release.tag)
            return result
              ? {
                  ...release,
                  buildStatus: result.buildStatus,
                  runs: result.runs,
                }
              : release
          }),
          productionReleases: latest.productionReleases.map((release) => {
            const result = byTag.get(release.tag)
            return result
              ? {
                  ...release,
                  buildStatus: result.buildStatus,
                  runs: result.runs,
                }
              : release
          }),
          deployedTags:
            deploymentResult.status === 'fulfilled'
              ? deploymentResult.value.deployedTags
              : latest.deployedTags,
          deploymentLookupFailed:
            deploymentResult.status === 'fulfilled'
              ? deploymentResult.value.deploymentLookupFailed
              : true,
          fetchedAt: new Date().toISOString(),
        }
        if (buildResult.status === 'fulfilled') {
          announceCompletedBuilds(nextState)
        }
        setReleaseState(nextState)
      } finally {
        inFlight = false
      }
    }
    const visibilityChanged = () => {
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    const interval = window.setInterval(() => void poll(), BUILD_POLL_INTERVAL_MS)
    return () => {
      active = false
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [announceCompletedBuilds, releaseTrackKey, repository])

  useEffect(() => {
    if (!notificationToast) return
    const timeout = window.setTimeout(
      () => setNotificationToast(undefined),
      6_000,
    )
    return () => window.clearTimeout(timeout)
  }, [notificationToast])

  async function toggleBrowserNotifications() {
    if (browserNotifications) {
      window.localStorage.setItem('release-build-notifications', 'false')
      setBrowserNotifications(false)
      return
    }
    if (typeof Notification === 'undefined') {
      setNotificationToast({
        message: 'Browser notifications are not supported.',
      })
      return
    }
    const permission = await Notification.requestPermission()
    if (permission === 'granted') {
      window.localStorage.setItem('release-build-notifications', 'true')
      setBrowserNotifications(true)
      setNotificationToast({ message: 'Build alerts enabled.' })
    } else {
      setNotificationToast({
        message: 'Browser notifications are blocked.',
      })
    }
  }

  async function loadMoreReleases() {
    const nextLimit = Math.min(releaseLimit + 5, 30)
    if (nextLimit <= releaseLimit) return
    setLoadingMore(true)
    setError('')
    try {
      const history = await api.repositoryReleaseData(
        repository,
        includeAllVReleases,
        nextLimit,
      )
      setReleaseState(history)
      setReleaseLimit(nextLimit)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not load more releases.',
      )
    } finally {
      setLoadingMore(false)
    }
  }

  async function refreshOperations() {
    setRefreshing(true)
    setError('')
    try {
      await api.refreshRepository(repository)
      await load()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not refresh repository operations.',
      )
    } finally {
      setRefreshing(false)
    }
  }

  async function createPull(step: PromotionStep) {
    setBusyRoute(step.route)
    setError('')
    try {
      await api.createPromotionPullRequest({ repository, route: step.route })
      await load(true)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not create the PR.',
      )
    } finally {
      setBusyRoute('')
    }
  }

  async function mergePull(step: PromotionStep) {
    if (!step.pullRequest) return
    const force =
      canForceMergePromotion(step, (state?.pendingBackMerges.length ?? 0) > 0)
    setPendingMerge({
      kind: 'promotion',
      force,
      pullNumber: step.pullRequest.number,
      fromBranch: step.fromBranch,
      toBranch: step.toBranch,
      route: step.route,
    })
  }

  async function mergeBackMerge(step: BackMergeStep) {
    if (!step.pullRequest) return
    const force = canForceMergeBackMerge(step)
    setPendingMerge({
      kind: 'back-merge',
      force,
      pullNumber: step.pullRequest.number,
      fromBranch: step.fromBranch,
      toBranch: step.toBranch,
      route: step.route,
    })
  }

  async function confirmPendingMerge() {
    if (!pendingMerge) return
    const pending = pendingMerge
    setPendingMerge(undefined)
    setBusyRoute(pending.route)
    setError('')
    try {
      if (pending.kind === 'promotion') {
        await api.mergePromotionPullRequest({
          repository,
          pullNumber: pending.pullNumber,
          ...(pending.force ? { bypassBranchProtection: true } : {}),
        })
      } else {
        await api.mergeBackMergePullRequest({
          repository,
          pullNumber: pending.pullNumber,
          ...(pending.force ? { bypassBranchProtection: true } : {}),
        })
      }
      await load(true)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : pending.kind === 'promotion'
            ? 'Could not merge the PR.'
            : 'Could not merge the back-merge PR.',
      )
    } finally {
      setBusyRoute('')
    }
  }

  const pendingMergeCopy = pendingMerge
    ? pendingMerge.kind === 'promotion'
      ? pendingMerge.force
        ? {
            title: `Force merge to ${pendingMerge.toBranch}?`,
            message: `Force merge #${pendingMerge.pullNumber} from ${pendingMerge.fromBranch} to ${pendingMerge.toBranch}?\n\nThis bypasses required checks. Your GitHub token must have branch-protection bypass access.`,
            confirmLabel: 'Force merge',
          }
        : {
            title: `Merge to ${pendingMerge.toBranch}?`,
            message: `Merge #${pendingMerge.pullNumber} from ${pendingMerge.fromBranch} to ${pendingMerge.toBranch}?`,
            confirmLabel: 'Merge',
          }
      : pendingMerge.force
        ? {
            title: `Force back-merge to ${pendingMerge.toBranch}?`,
            message: `Force back-merge #${pendingMerge.pullNumber} from ${pendingMerge.fromBranch} to ${pendingMerge.toBranch}?\n\nThis bypasses required checks. Your GitHub token must have branch-protection bypass access.`,
            confirmLabel: 'Force merge',
          }
        : {
            title: `Back-merge to ${pendingMerge.toBranch}?`,
            message: `Back-merge #${pendingMerge.pullNumber} from ${pendingMerge.fromBranch} to ${pendingMerge.toBranch}?`,
            confirmLabel: 'Merge',
          }
    : undefined

  async function createBackMerge(step: BackMergeStep) {
    setBusyRoute(step.route)
    setError('')
    try {
      await api.createBackMergePullRequest({
        repository,
        route: step.route,
      })
      await load(true)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not create the back-merge PR.',
      )
    } finally {
      setBusyRoute('')
    }
  }

  return (
    <div className="service-operations">
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {notificationToast && (
        <div
          className={`build-notification-toast ${notificationToast.status ?? 'info'}`}
          role="status"
        >
          <span aria-hidden="true">●</span>
          <div>
            <strong>Release build update</strong>
            <p>{notificationToast.message}</p>
          </div>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setNotificationToast(undefined)}
          >
            ×
          </button>
        </div>
      )}

      {(view === 'releases' || view === 'branches') && (
        <div className="service-tab-panel-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => void refreshOperations()}
            disabled={refreshing}
          >
            {refreshing
              ? 'Refreshing…'
              : view === 'releases'
                ? '↻ Refresh releases'
                : '↻ Refresh branch ops'}
          </button>
        </div>
      )}

      {(view === 'all' || view === 'releases') && (
        <>
      <section className="operation-section">
        <div className="operation-heading">
          <div>
            <p className="eyebrow">GitHub Actions</p>
            <h3>
              {includeAllVReleases ? 'Release builds' : 'Staging releases'}
            </h3>
          </div>
          <div className="operation-heading-actions">
            {onCreateStagingRelease && (
              <button
                className="create-release-button"
                type="button"
                onClick={onCreateStagingRelease}
              >
                <span aria-hidden="true">＋</span> Create staging release
              </button>
            )}
            <button
              className={`notification-toggle ${browserNotifications ? 'active' : ''}`}
              type="button"
              aria-pressed={browserNotifications}
              onClick={() => void toggleBrowserNotifications()}
            >
              {browserNotifications ? '● Alerts on' : 'Enable alerts'}
            </button>
            <span className="auto-refresh">Live · 15s</span>
          </div>
        </div>
        {releaseState?.deploymentLookupFailed && (
          <p className="deployment-lookup-note">
            Jenkins deployment status is temporarily unavailable.
          </p>
        )}

        {releaseLoading && !releaseState ? (
          <div className="operation-loading">
            <span className="spinner" /> Loading release builds…
          </div>
        ) : releaseState?.stagingReleases.length ? (
          <>
          <div className="release-build-list">
            {releaseState.stagingReleases.map((release) => {
              const liveDeployments = releaseState.deployedTags.filter(
                (deployment) => deployment.tag === release.tag,
              )
              return (
                <article className="release-build-row" key={release.id}>
                <span
                  className={`build-indicator ${release.buildStatus}`}
                  aria-hidden="true"
                />
                <div className="release-build-main">
                  <a href={release.url} target="_blank" rel="noreferrer">
                    {release.tag}
                  </a>
                  <span>
                    {release.environment.toUpperCase()} ·{' '}
                    {timeAgo(release.createdAt)}
                  </span>
                  {liveDeployments.length > 0 && (
                    <div className="live-deployments">
                      {liveDeployments.map((deployment) => (
                        <a
                          className={`live-deployment ${deployment.status ?? 'succeeded'}`}
                          href={deployment.buildUrl || undefined}
                          target="_blank"
                          rel="noreferrer"
                          title={`${deployment.service} · Jenkins build #${deployment.buildNumber}`}
                          key={`${deployment.service}-${deployment.environment}-${deployment.buildNumber}`}
                        >
                          <span aria-hidden="true">●</span>{' '}
                          {deploymentLabel(deployment)}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <span className={`build-status ${release.buildStatus}`}>
                  {buildLabels[release.buildStatus]}
                </span>
                <button
                  className="deploy-button"
                  type="button"
                  disabled={
                    release.buildStatus !== 'succeeded' ||
                    releaseState.jenkinsServices.length === 0
                  }
                  title={
                    releaseState.jenkinsServices.length === 0
                      ? 'No Jenkins service mapping for this repository'
                      : release.buildStatus !== 'succeeded'
                        ? 'Deployment is enabled after a successful build'
                        : 'Deploy this release'
                  }
                  onClick={() => setDeployRelease(release)}
                >
                  Deploy
                </button>
                <div className="workflow-links">
                  {release.runs.length === 0 ? (
                    <small>Waiting for workflow</small>
                  ) : (
                    release.runs.map((run) => (
                      <a
                        href={run.url}
                        target="_blank"
                        rel="noreferrer"
                        key={run.id}
                        title={`${run.status}${run.conclusion ? ` · ${run.conclusion}` : ''}`}
                      >
                        {run.name} ↗
                      </a>
                    ))
                  )}
                </div>
                </article>
              )
            })}
          </div>
          {releaseState.hasMoreStaging && (
            <div className="release-load-more">
              <button
                className="notification-toggle"
                type="button"
                onClick={() => void loadMoreReleases()}
                disabled={loadingMore || releaseLoading}
              >
                {loadingMore ? 'Loading more…' : 'Load more'}
              </button>
            </div>
          )}
          </>
        ) : (
          <div className="operation-empty">
            {includeAllVReleases
              ? 'No v- release builds found for this service.'
              : 'No staging releases found for this service.'}
          </div>
        )}
      </section>

      {productionEnabled && (
        <section className="operation-section">
          <div className="operation-heading">
            <div>
              <p className="eyebrow">GitHub Actions · Production</p>
              <h3>Production releases</h3>
            </div>
            <div className="operation-heading-actions">
              {onCreateProductionRelease && (
                <button
                  className="create-release-button"
                  type="button"
                  onClick={onCreateProductionRelease}
                >
                  <span aria-hidden="true">＋</span> Create production release
                </button>
              )}
              <span className="auto-refresh">Live · 15s</span>
            </div>
          </div>

          {releaseLoading && !releaseState ? (
            <div className="operation-loading">
              <span className="spinner" /> Loading production builds…
            </div>
          ) : releaseState?.productionReleases.length ? (
            <>
            <div className="release-build-list">
              {releaseState.productionReleases.map((release) => {
                const liveDeployments = releaseState.deployedTags.filter(
                  (deployment) => deployment.tag === release.tag,
                )
                const productionDeploymentRunning =
                  releaseState.deployedTags.some(
                    (deployment) =>
                      deployment.environment === 'production' &&
                      deployment.status === 'running',
                  )
                return (
                  <article className="release-build-row" key={release.id}>
                    <span
                      className={`build-indicator ${release.buildStatus}`}
                      aria-hidden="true"
                    />
                    <div className="release-build-main">
                      <a href={release.url} target="_blank" rel="noreferrer">
                        {release.tag}
                      </a>
                      <span>{timeAgo(release.createdAt)}</span>
                      {liveDeployments.length > 0 && (
                        <div className="live-deployments">
                          {liveDeployments.map((deployment) => (
                            <a
                              className={`live-deployment ${deployment.status ?? 'succeeded'}`}
                              href={deployment.buildUrl || undefined}
                              target="_blank"
                              rel="noreferrer"
                              title={`${deployment.service} · Jenkins build #${deployment.buildNumber}`}
                              key={`${deployment.service}-${deployment.environment}-${deployment.buildNumber}`}
                            >
                              <span aria-hidden="true">●</span>{' '}
                              {deploymentLabel(deployment)}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className={`build-status ${release.buildStatus}`}>
                      {buildLabels[release.buildStatus]}
                    </span>
                    <button
                      className="production-deploy-button"
                      type="button"
                      disabled={
                        release.buildStatus !== 'succeeded' ||
                        releaseState.jenkinsServices.length === 0 ||
                        productionDeploymentRunning
                      }
                      title={
                        productionDeploymentRunning
                          ? 'A production deployment is already running'
                          : releaseState.jenkinsServices.length === 0
                          ? 'No Jenkins service mapping for this repository'
                          : release.buildStatus !== 'succeeded'
                            ? 'Deployment is enabled after a successful build'
                            : 'Deploy this production release'
                      }
                      onClick={() => setProductionDeployRelease(release)}
                    >
                      Deploy production
                    </button>
                    <div className="workflow-links">
                      {release.runs.length === 0 ? (
                        <small>Waiting for workflow</small>
                      ) : (
                        release.runs.map((run) => (
                          <a
                            href={run.url}
                            target="_blank"
                            rel="noreferrer"
                            key={run.id}
                            title={`${run.status}${run.conclusion ? ` · ${run.conclusion}` : ''}`}
                          >
                            {run.name} ↗
                          </a>
                        ))
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
            {releaseState.hasMoreProduction && (
              <div className="release-load-more">
                <button
                  className="notification-toggle"
                  type="button"
                  onClick={() => void loadMoreReleases()}
                  disabled={loadingMore || releaseLoading}
                >
                  {loadingMore ? 'Loading more…' : 'Load more'}
                </button>
              </div>
            )}
            </>
          ) : (
            <div className="operation-empty">
              No production releases found for this service.
            </div>
          )}
        </section>
      )}
        </>
      )}

      {(view === 'all' || view === 'branches') && (
        <>
      <section className="operation-section branch-sync-section">
        <div className="operation-heading">
          <div>
            <p className="eyebrow">Back-merge health</p>
            <h3>Branch synchronization</h3>
          </div>
          <div className="operation-heading-actions">
            <span className="default-branch">
              Default · <code>{state?.defaultBranch ?? '—'}</code>
            </span>
          </div>
        </div>
        {branchLoading && !state ? (
          <div className="operation-loading">
            <span className="spinner" /> Checking dev, release, and default
            branches…
          </div>
        ) : (
          <div className="branch-sync-list">
            {state?.backMergeSteps.map((step) => {
            const blockReason = backMergeBlockReason(step)
            const forceReady = canForceMergeBackMerge(step)
            const mergeDisabled =
              (Boolean(blockReason) && !forceReady) || busyRoute === step.route
            return (
              <article
                className={`branch-sync-row ${step.state === 'up_to_date' ? 'current' : 'outdated'}`}
                key={step.route}
              >
                <div className="branch-sync-route">
                  <code>{step.fromBranch}</code>
                  <span>→</span>
                  <code>{step.toBranch}</code>
                </div>
                {step.state === 'up_to_date' && (
                  <div className="branch-sync-status current">
                    <strong>✓ Up to date</strong>
                    <small>
                      {step.filesChanged === 0 && step.commitsAhead > 0
                        ? 'Content is aligned; only merge history differs'
                        : `${step.toBranch} contains all commits from ${step.fromBranch}`}
                    </small>
                  </div>
                )}
                {step.state === 'needs_pr' && (
                  <>
                    <div className="branch-sync-status outdated">
                      <strong>
                        {step.toBranch} is {step.commitsAhead}{' '}
                        {step.commitsAhead === 1 ? 'commit' : 'commits'} behind
                      </strong>
                      <small>
                        No open back-merge PR from {step.fromBranch} to{' '}
                        {step.toBranch}
                      </small>
                    </div>
                    <button
                      className="journey-action"
                      type="button"
                      disabled={busyRoute === step.route}
                      onClick={() => void createBackMerge(step)}
                    >
                      {busyRoute === step.route
                        ? 'Creating…'
                        : 'Create back-merge PR'}
                    </button>
                  </>
                )}
                {step.state === 'pr_open' && step.pullRequest && (
                  <>
                    <div className="branch-sync-status outdated">
                      <strong>
                        <a
                          href={step.pullRequest.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          PR #{step.pullRequest.number} ·{' '}
                          {step.pullRequest.title} ↗
                        </a>
                      </strong>
                      <small>
                        {step.commitsAhead}{' '}
                        {step.commitsAhead === 1 ? 'commit' : 'commits'} waiting
                        · checks {step.pullRequest.checks} ·{' '}
                        {reviewStatusLabel(step.pullRequest)}
                      </small>
                      {blockReason && (
                        <small className="merge-block">{blockReason}</small>
                      )}
                    </div>
                    <button
                      className="journey-action merge"
                      type="button"
                      disabled={mergeDisabled}
                      onClick={() => void mergeBackMerge(step)}
                    >
                      {busyRoute === step.route
                        ? forceReady
                          ? 'Force merging…'
                          : 'Merging…'
                        : forceReady
                          ? `Force merge to ${step.toBranch}`
                          : `Merge to ${step.toBranch}`}
                    </button>
                  </>
                )}
              </article>
            )
            })}
          </div>
        )}
      </section>

      <section className="operation-section journey-section">
        <div className="operation-heading">
          <div>
            <p className="eyebrow">Branch promotion</p>
            <h3>Release journey</h3>
          </div>
          {state && (
            <span className="default-branch">
              Default · <code>{state.defaultBranch}</code>
            </span>
          )}
        </div>

        {branchLoading && !state ? (
          <div className="operation-loading">
            <span className="spinner" /> Loading Dev → Release → Default
            journey…
          </div>
        ) : (
          <div className="journey-track">
            {state?.promotionSteps.map((step, index) => {
            const hasBackMerges = state.pendingBackMerges.length > 0
            const blockReason = mergeBlockReason(step, hasBackMerges)
            const forceReady = canForceMergePromotion(step, hasBackMerges)
            const mergeDisabled =
              (Boolean(blockReason) && !forceReady) || busyRoute === step.route
            return (
              <article className="journey-step" key={step.route}>
                <div className="journey-branches">
                  <span className="branch-node">{step.fromBranch}</span>
                  <span className="branch-arrow">
                    <small>
                      {step.filesChanged === 0 && step.commitsAhead > 0
                        ? 'content aligned'
                        : `${step.commitsAhead} commits`}
                    </small>
                    →
                  </span>
                  <span className="branch-node">{step.toBranch}</span>
                </div>

                {step.state === 'up_to_date' && (
                  <div className="journey-state complete">
                    <span>✓</span>
                    <div>
                      <strong>Up to date</strong>
                      <small>
                        {step.filesChanged === 0 && step.commitsAhead > 0
                          ? 'No file changes; only merge history differs'
                          : 'No changes waiting to promote'}
                      </small>
                    </div>
                  </div>
                )}

                {step.state === 'needs_pr' && (
                  <div className="journey-state">
                    <div>
                      <strong>Ready to create PR</strong>
                      <small>
                        {step.previousTemplate
                          ? 'Uses the previous promotion PR title and description; only branches change.'
                          : 'No previous promotion PR found; a standard title and description will be used.'}
                      </small>
                    </div>
                    <span className="journey-actions">
                      <button
                        className="journey-action"
                        type="button"
                        disabled={busyRoute === step.route}
                        onClick={() => void createPull(step)}
                      >
                        {busyRoute === step.route ? 'Creating…' : 'Create PR'}
                      </button>
                      <a
                        className="journey-diff-link"
                        href={`https://github.com/${repository}/compare/${encodeURIComponent(step.toBranch)}...${encodeURIComponent(step.fromBranch)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View diff ↗
                      </a>
                    </span>
                  </div>
                )}

                {step.state === 'pr_open' && step.pullRequest && (
                  <div className="journey-state">
                    <div>
                      <strong>
                        <a
                          href={step.pullRequest.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          PR #{step.pullRequest.number} ↗
                        </a>
                      </strong>
                      <small>
                        {reviewStatusLabel(step.pullRequest)} ·{' '}
                        checks {step.pullRequest.checks}
                      </small>
                      {blockReason && (
                        <small className="merge-block">{blockReason}</small>
                      )}
                    </div>
                    <button
                      className="journey-action merge"
                      type="button"
                      disabled={mergeDisabled}
                      onClick={() => void mergePull(step)}
                    >
                      {busyRoute === step.route
                        ? forceReady
                          ? 'Force merging…'
                          : 'Merging…'
                        : forceReady
                          ? `Force merge to ${step.toBranch}`
                          : `Merge to ${step.toBranch}`}
                    </button>
                  </div>
                )}

                {index === 0 && <div className="journey-divider" />}
              </article>
            )
            })}
          </div>
        )}
      </section>
        </>
      )}
      {deployRelease && releaseState && (
        <DeployDialog
          repository={repository}
          release={deployRelease}
          services={releaseState.jenkinsServices}
          allowAnyVTag={includeAllVReleases}
          onClose={() => setDeployRelease(undefined)}
        />
      )}
      {productionDeployRelease && releaseState && (
        <ProductionDeployDialog
          repository={repository}
          services={releaseState.jenkinsServices}
          sourceTag={productionDeployRelease.tag}
          deployedTags={releaseState.deployedTags}
          onClose={() => setProductionDeployRelease(undefined)}
        />
      )}
      {pendingMergeCopy && (
        <ConfirmDialog
          title={pendingMergeCopy.title}
          message={pendingMergeCopy.message}
          confirmLabel={pendingMergeCopy.confirmLabel}
          onCancel={() => setPendingMerge(undefined)}
          onConfirm={() => void confirmPendingMerge()}
        />
      )}
    </div>
  )
}

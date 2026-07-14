import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../shared/api'
import type {
  BuildStatus,
  PromotionStep,
  RepositoryReleaseState,
  TrackedStagingRelease,
  TrackedProductionRelease,
} from '../../shared/types'
import { DeployDialog } from './DeployDialog'
import { ProductionDeployDialog } from './ProductionDeployDialog'

type Props = {
  repository: string
  productionEnabled?: boolean
}

const buildLabels: Record<BuildStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
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

function mergeBlockReason(
  step: PromotionStep,
  hasBackMerges: boolean,
): string | undefined {
  if (hasBackMerges) return 'Resolve pending back-merges first'
  const pull = step.pullRequest
  if (!pull) return undefined
  if (pull.draft) return 'PR is still a draft'
  if (pull.mergeable === null) return 'GitHub is checking mergeability'
  if (pull.mergeable === false || pull.mergeableState === 'dirty') {
    return 'PR has merge conflicts'
  }
  if (pull.checks === 'pending') return 'Checks are pending'
  if (pull.checks === 'failure') return 'Checks are failing'
  return undefined
}

export function ServiceOperations({
  repository,
  productionEnabled = false,
}: Props) {
  const [state, setState] = useState<RepositoryReleaseState>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyRoute, setBusyRoute] = useState('')
  const [deployRelease, setDeployRelease] =
    useState<TrackedStagingRelease>()
  const [productionDeployRelease, setProductionDeployRelease] =
    useState<TrackedProductionRelease>()
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

  useEffect(() => {
    browserNotificationsRef.current = browserNotifications
  }, [browserNotifications])

  const announceCompletedBuilds = useCallback(
    (nextState: RepositoryReleaseState) => {
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

  const load = useCallback(
    async (silent = false) => {
      const sequence = ++loadSequence.current
      if (!silent) setLoading(true)
      setError('')
      try {
        const nextState = await api.repositoryState(repository)
        if (sequence !== loadSequence.current) return
        announceCompletedBuilds(nextState)
        setState(nextState)
      } catch (reason) {
        if (sequence !== loadSequence.current) return
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not load repository operations.',
        )
      } finally {
        if (!silent && sequence === loadSequence.current) setLoading(false)
      }
    },
    [announceCompletedBuilds, repository],
  )

  useEffect(() => {
    setState(undefined)
    setLoading(true)
    setError('')
    previousBuilds.current = new Map()
    buildsInitialized.current = false
    void load()
    const interval = window.setInterval(() => void load(true), 15_000)
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
          announceCompletedBuilds(detail.state)
          setState(detail.state)
          setLoading(false)
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
      window.clearInterval(interval)
      window.removeEventListener('staging-release-created', refresh)
      window.removeEventListener('production-release-created', refresh)
      window.removeEventListener('service-refresh-requested', refresh)
    }
  }, [announceCompletedBuilds, load, repository])

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
    const confirmed = window.confirm(
      `Merge #${step.pullRequest.number} from ${step.fromBranch} to ${step.toBranch}?`,
    )
    if (!confirmed) return
    setBusyRoute(step.route)
    setError('')
    try {
      await api.mergePromotionPullRequest({
        repository,
        pullNumber: step.pullRequest.number,
      })
      await load(true)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not merge the PR.',
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

      <section className="operation-section">
        <div className="operation-heading">
          <div>
            <p className="eyebrow">GitHub Actions</p>
            <h3>Staging releases</h3>
          </div>
          <div className="operation-heading-actions">
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
        {state?.deploymentLookupFailed && (
          <p className="deployment-lookup-note">
            Jenkins deployment status is temporarily unavailable.
          </p>
        )}

        {loading && !state ? (
          <div className="operation-loading">
            <span className="spinner" /> Loading release builds…
          </div>
        ) : state?.stagingReleases.length ? (
          <div className="release-build-list">
            {state.stagingReleases.map((release) => {
              const liveDeployments = state.deployedTags.filter(
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
                          className="live-deployment"
                          href={deployment.buildUrl || undefined}
                          target="_blank"
                          rel="noreferrer"
                          title={`${deployment.service} · Jenkins build #${deployment.buildNumber}`}
                          key={`${deployment.service}-${deployment.environment}`}
                        >
                          <span aria-hidden="true">●</span> Live in{' '}
                          {deployment.environment.toUpperCase()}
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
                    state.jenkinsServices.length === 0
                  }
                  title={
                    state.jenkinsServices.length === 0
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
        ) : (
          <div className="operation-empty">
            No staging releases found for this service.
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
            <span className="auto-refresh">Live · 15s</span>
          </div>

          {loading && !state ? (
            <div className="operation-loading">
              <span className="spinner" /> Loading production builds…
            </div>
          ) : state?.productionReleases.length ? (
            <div className="release-build-list">
              {state.productionReleases.map((release) => (
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
                  </div>
                  <span className={`build-status ${release.buildStatus}`}>
                    {buildLabels[release.buildStatus]}
                  </span>
                  <button
                    className="production-deploy-button"
                    type="button"
                    disabled={
                      release.buildStatus !== 'succeeded' ||
                      state.jenkinsServices.length === 0
                    }
                    title={
                      state.jenkinsServices.length === 0
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
              ))}
            </div>
          ) : (
            <div className="operation-empty">
              No production releases found for this service.
            </div>
          )}
        </section>
      )}

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

        {state?.pendingBackMerges.length ? (
          <div className="back-merge-warning">
            <strong>Pending back-merge detected</strong>
            <span>Resolve before promoting or merging:</span>
            {state.pendingBackMerges.map((pull) => (
              <a href={pull.url} target="_blank" rel="noreferrer" key={pull.number}>
                #{pull.number} {pull.fromBranch} → {pull.toBranch}
              </a>
            ))}
          </div>
        ) : null}

        <div className="journey-track">
          {state?.promotionSteps.map((step, index) => {
            const blockReason = mergeBlockReason(
              step,
              state.pendingBackMerges.length > 0,
            )
            return (
              <article className="journey-step" key={step.route}>
                <div className="journey-branches">
                  <span className="branch-node">{step.fromBranch}</span>
                  <span className="branch-arrow">
                    <small>{step.commitsAhead} commits</small>→
                  </span>
                  <span className="branch-node">{step.toBranch}</span>
                </div>

                {step.state === 'up_to_date' && (
                  <div className="journey-state complete">
                    <span>✓</span>
                    <div>
                      <strong>Up to date</strong>
                      <small>No changes waiting to promote</small>
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
                    <button
                      className="journey-action"
                      type="button"
                      disabled={busyRoute === step.route}
                      onClick={() => void createPull(step)}
                    >
                      {busyRoute === step.route ? 'Creating…' : 'Create PR'}
                    </button>
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
                        {step.pullRequest.reviewDecision.replaceAll('_', ' ')} ·{' '}
                        checks {step.pullRequest.checks}
                      </small>
                      {blockReason && (
                        <small className="merge-block">{blockReason}</small>
                      )}
                    </div>
                    <button
                      className="journey-action merge"
                      type="button"
                      disabled={Boolean(blockReason) || busyRoute === step.route}
                      onClick={() => void mergePull(step)}
                    >
                      {busyRoute === step.route
                        ? 'Merging…'
                        : `Merge to ${step.toBranch}`}
                    </button>
                  </div>
                )}

                {index === 0 && <div className="journey-divider" />}
              </article>
            )
          })}
        </div>
      </section>
      {deployRelease && state && (
        <DeployDialog
          repository={repository}
          release={deployRelease}
          services={state.jenkinsServices}
          onClose={() => setDeployRelease(undefined)}
        />
      )}
      {productionDeployRelease && state && (
        <ProductionDeployDialog
          repository={repository}
          services={state.jenkinsServices}
          sourceTag={productionDeployRelease.tag}
          onClose={() => setProductionDeployRelease(undefined)}
        />
      )}
    </div>
  )
}

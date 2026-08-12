import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../shared/api'
import type {
  EitriBuild,
  EitriBuildStage,
  EitriBuildsResult,
} from '../../shared/types'
import { EitriDialog } from './EitriDialog'
import { EitriReplayDialog } from './EitriReplayDialog'

type Props = {
  repository: string
  onRefreshingChange?: (refreshing: boolean) => void
  refreshToken?: number
}

const statusLabels: Record<EitriBuild['status'], string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
}

const BUILD_POLL_INTERVAL_MS = 15_000
const RUNNING_POLL_INTERVAL_MS = 5_000
const BUILD_POLL_TIMEOUT_MS = 30_000
const NOTIFICATION_KEY = 'release-build-notifications'

function formatStageDuration(durationMillis?: number) {
  if (durationMillis == null || durationMillis < 0) return undefined
  const seconds = Math.round(durationMillis / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
}

function stageTitle(stage: EitriBuildStage) {
  const duration = formatStageDuration(stage.durationMillis)
  return duration ? `${stage.name} · ${duration}` : stage.name
}

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

function buildSourceLabel(build: EitriBuild) {
  if (build.commitSha) return build.commitSha.slice(0, 7)
  if (build.branch) return build.branch
  return `deploy/${build.namespace}`
}

export function EitriOperations({
  repository,
  onRefreshingChange,
  refreshToken = 0,
}: Props) {
  const [state, setState] = useState<EitriBuildsResult>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [replayBuild, setReplayBuild] = useState<EitriBuild>()
  const [browserNotifications, setBrowserNotifications] = useState(
    () =>
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      window.localStorage.getItem(NOTIFICATION_KEY) === 'true',
  )
  const [notificationToast, setNotificationToast] = useState<{
    message: string
    status?: EitriBuild['status']
  }>()
  const previousBuilds = useRef(new Map<number, EitriBuild['status']>())
  const buildsInitialized = useRef(false)
  const browserNotificationsRef = useRef(browserNotifications)
  const loadSequence = useRef(0)
  const stateRef = useRef(state)

  useEffect(() => {
    browserNotificationsRef.current = browserNotifications
  }, [browserNotifications])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const announceCompletedBuilds = useCallback(
    (nextState: EitriBuildsResult) => {
      const nextBuilds = new Map(
        nextState.builds.map((build) => [build.buildNumber, build.status]),
      )
      if (!buildsInitialized.current) {
        previousBuilds.current = nextBuilds
        buildsInitialized.current = true
        return
      }
      const completed = nextState.builds.filter((build) => {
        const previous = previousBuilds.current.get(build.buildNumber)
        return (
          ['succeeded', 'failed', 'canceled'].includes(build.status) &&
          previous !== build.status
        )
      })
      previousBuilds.current = nextBuilds
      if (completed.length === 0) return

      const latest = completed[0]
      const statusLabel = statusLabels[latest.status]
      const message =
        completed.length === 1
          ? `${latest.service} · ${latest.namespace.toUpperCase()} ${statusLabel.toLowerCase()}`
          : `${completed.length} EITRI builds completed`
      setNotificationToast({ message, status: latest.status })
      if (
        browserNotificationsRef.current &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        new Notification(`EITRI build ${statusLabel}`, {
          body: `${repository.split('/').at(-1)} · ${message}`,
          tag: `eitri-build-${repository}-${latest.buildNumber}`,
        })
      }
    },
    [repository],
  )

  const load = useCallback(
    async (silent = false, forceRefresh = false) => {
      const sequence = ++loadSequence.current
      if (!silent) {
        setLoading(true)
        onRefreshingChange?.(true)
      }
      setError('')
      try {
        const nextState = await api.eitriBuilds(repository, forceRefresh)
        if (sequence !== loadSequence.current) return
        announceCompletedBuilds(nextState)
        setState(nextState)
      } catch (reason) {
        if (sequence !== loadSequence.current) return
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not load Jenkins EITRI builds.',
        )
      } finally {
        if (sequence === loadSequence.current) {
          if (!silent) setLoading(false)
          onRefreshingChange?.(false)
        }
      }
    },
    [announceCompletedBuilds, onRefreshingChange, repository],
  )

  useEffect(() => {
    buildsInitialized.current = false
    previousBuilds.current = new Map()
    void load()
  }, [load, repository])

  useEffect(() => {
    if (refreshToken === 0) return
    void load(false, true)
  }, [load, refreshToken])

  useEffect(() => {
    let active = true
    let inFlight = false
    let timeout: number | undefined

    const schedule = (hasRunning = false) => {
      if (!active || document.hidden) return
      timeout = window.setTimeout(
        () => void poll(),
        hasRunning ? RUNNING_POLL_INTERVAL_MS : BUILD_POLL_INTERVAL_MS,
      )
    }

    const poll = async () => {
      if (!active || inFlight || document.hidden) return
      inFlight = true
      let hasRunning = Boolean(
        stateRef.current?.builds.some((build) => build.status === 'running'),
      )
      try {
        const nextState = await withTimeout(
          api.eitriBuilds(repository, true),
          BUILD_POLL_TIMEOUT_MS,
        )
        if (!active) return
        announceCompletedBuilds(nextState)
        setState(nextState)
        setError('')
        hasRunning = nextState.builds.some((build) => build.status === 'running')
      } catch {
        // Keep the last good snapshot; try again on the next tick.
      } finally {
        inFlight = false
        schedule(hasRunning)
      }
    }

    const onVisibility = () => {
      if (!document.hidden) void poll()
    }

    schedule(
      Boolean(
        stateRef.current?.builds.some((build) => build.status === 'running'),
      ),
    )
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      if (timeout) window.clearTimeout(timeout)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [announceCompletedBuilds, repository])

  useEffect(() => {
    if (!notificationToast) return
    const timeout = window.setTimeout(
      () => setNotificationToast(undefined),
      6_000,
    )
    return () => window.clearTimeout(timeout)
  }, [notificationToast])

  async function toggleBrowserNotifications() {
    if (typeof Notification === 'undefined') {
      setError('Browser notifications are not supported in this browser.')
      return
    }
    if (browserNotifications) {
      window.localStorage.setItem(NOTIFICATION_KEY, 'false')
      setBrowserNotifications(false)
      return
    }
    const permission =
      Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission()
    if (permission !== 'granted') {
      setError('Notification permission was not granted.')
      return
    }
    window.localStorage.setItem(NOTIFICATION_KEY, 'true')
    setBrowserNotifications(true)
  }

  return (
    <>
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
            <strong>EITRI build update</strong>
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
            <p className="eyebrow">Jenkins EITRI</p>
            <h3>Staging build & deploy</h3>
          </div>
          <div className="operation-heading-actions">
            <button
              className="create-release-button"
              type="button"
              onClick={() => setDialogOpen(true)}
              disabled={!state?.jenkinsServices.length}
              title={
                state && state.jenkinsServices.length === 0
                  ? 'No Jenkins service mapping for this repository'
                  : 'Build and deploy with Stag EITRI'
              }
            >
              <span aria-hidden="true">＋</span> Build & deploy
            </button>
            <button
              className={`notification-toggle ${browserNotifications ? 'active' : ''}`}
              type="button"
              aria-pressed={browserNotifications}
              onClick={() => void toggleBrowserNotifications()}
            >
              {browserNotifications ? '● Alerts on' : 'Enable alerts'}
            </button>
            <span className="auto-refresh">
              Live ·{' '}
              {state?.builds.some((build) => build.status === 'running')
                ? '5s'
                : '15s'}
            </span>
          </div>
        </div>

        {state?.lookupFailed && (
          <p className="deployment-lookup-note">
            Jenkins EITRI status is temporarily unavailable.
          </p>
        )}

        {loading && !state ? (
          <div className="operation-loading">
            <span className="spinner" /> Loading EITRI builds…
          </div>
        ) : state?.builds.length ? (
          <div className="release-build-list">
            {state.builds.map((build) => (
              <article className="eitri-build-row" key={build.buildNumber}>
                <div className="eitri-build-top">
                  <span
                    className={`build-indicator ${build.status}`}
                    aria-hidden="true"
                  />
                  <div className="release-build-main">
                    {build.buildUrl ? (
                      <a
                        href={build.buildUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        #{build.buildNumber} · {build.service}
                      </a>
                    ) : (
                      <strong>
                        #{build.buildNumber} · {build.service}
                      </strong>
                    )}
                    <span>
                      {build.namespace.toUpperCase()} ·{' '}
                      {buildSourceLabel(build)} · {timeAgo(build.createdAt)}
                      {' · '}
                      {build.stagingEnvUpdateJob || 'DEV/DEV Deployer'}
                    </span>
                    {build.status === 'running' &&
                      build.currentStage &&
                      !build.stages?.length && (
                        <span className="eitri-current-stage">
                          <span className="spinner" aria-hidden="true" />
                          {build.currentStage}
                        </span>
                      )}
                  </div>
                  <span className={`build-status ${build.status}`}>
                    {statusLabels[build.status]}
                  </span>
                  <div className="eitri-build-actions">
                    {build.buildUrl ? (
                      <a
                        className="deploy-button eitri-build-link"
                        href={build.buildUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                      </a>
                    ) : (
                      <span className="deploy-button eitri-build-link disabled">
                        Queued
                      </span>
                    )}
                    <button
                      className="eitri-replay-button"
                      type="button"
                      onClick={() => setReplayBuild(build)}
                      title={`Replay #${build.buildNumber} with the same parameters`}
                    >
                      Replay
                    </button>
                  </div>
                </div>
                {build.stages && build.stages.length > 0 && (
                  <div
                    className="eitri-stage-list"
                    aria-label="Pipeline stages"
                  >
                    {build.stages.map((stage) => (
                      <span
                        className={`eitri-stage ${stage.status}`}
                        title={stageTitle(stage)}
                        key={stage.id}
                      >
                        <span aria-hidden="true">●</span>
                        {stage.name}
                        {stage.durationMillis != null &&
                          stage.status !== 'pending' && (
                            <em>{formatStageDuration(stage.durationMillis)}</em>
                          )}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="operation-empty">
            No EITRI builds found for this service yet.
          </div>
        )}
      </section>

      {dialogOpen && state && (
        <EitriDialog
          repository={repository}
          services={state.jenkinsServices}
          onClose={() => setDialogOpen(false)}
          onQueued={() => {
            void load(true, true)
          }}
        />
      )}
      {replayBuild && (
        <EitriReplayDialog
          repository={repository}
          build={replayBuild}
          onClose={() => setReplayBuild(undefined)}
          onQueued={() => {
            void load(true, true)
          }}
        />
      )}
    </>
  )
}

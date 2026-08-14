import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../shared/api'
import type {
  BuildStatus,
  DeploymentFreshness,
  JenkinsDeployedTag,
  ServiceRelease,
  TriggeredDeployment,
} from '../../shared/types'
import { DialogBackdrop } from './DialogBackdrop'
import {
  deployableQaTargets,
  effectiveLatestQaTag,
  isMergedToDev,
  latestQaTagAlreadyDeployed,
  latestQaTagDeployInProgress,
  liveQaIsAtLeast,
  pendingQaDeployTargets,
  qaDeployments,
  runningQaDeployments,
  servicesWithQaBuilds,
  servicesWithoutQaBuilds,
} from './deployableQaTargets'
import { LiveDeploymentChips } from './LiveDeploymentChips'

type Props = {
  services: ServiceRelease[]
  freshness: Record<string, DeploymentFreshness>
  releaseName: string
  releaseDate: string
  onClose: () => void
}

type TargetResult =
  | { repository: string; status: 'pending' }
  | {
      repository: string
      status: 'success'
      deployments: TriggeredDeployment[]
    }
  | { repository: string; status: 'error'; message: string }

type StatusKind =
  | 'queued'
  | 'error'
  | 'pending'
  | 'running'
  | 'deployed'
  | 'building'
  | 'failed'
  | 'ready'
  | 'muted'

type ServiceRow = {
  repository: string
  latestTag?: string
  liveTags: string[]
  running: JenkinsDeployedTag[]
  buildingTag?: string
  status: { text: string; kind: StatusKind }
}

const MAX_CONCURRENCY = 3
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 30_000

function serviceName(repository: string) {
  return repository.split('/').at(-1) ?? repository
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
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

function liveQaTags(deployedTags: JenkinsDeployedTag[]) {
  return [
    ...new Set(
      qaDeployments(deployedTags)
        .filter(
          (deployment) =>
            deployment.status === undefined || deployment.status === 'succeeded',
        )
        .map((deployment) => deployment.tag),
    ),
  ]
}

function githubTagUrl(repository: string, tag: string) {
  return `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`
}

function qaBuildFailed(status?: BuildStatus) {
  return status === 'failed' || status === 'canceled'
}

export function BulkQaDeployDialog({
  services,
  freshness,
  releaseName,
  releaseDate,
  onClose,
}: Props) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(releaseDate) ? releaseDate : ''
  const repositories = useMemo(
    () => services.map((service) => service.repository),
    [services],
  )
  const targets = useMemo(
    () => deployableQaTargets(services, freshness),
    [freshness, services],
  )
  const withBuilds = useMemo(
    () => servicesWithQaBuilds(services, freshness),
    [freshness, services],
  )
  const withoutBuilds = useMemo(
    () => servicesWithoutQaBuilds(services, freshness),
    [freshness, services],
  )
  const [deploying, setDeploying] = useState(false)
  const [started, setStarted] = useState(false)
  const [results, setResults] = useState<TargetResult[]>([])
  const [deploymentsByRepository, setDeploymentsByRepository] = useState<
    Record<string, JenkinsDeployedTag[]>
  >({})
  const [statusLoading, setStatusLoading] = useState(repositories.length > 0)
  const [latestTags, setLatestTags] = useState<Record<string, string[]>>({})
  const [buildStatuses, setBuildStatuses] = useState<
    Record<string, { tag: string; status: BuildStatus }>
  >({})
  const [reload, setReload] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const latestTagsRef = useRef(latestTags)
  latestTagsRef.current = latestTags

  const pendingTargets = useMemo(() => {
    const resolved = targets.map((target) => {
      const deployedTags = deploymentsByRepository[target.repository]
      const liveTags = deployedTags
        ? liveQaTags(deployedTags)
        : (freshness[target.repository]?.liveQaTags ?? [])
      const tag =
        effectiveLatestQaTag(
          target.tag,
          latestTags[target.repository],
          liveTags,
        ) ?? target.tag
      return { ...target, tag }
    })
    return pendingQaDeployTargets(
      resolved,
      freshness,
      deploymentsByRepository,
    ).filter(
      (target) => !qaBuildFailed(buildStatuses[target.repository]?.status),
    )
  }, [
    buildStatuses,
    deploymentsByRepository,
    freshness,
    latestTags,
    targets,
  ])

  useEffect(() => {
    if (repositories.length === 0) return
    let active = true
    api
      .listStagingTags({
        repositories,
        environment: 'qa',
        date: date || new Date().toISOString().slice(0, 10),
      })
      .then(async (items) => {
        if (!active) return
        const next: Record<string, string[]> = {}
        for (const item of items) next[item.repository] = item.tags
        latestTagsRef.current = next
        setLatestTags(next)
        const tagInputs = repositories.flatMap((repository) => {
          const tag = next[repository]?.at(-1)
          if (!tag) return []
          return [
            {
              repository,
              tag,
              createdAt: `${date || '1970-01-01'}T00:00:00Z`,
            },
          ]
        })
        if (tagInputs.length === 0) return
        const builds = await withTimeout(
          api.releaseBuildStatuses(tagInputs, true),
          POLL_TIMEOUT_MS,
        )
        if (active) {
          setBuildStatuses(
            Object.fromEntries(
              builds.map((result) => [
                result.repository,
                { tag: result.tag, status: result.buildStatus },
              ]),
            ),
          )
        }
      })
      .catch(() => {
        if (active) setLatestTags({})
      })
    return () => {
      active = false
    }
  }, [date, reload, repositories])

  useEffect(() => {
    if (repositories.length === 0) {
      setStatusLoading(false)
      return
    }

    let active = true
    let inFlight = false
    let timeout: number | undefined

    const schedule = () => {
      if (!active || document.hidden) return
      timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
    }

    const poll = async () => {
      if (!active || inFlight || document.hidden) return
      inFlight = true
      try {
        const deploymentResult = await withTimeout(
          api.repositoryDeploymentStatuses(repositories, true),
          POLL_TIMEOUT_MS,
        )
        if (!active) return
        setDeploymentsByRepository(
          Object.fromEntries(
            deploymentResult.results.map((result) => [
              result.repository,
              result.deployedTags,
            ]),
          ),
        )

        const tagInputs = repositories.flatMap((repository) => {
          const tag = latestTagsRef.current[repository]?.at(-1)
          if (!tag) return []
          return [
            {
              repository,
              tag,
              createdAt: `${date || '1970-01-01'}T00:00:00Z`,
            },
          ]
        })
        if (tagInputs.length > 0) {
          const builds = await withTimeout(
            api.releaseBuildStatuses(tagInputs, true),
            POLL_TIMEOUT_MS,
          )
          if (!active) return
          setBuildStatuses(
            Object.fromEntries(
              builds.map((result) => [
                result.repository,
                { tag: result.tag, status: result.buildStatus },
              ]),
            ),
          )
        }
      } catch {
        // Keep the last snapshot; the next poll retries.
      } finally {
        if (active) {
          setStatusLoading(false)
          setRefreshing(false)
        }
        inFlight = false
        schedule()
      }
    }

    const visibilityChanged = () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
      timeout = undefined
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    void poll()
    return () => {
      active = false
      if (timeout !== undefined) window.clearTimeout(timeout)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [date, reload, repositories])

  const successCount = results.filter(
    (result) => result.status === 'success',
  ).length
  const errorCount = results.filter((result) => result.status === 'error').length
  const finished = started && !deploying

  function refreshNow() {
    if (deploying || refreshing || repositories.length === 0) return
    setRefreshing(true)
    setStatusLoading(true)
    setReload((current) => current + 1)
  }

  async function deployAll() {
    if (deploying || pendingTargets.length === 0) return
    setDeploying(true)
    setStarted(true)
    setResults(
      pendingTargets.map((target) => ({
        repository: target.repository,
        status: 'pending',
      })),
    )

    await mapConcurrent(pendingTargets, async (target) => {
      try {
        const deployments: TriggeredDeployment[] = []
        for (const jenkinsService of target.jenkinsServices) {
          const queued = await api.triggerDeployment({
            repository: target.repository,
            service: jenkinsService,
            tag: target.tag,
            environment: 'qa',
          })
          deployments.push(queued)
        }
        setDeploymentsByRepository((current) => {
          const existing = current[target.repository] ?? []
          const optimistic = deployments.map((deployment) => ({
            service: deployment.service,
            tag: deployment.tag,
            environment: deployment.environment,
            status: 'running' as const,
            buildNumber: 0,
            buildUrl: deployment.buildUrl ?? deployment.queueUrl,
            deployedAt: new Date().toISOString(),
            jobName: deployment.jobName,
          }))
          const kept = existing.filter(
            (deployment) =>
              !(
                deployment.environment === 'qa' &&
                deployment.status === 'running' &&
                deployments.some((item) => item.service === deployment.service)
              ),
          )
          return {
            ...current,
            [target.repository]: [...optimistic, ...kept],
          }
        })
        setResults((current) =>
          current.map((result) =>
            result.repository === target.repository
              ? { repository: target.repository, status: 'success', deployments }
              : result,
          ),
        )
      } catch (reason) {
        setResults((current) =>
          current.map((result) =>
            result.repository === target.repository
              ? {
                  repository: target.repository,
                  status: 'error',
                  message:
                    reason instanceof Error
                      ? reason.message
                      : 'Could not queue the QA deployment.',
                }
              : result,
          ),
        )
      }
    })

    setDeploying(false)
  }

  function statusLabel(
    repository: string,
    latestTag: string | undefined,
    jenkinsServices: string[],
  ) {
    const result = results.find((item) => item.repository === repository)
    if (result?.status === 'success') {
      return {
        text: `${result.deployments.length} queued`,
        kind: 'queued' as const,
      }
    }
    if (result?.status === 'error') {
      return { text: result.message, kind: 'error' as const }
    }
    if (result?.status === 'pending' && deploying) {
      return { text: 'Queuing…', kind: 'pending' as const }
    }

    const deployedTags = deploymentsByRepository[repository]
    const info = freshness[repository]
    const build = buildStatuses[repository]
    const building =
      build &&
      (build.status === 'starting' || build.status === 'running')
        ? build.tag
        : undefined

    if (deployedTags) {
      if (
        latestTag &&
        latestQaTagDeployInProgress(latestTag, deployedTags)
      ) {
        return { text: 'Deploying', kind: 'running' as const }
      }
      if (
        latestTag &&
        latestQaTagAlreadyDeployed(latestTag, jenkinsServices, deployedTags)
      ) {
        return { text: 'Live', kind: 'deployed' as const }
      }
    } else if (
      latestTag &&
      info &&
      !info.checkFailed &&
      liveQaIsAtLeast(latestTag, info.liveQaTags)
    ) {
      return { text: 'Live', kind: 'deployed' as const }
    }

    if (building) {
      return { text: 'Building', kind: 'building' as const }
    }
    if (qaBuildFailed(build?.status)) {
      return {
        text: build?.status === 'canceled' ? 'Canceled' : 'Failed',
        kind: 'failed' as const,
      }
    }
    if (statusLoading) {
      return { text: 'Checking', kind: 'pending' as const }
    }
    const service = services.find((item) => item.repository === repository)
    if (!service || !isMergedToDev(service)) {
      return { text: 'Not merged', kind: 'muted' as const }
    }
    if (jenkinsServices.length === 0) {
      return { text: 'No Jenkins', kind: 'muted' as const }
    }
    if (latestTag) {
      return { text: 'Ready', kind: 'ready' as const }
    }
    return { text: 'No build', kind: 'muted' as const }
  }

  const rows: ServiceRow[] = withBuilds.map((service) => {
    const repository = service.repository
    const info = freshness[repository]
    const jenkinsServices = info?.jenkinsServices ?? []
    const deployedTags = deploymentsByRepository[repository] ?? []
    const qa = qaDeployments(deployedTags)
    const liveTags =
      qa.length > 0 ? liveQaTags(deployedTags) : (info?.liveQaTags ?? [])
    const latestTag = effectiveLatestQaTag(
      info?.latestBuiltQaTag,
      latestTags[repository],
      liveTags,
    )
    const build = buildStatuses[repository]
    return {
      repository,
      latestTag:
        qaBuildFailed(build?.status) && build?.tag
          ? build.tag
          : latestTag,
      liveTags,
      running: runningQaDeployments(deployedTags),
      buildingTag:
        build &&
        (build.status === 'starting' || build.status === 'running') &&
        build.tag !== latestTag
          ? build.tag
          : undefined,
      status: statusLabel(repository, latestTag, jenkinsServices),
    }
  })
  const checkingRows = rows.filter(
    (row) => row.status.kind === 'pending' && !deploying,
  )
  const readyRows = rows.filter(
    (row) =>
      row.status.kind === 'ready' ||
      row.status.kind === 'queued' ||
      row.status.kind === 'error' ||
      (row.status.kind === 'pending' && deploying),
  )
  const activeRows = rows.filter((row) =>
    ['running', 'building'].includes(row.status.kind),
  )
  const liveRows = rows.filter((row) => row.status.kind === 'deployed')
  const failedRows = rows.filter((row) => row.status.kind === 'failed')
  const otherRows = rows.filter((row) => row.status.kind === 'muted')

  function renderRows(items: ServiceRow[], label: string) {
    if (items.length === 0) return null
    return (
      <div className="bulk-qa-deploy-group">
        <p className="bulk-qa-section-label">
          {label} ({items.length})
        </p>
        <ul className="bulk-qa-service-list" aria-label={label}>
          {items.map((row) => {
            const liveMismatch =
              row.latestTag &&
              row.liveTags.length > 0 &&
              !row.liveTags.includes(row.latestTag)
            return (
              <li
                key={row.repository}
                className={`bulk-qa-${row.status.kind}`}
              >
                <strong>{serviceName(row.repository)}</strong>
                {row.latestTag ? (
                  <a
                    href={githubTagUrl(row.repository, row.latestTag)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {row.latestTag}
                  </a>
                ) : (
                  <span className="bulk-qa-tag-placeholder">—</span>
                )}
                <span
                  className={`bulk-qa-status ${row.status.kind}`}
                  title={
                    row.status.kind === 'error' ? row.status.text : undefined
                  }
                >
                  {row.status.text}
                </span>
                {liveMismatch && (
                  <small className="bulk-qa-deploy-detail">
                    QA is on {row.liveTags.join(', ')}
                  </small>
                )}
                {row.buildingTag && (
                  <small className="bulk-qa-deploy-detail">
                    Newer build {row.buildingTag}
                  </small>
                )}
                {row.running.length > 0 && (
                  <LiveDeploymentChips deployments={row.running} />
                )}
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  return (
    <DialogBackdrop onMouseDown={onClose}>
      <section
        className="release-dialog bulk-qa-release-dialog bulk-qa-deploy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-qa-deploy-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="dialog-close"
          type="button"
          onClick={onClose}
          aria-label="Close"
          disabled={deploying}
        >
          ×
        </button>

        <div className="bulk-qa-deploy-heading">
          <div>
            <p className="eyebrow">QA deploy · {releaseName}</p>
            <h2 id="bulk-qa-deploy-title">
              {finished
                ? `Queued ${successCount}/${results.length} QA deploys`
                : 'Deploy QA for merged services'}
            </h2>
          </div>
          <button
            className="notification-toggle"
            type="button"
            onClick={refreshNow}
            disabled={deploying || refreshing}
            aria-label="Refresh QA status"
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
        <p className="dialog-copy">
          {finished
            ? errorCount > 0
              ? `${errorCount} service(s) failed. Review the list below.`
              : 'Jenkins QA deployments were queued for every eligible service.'
            : pendingTargets.length > 0
              ? `${pendingTargets.length} service${pendingTargets.length === 1 ? ' is' : 's are'} behind the latest QA tag.`
              : failedRows.length > 0
                ? 'Failed QA builds cannot be deployed.'
                : targets.length > 0
                  ? 'Latest QA tags are already live or currently deploying.'
                  : 'No merged services have a successful QA tag ready to deploy.'}
        </p>

        {renderRows(readyRows, 'Ready to deploy')}
        {renderRows(checkingRows, 'Checking status')}
        {renderRows(activeRows, 'In progress')}
        {renderRows(failedRows, 'Build failed')}
        {renderRows(liveRows, 'Already live')}
        {renderRows(otherRows, 'Not eligible')}

        {withoutBuilds.length > 0 && !started && (
          <div className="bulk-qa-deploy-group">
            <p className="bulk-qa-section-label">
              No QA builds yet ({withoutBuilds.length})
            </p>
            <ul
              className="bulk-qa-service-list bulk-qa-no-builds-list"
              aria-label="Services without QA builds"
            >
              {withoutBuilds.map((service) => {
                const repository = service.repository
                const tags = latestTags[repository] ?? []
                const latestTag = tags.at(-1)
                const build = buildStatuses[repository]
                const building =
                  build &&
                  (build.status === 'starting' || build.status === 'running')
                const failed = qaBuildFailed(build?.status)
                return (
                  <li
                    key={repository}
                    className={failed ? 'bulk-qa-failed' : 'bulk-qa-muted'}
                  >
                    <strong>{serviceName(repository)}</strong>
                    {latestTag ? (
                      <a
                        href={githubTagUrl(repository, latestTag)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {latestTag}
                      </a>
                    ) : (
                      <span className="bulk-qa-tag-placeholder">—</span>
                    )}
                    <span
                      className={`bulk-qa-status ${
                        failed ? 'failed' : building ? 'building' : 'muted'
                      }`}
                    >
                      {failed
                        ? build?.status === 'canceled'
                          ? 'Canceled'
                          : 'Failed'
                        : building
                          ? 'Building'
                          : statusLoading
                            ? 'Checking'
                            : 'No build'}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={onClose}
            disabled={deploying}
          >
            {finished ? 'Close' : 'Cancel'}
          </button>
          {!finished && (
            <button
              className="primary-button"
              type="button"
              onClick={() => void deployAll()}
              disabled={deploying || pendingTargets.length === 0}
            >
              {deploying
                ? 'Queuing QA deploys…'
                : pendingTargets.length > 0
                  ? `Deploy to QA (${pendingTargets.length})`
                  : failedRows.length > 0 || activeRows.length > 0
                    ? 'No QA deploys ready'
                    : targets.length > 0
                      ? 'All services already live'
                      : 'No QA deploys ready'}
            </button>
          )}
        </div>
      </section>
    </DialogBackdrop>
  )
}

import { useMemo, useState } from 'react'
import { api } from '../../shared/api'
import type {
  DeploymentFreshness,
  ServiceRelease,
  TriggeredDeployment,
} from '../../shared/types'
import { deployableQaTargets, isMergedToDev } from './deployableQaTargets'

type Props = {
  services: ServiceRelease[]
  freshness: Record<string, DeploymentFreshness>
  releaseName: string
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

const MAX_CONCURRENCY = 3

function serviceName(repository: string) {
  return repository.split('/').at(-1) ?? repository
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

export function BulkQaDeployDialog({
  services,
  freshness,
  releaseName,
  onClose,
}: Props) {
  const targets = useMemo(
    () => deployableQaTargets(services, freshness),
    [freshness, services],
  )
  const skipped = useMemo(() => {
    return services.filter((service) => {
      if (!isMergedToDev(service)) return false
      return !targets.some(
        (target) => target.repository === service.repository,
      )
    })
  }, [services, targets])
  const [deploying, setDeploying] = useState(false)
  const [started, setStarted] = useState(false)
  const [results, setResults] = useState<TargetResult[]>(() =>
    targets.map((target) => ({
      repository: target.repository,
      status: 'pending',
    })),
  )

  const successCount = results.filter(
    (result) => result.status === 'success',
  ).length
  const errorCount = results.filter((result) => result.status === 'error').length
  const finished = started && !deploying

  async function deployAll() {
    if (deploying || targets.length === 0) return
    setDeploying(true)
    setStarted(true)
    setResults(
      targets.map((target) => ({
        repository: target.repository,
        status: 'pending',
      })),
    )

    await mapConcurrent(targets, async (target) => {
      try {
        const deployments: TriggeredDeployment[] = []
        for (const jenkinsService of target.jenkinsServices) {
          deployments.push(
            await api.triggerDeployment({
              repository: target.repository,
              service: jenkinsService,
              tag: target.tag,
              environment: 'qa',
            }),
          )
        }
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

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="release-dialog bulk-qa-release-dialog"
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

        <p className="eyebrow">QA deploy · {releaseName}</p>
        <h2 id="bulk-qa-deploy-title">
          {finished
            ? `Queued ${successCount}/${targets.length} QA deploys`
            : 'Deploy QA for merged services'}
        </h2>
        <p className="dialog-copy">
          {finished
            ? errorCount > 0
              ? `${errorCount} service(s) failed. Review the list below.`
              : 'Jenkins QA deployments were queued for every eligible service.'
            : `Queue QA deployments for release services whose PRs are all merged to dev and have a successful QA tag (${targets.length} ready).`}
        </p>

        {skipped.length > 0 && !started && (
          <div className="alert warning">
            <strong>{skipped.length} merged service(s) skipped.</strong> Missing
            a successful QA tag or Jenkins service mapping.
          </div>
        )}

        <ul className="bulk-qa-service-list" aria-label="QA deploy targets">
          {(started ? results : targets).map((item) => {
            const repository = item.repository
            const target = targets.find(
              (entry) => entry.repository === repository,
            )
            const result = started
              ? (item as TargetResult)
              : ({ repository, status: 'pending' } as TargetResult)
            return (
              <li key={repository} className={`bulk-qa-${result.status}`}>
                <div>
                  <strong>{serviceName(repository)}</strong>
                  <small>
                    {target
                      ? `${target.tag} · ${target.jenkinsServices.join(', ')}`
                      : repository}
                  </small>
                </div>
                {result.status === 'pending' && (
                  <span>{deploying ? 'Queuing…' : 'Ready'}</span>
                )}
                {result.status === 'success' && (
                  <span>
                    {result.deployments.length} job
                    {result.deployments.length === 1 ? '' : 's'} queued
                  </span>
                )}
                {result.status === 'error' && (
                  <span title={result.message}>{result.message}</span>
                )}
              </li>
            )
          })}
        </ul>

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
              disabled={deploying || targets.length === 0}
            >
              {deploying
                ? 'Queuing QA deploys…'
                : `Deploy to QA (${targets.length})`}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

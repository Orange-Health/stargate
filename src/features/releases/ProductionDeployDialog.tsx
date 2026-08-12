import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../../shared/api'
import { usesFrontendProductionTag } from '../../shared/productionRepositories'
import type {
  JenkinsDeployedTag,
  TriggeredProductionDeployment,
} from '../../shared/types'
import {
  CopyableDeployedTag,
} from './CopyableDeployedTag'
import { DialogBackdrop } from './DialogBackdrop'
import { liveProductionTags } from './liveProductionTags'
import { productionTagForFormat } from './productionTags'

type Props = {
  repository: string
  services: string[]
  sourceTag?: string
  deployedTags?: JenkinsDeployedTag[]
  onDeploymentUpdated?: (deployment: TriggeredProductionDeployment) => void
  onClose: () => void
}

export function ProductionDeployDialog({
  repository,
  services,
  sourceTag = '',
  deployedTags = [],
  onDeploymentUpdated,
  onClose,
}: Props) {
  const [service, setService] = useState(services[0] ?? '')
  const [frontendTag, setFrontendTag] = useState(() =>
    usesFrontendProductionTag(repository),
  )
  const [imageTag, setImageTag] = useState(() =>
    productionTagForFormat(sourceTag, frontendTag),
  )
  const [qaApprovalRequired, setQaApprovalRequired] = useState(false)
  const [qaName, setQaName] = useState('')
  const [skipProdMigration, setSkipProdMigration] = useState(false)
  const [prodMigrationJob, setProdMigrationJob] = useState(
    'Prod Deployments/Prod-cluster-migration',
  )
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState('')
  const [deployment, setDeployment] =
    useState<TriggeredProductionDeployment>()

  useEffect(() => {
    if (!deployment || deployment.buildUrl) return
    let active = true
    let timeout: number | undefined
    async function pollQueue() {
      if (!deployment || !active) return
      try {
        const status = await api.productionJenkinsQueueStatus(
          deployment.queueId,
        )
        if (!active) return
        if (status.status === 'started' && status.buildUrl) {
          setDeployment((current) => {
            if (!current) return current
            const updated = {
              ...current,
              buildUrl: status.buildUrl,
              buildNumber: status.buildNumber,
            }
            onDeploymentUpdated?.(updated)
            return updated
          })
          return
        }
        if (status.status === 'canceled') {
          setError(status.message ?? 'The production deployment was canceled.')
          return
        }
      } catch (reason) {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'Could not resolve the production Jenkins build URL.',
          )
        }
      }
      if (active) timeout = window.setTimeout(pollQueue, 1_500)
    }
    void pollQueue()
    return () => {
      active = false
      if (timeout) window.clearTimeout(timeout)
    }
  }, [deployment, onDeploymentUpdated])

  function changeTagFormat(frontend: boolean) {
    setFrontendTag(frontend)
    setImageTag(productionTagForFormat(sourceTag, frontend))
  }

  function changeService(nextService: string) {
    setService(nextService)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setDeploying(true)
    setError('')
    try {
      const result = await api.triggerProductionDeployment({
        repository,
        service,
        imageTag,
        qaApprovalRequired,
        qaName: qaApprovalRequired ? qaName : undefined,
        skipProdMigration,
        prodMigrationJob,
      })
      setDeployment(result)
      onDeploymentUpdated?.(result)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not trigger the production deployment.',
      )
    } finally {
      setDeploying(false)
    }
  }

  return (
    <DialogBackdrop onMouseDown={onClose}>
      <section
        className="release-dialog deploy-dialog production-deploy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="production-deploy-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="dialog-close"
          type="button"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
        {deployment ? (
          <div className="release-created">
            <span className="created-icon deploy" aria-hidden="true">
              ↗
            </span>
            <p className="eyebrow">Production Jenkins build queued</p>
            <h2 id="production-deploy-title">Production deployment</h2>
            <p>
              <code>{deployment.service}</code> will deploy{' '}
              <code>{deployment.imageTag}</code>.
            </p>
            {deployment.buildUrl ? (
              <a
                className="primary-button release-link"
                href={deployment.buildUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Jenkins build <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <div className="jenkins-queue-wait">
                <span className="spinner" />
                Waiting for Jenkins to assign a build number…
              </div>
            )}
            {error && (
              <div className="alert error deployment-error" role="alert">
                {error}
              </div>
            )}
            <button className="text-button done-button" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <p className="eyebrow">Production · Pitstop Jenkins</p>
            <h2 id="production-deploy-title">Deploy to production</h2>
            <p className="dialog-copy">
              The release and default branches are identical. Verify the
              production image tag before deploying.
            </p>
            <form onSubmit={submit}>
              <label>
                Jenkins service
                <select
                  value={service}
                  onChange={(event) => changeService(event.target.value)}
                  required
                >
                  {services.map((item) => (
                    <option value={item} key={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="production-image-tag">
                Image tag
                <input
                  id="production-image-tag"
                  aria-label="Image tag"
                  value={imageTag}
                  disabled
                  aria-describedby="production-tag-help"
                />
                <small id="production-tag-help">
                  This tag is fixed by the selected GitHub production release.
                </small>
              </label>
              <label className="deployment-checkbox">
                <input
                  type="checkbox"
                  checked={frontendTag}
                  onChange={(event) => changeTagFormat(event.target.checked)}
                />
                Use frontend tag format (<code>v-prod-*</code>)
              </label>
              <label className="deployment-checkbox">
                <input
                  type="checkbox"
                  checked={qaApprovalRequired}
                  onChange={(event) =>
                    setQaApprovalRequired(event.target.checked)
                  }
                />
                Require QA approval
              </label>
              {qaApprovalRequired && (
                <label>
                  QA name
                  <input
                    value={qaName}
                    onChange={(event) => setQaName(event.target.value)}
                    required
                  />
                </label>
              )}
              <label className="deployment-checkbox">
                <input
                  type="checkbox"
                  checked={skipProdMigration}
                  onChange={(event) =>
                    setSkipProdMigration(event.target.checked)
                  }
                />
                Skip production migration
              </label>
              <label>
                Production migration job
                <input
                  value={prodMigrationJob}
                  onChange={(event) => setProdMigrationJob(event.target.value)}
                  required
                />
              </label>
              <div className="deployment-summary">
                <span>Job</span>
                <code>Prod Deployments/Prod-cluster-deployment</code>
                <small>
                  Jenkins will receive the service, image tag, QA approval, and
                  migration parameters shown above.
                </small>
              </div>
              {error && (
                <div className="alert error" role="alert">
                  {error}
                </div>
              )}
              <div className="production-deploy-submit">
                {liveProductionTags(deployedTags, service).map((tag) => (
                  <CopyableDeployedTag key={tag} tag={tag} />
                ))}
                <div className="dialog-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={onClose}
                  >
                    Cancel
                  </button>
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={
                      deploying ||
                      !service ||
                      !imageTag ||
                      (qaApprovalRequired && !qaName.trim())
                    }
                  >
                    {deploying ? 'Queuing production…' : 'Deploy production'}
                  </button>
                </div>
              </div>
            </form>
          </>
        )}
      </section>
    </DialogBackdrop>
  )
}

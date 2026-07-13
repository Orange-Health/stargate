import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../../shared/api'
import type {
  DeploymentEnvironment,
  TrackedStagingRelease,
  TriggeredDeployment,
} from '../../shared/types'

type Props = {
  repository: string
  release: TrackedStagingRelease
  services: string[]
  onClose: () => void
}

const environments: Array<{
  value: DeploymentEnvironment | 's6'
  label: string
  disabled?: boolean
}> = [
  { value: 'qa', label: 'QA' },
  { value: 's1', label: 'S1 · Doctors' },
  { value: 's2', label: 'S2 · D2C CRM' },
  { value: 's3', label: 'S3 · Logistics' },
  { value: 's4', label: 'S4 · Lab' },
  { value: 's5', label: 'S5 · Partnerships' },
  { value: 's6', label: 'S6 · Not configured', disabled: true },
]

export function DeployDialog({
  repository,
  release,
  services,
  onClose,
}: Props) {
  const initialEnvironment =
    release.environment === 's6' ? 'qa' : release.environment
  const [environment, setEnvironment] =
    useState<DeploymentEnvironment>(initialEnvironment)
  const [service, setService] = useState(services[0] ?? '')
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState('')
  const [deployment, setDeployment] = useState<TriggeredDeployment>()

  useEffect(() => {
    if (!deployment || deployment.buildUrl) return
    let active = true
    let timeout: number | undefined

    async function pollQueue() {
      if (!deployment || !active) return
      try {
        const status = await api.jenkinsQueueStatus(deployment.queueId)
        if (!active) return
        if (status.status === 'started' && status.buildUrl) {
          setError('')
          setDeployment((current) =>
            current ? { ...current, buildUrl: status.buildUrl } : current,
          )
          return
        }
        if (status.status === 'canceled') {
          setError(status.message ?? 'The Jenkins deployment was canceled.')
          return
        }
      } catch (reason) {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'Could not resolve the Jenkins build URL.',
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
  }, [deployment])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setDeploying(true)
    setError('')
    try {
      setDeployment(
        await api.triggerDeployment({
          repository,
          service,
          tag: release.tag,
          environment,
        }),
      )
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not trigger the Jenkins deployment.',
      )
    } finally {
      setDeploying(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="release-dialog deploy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deploy-title"
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
            <p className="eyebrow">Jenkins build queued</p>
            <h2 id="deploy-title">{deployment.environment.toUpperCase()}</h2>
            <p>
              <code>{deployment.service}</code> will deploy{' '}
              <code>{deployment.tag}</code> through {deployment.jobName}.
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
            <p className="eyebrow">Successful build · Jenkins</p>
            <h2 id="deploy-title">Deploy release</h2>
            <p className="dialog-copy">
              Choose the target environment for <code>{release.tag}</code>.
            </p>
            <form onSubmit={submit}>
              <label>
                Jenkins service
                <select
                  value={service}
                  onChange={(event) => setService(event.target.value)}
                  required
                >
                  {services.map((item) => (
                    <option value={item} key={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Target environment
                <select
                  value={environment}
                  onChange={(event) =>
                    setEnvironment(
                      event.target.value as DeploymentEnvironment,
                    )
                  }
                >
                  {environments.map((item) => (
                    <option
                      value={item.value}
                      disabled={item.disabled}
                      key={item.value}
                    >
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="deployment-summary">
                <span>Job</span>
                <code>
                  {environment === 'qa'
                    ? 'QA / QA-DEPLOYMENT'
                    : 'DEV / DEV Deployer'}
                </code>
                <small>
                  Production-tag and optional test/migration flags remain off.
                </small>
              </div>
              {error && (
                <div className="alert error" role="alert">
                  {error}
                </div>
              )}
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
                  disabled={deploying || !service}
                >
                  {deploying ? 'Queuing deployment…' : 'Deploy'}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  )
}

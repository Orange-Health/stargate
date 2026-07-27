import { useState, type ClipboardEvent, type FormEvent } from 'react'
import type {
  ConnectionConfig,
  ConnectionStatus,
} from '../../shared/types'
import { ThemeToggle } from '../theme/ThemeToggle'

type Props = {
  onConnect: (config: ConnectionConfig) => Promise<ConnectionStatus>
}

const initialConfig: ConnectionConfig = {
  jiraSite: 'https://orange-health.atlassian.net',
  jiraEmail: '',
  jiraToken: '',
  githubOrg: 'Orange-Health',
  githubToken: '',
  jenkinsUrl: 'https://jenkins.stage.orangehealth.dev',
  jenkinsUsername: '',
  jenkinsToken: '',
  productionJenkins: {
    jenkinsUrl: 'https://pitstop.orangehealth.dev',
    jenkinsUsername: '',
    jenkinsToken: '',
  },
  jiraProject: 'OH',
}

export function ConnectionScreen({ onConnect }: Props) {
  const [config, setConfig] = useState(initialConfig)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [bulkPasteMessage, setBulkPasteMessage] = useState('')

  function update(field: keyof ConnectionConfig, value: string) {
    setConfig((current) => ({ ...current, [field]: value }))
  }

  function updateProductionJenkins(
    field: 'jenkinsUrl' | 'jenkinsUsername' | 'jenkinsToken',
    value: string,
  ) {
    setConfig((current) => ({
      ...current,
      productionJenkins: {
        jenkinsUrl:
          current.productionJenkins?.jenkinsUrl ??
          'https://pitstop.orangehealth.dev',
        jenkinsUsername: current.productionJenkins?.jenkinsUsername ?? '',
        jenkinsToken: current.productionJenkins?.jenkinsToken ?? '',
        [field]: value,
      },
    }))
  }

  function pasteCredentials(event: ClipboardEvent<HTMLInputElement>) {
    const lines = event.clipboardData
      .getData('text')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
    if (lines.length < 7) return

    event.preventDefault()
    const [
      jiraEmail,
      jiraToken,
      githubToken,
      jenkinsUsername,
      jenkinsToken,
      productionUsername,
      productionToken,
    ] = lines
    setConfig((current) => ({
      ...current,
      jiraEmail,
      jiraToken,
      githubToken,
      jenkinsUsername,
      jenkinsToken,
      productionJenkins: {
        jenkinsUrl:
          current.productionJenkins?.jenkinsUrl ??
          'https://pitstop.orangehealth.dev',
        jenkinsUsername: productionUsername,
        jenkinsToken: productionToken,
      },
    }))
    setBulkPasteMessage('All seven credentials were populated.')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const hasProductionCredentials = Boolean(
        config.productionJenkins?.jenkinsUsername ||
          config.productionJenkins?.jenkinsToken,
      )
      await onConnect({
        ...config,
        productionJenkins: hasProductionCredentials
          ? config.productionJenkins
          : undefined,
      })
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not connect services.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="connection-layout">
      <ThemeToggle className="connection-theme-toggle" />
      <section className="connection-intro">
        <div className="brand-mark">RD</div>
        <p className="eyebrow">Release operations</p>
        <h1>One clear view of every release.</h1>
        <p className="intro-copy">
          Bring Jira release scope, GitHub readiness, and Jenkins deployment
          into a single, focused workspace.
        </p>
        <div className="trust-note">
          <span className="trust-icon" aria-hidden="true">
            ◈
          </span>
          Credentials live only in the local process and are cleared when it
          stops.
        </div>
      </section>

      <section className="connection-panel" aria-labelledby="connect-heading">
        <div>
          <p className="step-label">SETUP · 01</p>
          <h2 id="connect-heading">Connect your workspace</h2>
          <p className="muted">
            We’ll verify each configured service before loading release data.
          </p>
        </div>

        <form onSubmit={submit}>
          <fieldset>
            <legend>
              <span className="provider-icon jira">J</span>
              Jira
            </legend>
            <label>
              Site URL
              <input
                type="url"
                value={config.jiraSite}
                onChange={(event) => update('jiraSite', event.target.value)}
                required
              />
            </label>
            <div className="field-row">
              <label>
                Email
                <input
                  type="email"
                  aria-label="Email"
                  value={config.jiraEmail}
                  onChange={(event) => update('jiraEmail', event.target.value)}
                  onPaste={pasteCredentials}
                  placeholder="you@company.com"
                  autoComplete="username"
                  required
                />
                <small className="paste-hint">
                  Paste the 7-line credential bundle here to fill all services.
                </small>
              </label>
              <label>
                Jira API token
                <input
                  type="password"
                  value={config.jiraToken}
                  onChange={(event) => update('jiraToken', event.target.value)}
                  placeholder="••••••••••••"
                  autoComplete="off"
                  required
                />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>
              <span className="provider-icon github">G</span>
              GitHub
            </legend>
            <label>
              Personal access token
              <input
                type="password"
                value={config.githubToken}
                onChange={(event) => update('githubToken', event.target.value)}
                placeholder="github_pat_••••••"
                autoComplete="off"
                required
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>
              <span className="provider-icon jenkins">J</span>
              Jenkins staging
            </legend>
            <label>
              Jenkins URL
              <input
                type="url"
                value={config.jenkinsUrl}
                onChange={(event) => update('jenkinsUrl', event.target.value)}
                required
              />
            </label>
            <div className="field-row">
              <label>
                Staging username
                <input
                  value={config.jenkinsUsername}
                  onChange={(event) =>
                    update('jenkinsUsername', event.target.value)
                  }
                  placeholder="Jenkins username"
                  autoComplete="username"
                  required
                />
              </label>
              <label>
                Staging API token
                <input
                  type="password"
                  value={config.jenkinsToken}
                  onChange={(event) =>
                    update('jenkinsToken', event.target.value)
                  }
                  placeholder="••••••••••••"
                  autoComplete="off"
                  required
                />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>
              <span className="provider-icon jenkins production">J</span>
              Jenkins production
              <small className="optional-label">Optional</small>
            </legend>
            <label>
              Jenkins URL
              <input
                type="url"
                value={config.productionJenkins?.jenkinsUrl ?? ''}
                onChange={(event) =>
                  updateProductionJenkins('jenkinsUrl', event.target.value)
                }
              />
            </label>
            <div className="field-row">
              <label>
                Production username
                <input
                  value={config.productionJenkins?.jenkinsUsername ?? ''}
                  onChange={(event) =>
                    updateProductionJenkins(
                      'jenkinsUsername',
                      event.target.value,
                    )
                  }
                  placeholder="Jenkins username"
                  autoComplete="off"
                  required={Boolean(config.productionJenkins?.jenkinsToken)}
                />
              </label>
              <label>
                Production API token
                <input
                  type="password"
                  value={config.productionJenkins?.jenkinsToken ?? ''}
                  onChange={(event) =>
                    updateProductionJenkins('jenkinsToken', event.target.value)
                  }
                  placeholder="••••••••••••"
                  autoComplete="off"
                  required={Boolean(config.productionJenkins?.jenkinsUsername)}
                />
              </label>
            </div>
            <p className="field-hint">
              Enables production release options through
              Prod Deployments/Prod-cluster-deployment.
            </p>
          </fieldset>

          {bulkPasteMessage && (
            <div className="bulk-paste-success" role="status">
              <span aria-hidden="true">✓</span> {bulkPasteMessage}
            </div>
          )}

          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? 'Verifying connections…' : 'Connect and continue'}
            {!submitting && <span aria-hidden="true">→</span>}
          </button>
        </form>
      </section>
    </main>
  )
}

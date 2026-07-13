import { useMemo, useState } from 'react'
import type {
  ConnectionStatus,
  EligibilityReason,
  JiraVersion,
  ReleaseDashboard,
  ReleaseItem,
  ServiceRelease,
} from '../../shared/types'
import { StagingReleaseDialog } from './StagingReleaseDialog'
import { ServiceOperations } from './ServiceOperations'

type Props = {
  connection: ConnectionStatus
  releases: JiraVersion[]
  selectedVersionId: string
  dashboard?: ReleaseDashboard
  loading: boolean
  error?: string
  onSelectVersion: (versionId: string) => void
  onRefresh: () => void
  onDisconnect: () => void
}

const reasonLabels: Record<EligibilityReason, string> = {
  NO_MATCHING_PR: 'No matching PR',
  WRONG_BASE_BRANCH: 'Not targeting dev',
  REVIEW_REQUIRED: 'Review required',
  CHANGES_REQUESTED: 'Changes requested',
  HAS_CONFLICTS: 'Merge conflicts',
  MERGEABILITY_PENDING: 'Checking conflicts',
  CHECKS_PENDING: 'Checks pending',
  CHECKS_FAILED: 'Checks failed',
  DRAFT: 'Draft PR',
  ALREADY_MERGED: 'Merged',
}

function formatDate(value?: string) {
  if (!value) return 'No date set'
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00`))
}

function relativeTime(value: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  )
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

function ItemStatus({ item }: { item: ReleaseItem }) {
  if (item.pullRequest?.merged) {
    return <span className="status-pill merged">Merged</span>
  }
  if (item.eligible) {
    return <span className="status-pill ready">Ready</span>
  }
  return <span className="status-pill blocked">Blocked</span>
}

function ServiceCard({
  service,
  selected,
  onClick,
}: {
  service: ServiceRelease
  selected: boolean
  onClick: () => void
}) {
  const name = service.repository.split('/').at(-1)
  const total = service.items.length
  const completed = service.eligibleCount + service.mergedCount
  const progress = total === 0 ? 0 : Math.round((completed / total) * 100)

  return (
    <button
      className={`service-card ${selected ? 'selected' : ''}`}
      onClick={onClick}
      type="button"
    >
      <div className="service-card-header">
        <span className="service-avatar">{name?.slice(0, 2).toUpperCase()}</span>
        <span>
          <strong>{name}</strong>
          <small>{service.repository}</small>
        </span>
        <span className="chevron">›</span>
      </div>
      <div className="service-metrics">
        <span>
          <strong>{service.eligibleCount}</strong> ready
        </span>
        <span>
          <strong>{service.blockedCount}</strong> blocked
        </span>
        <span>
          <strong>{service.mergedCount}</strong> merged
        </span>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={`${name} release readiness`}
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
    </button>
  )
}

function ServiceDetail({
  service,
  onCreateRelease,
}: {
  service: ServiceRelease
  onCreateRelease: () => void
}) {
  const name = service.repository.split('/').at(-1)
  return (
    <section className="detail-panel">
      <div className="detail-heading">
        <div>
          <p className="eyebrow">Service detail</p>
          <h2>{name}</h2>
          <p className="muted">{service.repository}</p>
        </div>
        <div className="detail-actions">
          <button
            className="create-release-button"
            type="button"
            onClick={onCreateRelease}
          >
            <span aria-hidden="true">＋</span> Create staging release
          </button>
          <div className="summary-badge">
            {service.eligibleCount + service.mergedCount}/{service.items.length}
            <small>clear</small>
          </div>
        </div>
      </div>

      <div className="pr-list">
        {service.items.map((item) => (
          <article
            className="pr-row"
            key={`${item.issue.key}-${item.pullRequest?.id ?? 'unmatched'}`}
          >
            <div className="pr-main">
              <div className="pr-title-row">
                <a href={item.issue.url} target="_blank" rel="noreferrer">
                  {item.issue.key}
                </a>
                <ItemStatus item={item} />
              </div>
              <h3>
                {item.pullRequest ? (
                  <a
                    href={item.pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.pullRequest.title}
                  </a>
                ) : (
                  item.issue.summary
                )}
              </h3>
              {item.pullRequest && (
                <p className="branch-line">
                  <code>{item.pullRequest.headBranch}</code>
                  <span>→</span>
                  <code>{item.pullRequest.baseBranch}</code>
                  <span>#{item.pullRequest.number}</span>
                </p>
              )}
            </div>
            <div className="reason-list">
              {[...item.blockingReasons, ...item.warningReasons].map(
                (reason) => (
                  <span
                    className={`reason ${item.warningReasons.includes(reason) ? 'warning' : ''}`}
                    key={reason}
                  >
                    {reasonLabels[reason]}
                  </span>
                ),
              )}
              {item.eligible && item.warningReasons.length === 0 && (
                <span className="reason success">All criteria met</span>
              )}
            </div>
          </article>
        ))}
      </div>
      <ServiceOperations repository={service.repository} />
    </section>
  )
}

export function ReleaseOverview({
  connection,
  releases,
  selectedVersionId,
  dashboard,
  loading,
  error,
  onSelectVersion,
  onRefresh,
  onDisconnect,
}: Props) {
  const [selectedRepository, setSelectedRepository] = useState('')
  const [releaseRepository, setReleaseRepository] = useState('')
  const selectedService = useMemo(
    () =>
      dashboard?.services.find(
        (service) => service.repository === selectedRepository,
      ) ?? dashboard?.services[0],
    [dashboard, selectedRepository],
  )
  const totalItems =
    dashboard?.services.reduce(
      (sum, service) => sum + service.items.length,
      0,
    ) ?? 0
  const readyItems =
    dashboard?.services.reduce(
      (sum, service) => sum + service.eligibleCount + service.mergedCount,
      0,
    ) ?? 0

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark compact">RD</span>
          <span>
            <strong>Release Desk</strong>
            <small>Operations console</small>
          </span>
        </div>
        <div className="topbar-actions">
          <span className="connection-dot" />
          <span className="connected-label">
            {connection.githubOrg} · {connection.projectKey}
          </span>
          <button className="text-button" type="button" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <main className="dashboard">
        <section className="release-toolbar">
          <div>
            <p className="eyebrow">Active release</p>
            <select
              aria-label="Active Jira release"
              value={selectedVersionId}
              onChange={(event) => {
                setSelectedRepository('')
                onSelectVersion(event.target.value)
              }}
            >
              {releases.map((release) => (
                <option value={release.id} key={release.id}>
                  {release.name}
                </option>
              ))}
            </select>
          </div>
          <div className="release-meta">
            <span>
              Target
              <strong>{formatDate(dashboard?.version.releaseDate)}</strong>
            </span>
            {dashboard && (
              <span>
                Last synced
                <strong>{relativeTime(dashboard.fetchedAt)}</strong>
              </span>
            )}
            <button
              className="secondary-button"
              type="button"
              onClick={onRefresh}
              disabled={loading || !selectedVersionId}
            >
              {loading ? 'Syncing…' : '↻ Refresh'}
            </button>
          </div>
        </section>

        {error && (
          <div className="alert error" role="alert">
            <strong>Couldn’t load this release.</strong> {error}
          </div>
        )}

        {loading && !dashboard && (
          <div className="loading-state">
            <span className="spinner" />
            <h2>Mapping release tickets to pull requests…</h2>
            <p>This can take a moment for larger releases.</p>
          </div>
        )}

        {!loading && releases.length === 0 && (
          <div className="empty-state">
            <h2>No unreleased Jira versions found</h2>
            <p>Create or unarchive a release in project OH, then refresh.</p>
          </div>
        )}

        {dashboard && (
          <>
            <section className="overview-strip">
              <div className="readiness-score">
                <span>
                  {totalItems === 0
                    ? 0
                    : Math.round((readyItems / totalItems) * 100)}
                  <small>%</small>
                </span>
                <div>
                  <strong>Release readiness</strong>
                  <p>
                    {readyItems} of {totalItems} pull requests clear
                  </p>
                </div>
              </div>
              <div className="stat">
                <strong>{dashboard.services.length}</strong>
                <span>Services</span>
              </div>
              <div className="stat">
                <strong>{dashboard.unmatched.length}</strong>
                <span>Unmatched tickets</span>
              </div>
              <div className="stat">
                <strong>{dashboard.githubRateLimit?.remaining ?? '—'}</strong>
                <span>GitHub calls left</span>
              </div>
              {dashboard.cached && <span className="cache-pill">Cached</span>}
            </section>

            {dashboard.warnings.map((warning, index) => (
              <div className="alert warning" key={`${warning.message}-${index}`}>
                <strong>Partial GitHub data.</strong> {warning.message}
              </div>
            ))}

            <div className="dashboard-grid">
              <section className="services-panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Release scope</p>
                    <h2>Services</h2>
                  </div>
                  <span>{dashboard.services.length}</span>
                </div>
                <div className="service-list">
                  {dashboard.services.map((service) => (
                    <ServiceCard
                      service={service}
                      selected={
                        selectedService?.repository === service.repository
                      }
                      onClick={() => setSelectedRepository(service.repository)}
                      key={service.repository}
                    />
                  ))}
                </div>
              </section>
              {selectedService ? (
                <ServiceDetail
                  service={selectedService}
                  onCreateRelease={() =>
                    setReleaseRepository(selectedService.repository)
                  }
                />
              ) : (
                <section className="detail-panel empty-state">
                  <h2>No pull requests found</h2>
                  <p>Review unmatched tickets below or refresh the release.</p>
                </section>
              )}
            </div>

            {dashboard.unmatched.length > 0 && (
              <section className="unmatched-panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Needs attention</p>
                    <h2>Tickets without a matching PR</h2>
                  </div>
                  <span>{dashboard.unmatched.length}</span>
                </div>
                <div className="unmatched-grid">
                  {dashboard.unmatched.map((item) => (
                    <a
                      href={item.issue.url}
                      target="_blank"
                      rel="noreferrer"
                      key={item.issue.key}
                    >
                      <strong>{item.issue.key}</strong>
                      <span>{item.issue.summary}</span>
                      <small>
                        {item.issue.assignee ?? 'Unassigned'} ·{' '}
                        {item.issue.status}
                      </small>
                    </a>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
      {releaseRepository && (
        <StagingReleaseDialog
          repository={releaseRepository}
          onClose={() => setReleaseRepository('')}
        />
      )}
    </div>
  )
}

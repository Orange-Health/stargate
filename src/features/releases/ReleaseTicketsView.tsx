import type { EligibilityReason, ReleaseItem } from '../../shared/types'
import {
  ticketMatchesFilter,
  ticketReadinessLabel,
  type ReleaseTicket,
  type TicketFilter,
} from './releaseTickets'

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

function reasonLabel(reason: EligibilityReason, item: ReleaseItem) {
  if (
    reason === 'WRONG_BASE_BRANCH' &&
    item.pullRequest &&
    item.pullRequest.baseBranch !== 'dev'
  ) {
    return `Targets ${item.pullRequest.baseBranch}`
  }
  return reasonLabels[reason]
}

function TicketCard({
  ticket,
  selected,
  onClick,
}: {
  ticket: ReleaseTicket
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`service-card ticket-card ${selected ? 'selected' : ''}`}
      onClick={onClick}
      type="button"
    >
      <div className="service-card-header">
        <span className="service-avatar">
          {ticket.issue.key.split('-')[0]?.slice(0, 2) ?? 'TK'}
        </span>
        <span>
          <strong>{ticket.issue.key}</strong>
          <small>{ticket.issue.summary}</small>
        </span>
        <span className="chevron">›</span>
      </div>
      <div className="service-metrics">
        <span className={`status-pill ${ticket.readiness}`}>
          {ticketReadinessLabel(ticket.readiness)}
        </span>
        {ticket.serviceCount > 0 && (
          <span>
            <strong>{ticket.serviceCount}</strong>{' '}
            {ticket.serviceCount === 1 ? 'service' : 'services'}
          </span>
        )}
        {ticket.blockedCount > 0 && (
          <span>
            <strong>{ticket.blockedCount}</strong> blocked
          </span>
        )}
        {ticket.mergedCount > 0 && (
          <span>
            <strong>{ticket.mergedCount}</strong> merged
          </span>
        )}
      </div>
      {ticket.items.some((item) => item.pullRequest) && (
        <div className="ticket-pr-chips">
          {ticket.items
            .filter((item) => item.pullRequest)
            .map((item) => (
              <span key={`${item.repository}-${item.pullRequest!.number}`}>
                {(item.repository ?? '').split('/').at(-1)} #
                {item.pullRequest!.number}
              </span>
            ))}
        </div>
      )}
    </button>
  )
}

type Props = {
  tickets: ReleaseTicket[]
  ticketFilter: TicketFilter
  ticketSearch: string
  selectedIssueKey: string
  removeError: string
  onFilterChange: (filter: TicketFilter) => void
  onSearchChange: (value: string) => void
  onSelectTicket: (issueKey: string) => void
  onRemoveTicket: () => void
}

export function ReleaseTicketsView({
  tickets,
  ticketFilter,
  ticketSearch,
  selectedIssueKey,
  removeError,
  onFilterChange,
  onSearchChange,
  onSelectTicket,
  onRemoveTicket,
}: Props) {
  const query = ticketSearch.trim().toLowerCase()
  const filtered = tickets.filter((ticket) => {
    if (!ticketMatchesFilter(ticket, ticketFilter)) return false
    if (!query) return true
    return (
      ticket.issue.key.toLowerCase().includes(query) ||
      ticket.issue.summary.toLowerCase().includes(query) ||
      ticket.items.some((item) =>
        (item.repository ?? '').toLowerCase().includes(query),
      )
    )
  })
  const selected =
    filtered.find((ticket) => ticket.issue.key === selectedIssueKey) ??
    tickets.find((ticket) => ticket.issue.key === selectedIssueKey)

  const counts = {
    all: tickets.length,
    blocked: tickets.filter((ticket) => ticket.readiness === 'blocked').length,
    'not-merge-ready': tickets.filter(
      (ticket) =>
        ticket.readiness === 'blocked' || ticket.readiness === 'pending',
    ).length,
    unmatched: tickets.filter((ticket) => ticket.readiness === 'unmatched')
      .length,
    merged: tickets.filter((ticket) => ticket.readiness === 'merged').length,
  }

  return (
    <div className="dashboard-grid">
      <section className="services-panel">
        <div className="section-heading">
          <div>
            <h2>Tickets</h2>
          </div>
          <span>
            {filtered.length}/{tickets.length}
          </span>
        </div>
        <label className="service-search">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
          <input
            type="search"
            value={ticketSearch}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search tickets"
            aria-label="Search tickets"
          />
        </label>
        <div className="service-filters" aria-label="Filter tickets">
          {(
            [
              ['all', 'All'],
              ['blocked', 'Blocked'],
              ['not-merge-ready', 'Not merge-ready'],
              ['unmatched', 'Unmatched'],
              ['merged', 'Merged'],
            ] as const
          ).map(([filter, label]) => (
            <button
              key={filter}
              className={ticketFilter === filter ? 'active' : ''}
              type="button"
              onClick={() => onFilterChange(filter)}
            >
              {label} <span>{counts[filter]}</span>
            </button>
          ))}
        </div>
        <div className="service-list-wrap">
          <div className="service-list">
            {filtered.length ? (
              filtered.map((ticket) => (
                <TicketCard
                  key={ticket.issue.key}
                  ticket={ticket}
                  selected={selected?.issue.key === ticket.issue.key}
                  onClick={() => onSelectTicket(ticket.issue.key)}
                />
              ))
            ) : (
              <div className="service-search-empty">
                No tickets match your filters.
              </div>
            )}
          </div>
        </div>
      </section>

      {selected ? (
        <section className="detail-panel ticket-detail-panel">
          <div className="detail-heading">
            <div>
              <p className="eyebrow">{selected.issue.status}</p>
              <h2>
                <a
                  href={selected.issue.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {selected.issue.key}
                </a>
              </h2>
              <p>{selected.issue.summary}</p>
              <small>
                {selected.issue.assignee ?? 'Unassigned'} ·{' '}
                {ticketReadinessLabel(selected.readiness)}
              </small>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={onRemoveTicket}
              disabled={selected.readiness === 'merged'}
              title={
                selected.readiness === 'merged'
                  ? 'Merged tickets cannot be removed from the release'
                  : undefined
              }
            >
              Remove from release
            </button>
          </div>
          {removeError && (
            <div className="alert warning detail-alert">
              <strong>Could not remove ticket.</strong> {removeError}
            </div>
          )}
          <div className="ticket-detail-body">
            <div className="operation-section">
              <div className="operation-heading">
                <div>
                  <h3>Linked service PRs</h3>
                </div>
                <span className="ticket-pr-count">
                  {
                    selected.items.filter((item) => item.pullRequest)
                      .length
                  }
                </span>
              </div>
              {selected.readiness === 'unmatched' ? (
                <div className="empty-state ticket-unmatched-empty">
                  <h2>No matching PR</h2>
                  <p>
                    This ticket is on the release but has no linked GitHub
                    pull request.
                  </p>
                </div>
              ) : (
                <div className="pr-list">
                  {selected.items
                    .filter((item) => item.pullRequest)
                    .map((item) => {
                      const pull = item.pullRequest!
                      const reasons = [
                        ...item.blockingReasons,
                        ...item.warningReasons,
                      ].filter(
                        (reason) =>
                          !(pull.merged && reason === 'ALREADY_MERGED'),
                      )
                      return (
                        <article
                          className="pr-row"
                          key={`${item.repository}-${pull.id}`}
                        >
                          <div className="pr-main">
                            <div className="pr-title-row">
                              <strong>
                                {(item.repository ?? pull.repository)
                                  .split('/')
                                  .at(-1)}
                              </strong>
                              <span
                                className={`status-pill ${
                                  pull.merged
                                    ? 'merged'
                                    : item.eligible
                                      ? 'ready'
                                      : 'blocked'
                                }`}
                              >
                                {pull.merged
                                  ? 'Merged'
                                  : item.eligible
                                    ? 'Ready'
                                    : 'Blocked'}
                              </span>
                            </div>
                            <h3>
                              <a
                                href={pull.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                #{pull.number} {pull.title}
                              </a>
                            </h3>
                            <p className="branch-line">
                              <code>{pull.headBranch}</code>
                              <span>→</span>
                              <code>{pull.baseBranch}</code>
                            </p>
                            {reasons.length > 0 && (
                              <div className="reason-row">
                                {reasons.map((reason) => (
                                  <span className="reason" key={reason}>
                                    {reasonLabel(reason, item)}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </article>
                      )
                    })}
                </div>
              )}
            </div>
          </div>
        </section>
      ) : (
        <section className="detail-panel empty-state">
          <h2>Select a ticket</h2>
          <p>Choose a ticket to review linked service PRs or remove it.</p>
        </section>
      )}
    </div>
  )
}

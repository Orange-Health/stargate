import type { ReactNode } from "react";
import type { EligibilityReason, ReleaseItem } from "../../shared/types";
import {
  listTicketAssignees,
  ticketMatchesAssignee,
  ticketMatchesFilter,
  ticketReadinessLabel,
  UNASSIGNED_ASSIGNEE,
  type ReleaseTicket,
  type TicketFilter,
} from "./releaseTickets";
import {
  FILTER_SCROLL_DELAY_MS,
  scheduleScrollDashboardGridIntoView,
  scrollDashboardGridIntoView,
} from "./scrollDashboard";

const reasonLabels: Record<EligibilityReason, string> = {
  NO_MATCHING_PR: "No matching PR",
  WRONG_BASE_BRANCH: "Not targeting dev",
  REVIEW_REQUIRED: "Review required",
  CHANGES_REQUESTED: "Changes requested",
  UNRESOLVED_COMMENTS: "Unresolved comments",
  HAS_CONFLICTS: "Merge conflicts",
  MERGEABILITY_PENDING: "Checking conflicts",
  CHECKS_PENDING: "Checks pending",
  CHECKS_FAILED: "Checks failed",
  DRAFT: "Draft PR",
  ALREADY_MERGED: "Merged",
};

function reasonLabel(reason: EligibilityReason, item: ReleaseItem) {
  if (
    reason === "WRONG_BASE_BRANCH" &&
    item.pullRequest &&
    item.pullRequest.baseBranch !== "dev"
  ) {
    return `Targets ${item.pullRequest.baseBranch}`;
  }
  return reasonLabels[reason];
}

function TicketCard({
  ticket,
  selected,
  onClick,
}: {
  ticket: ReleaseTicket;
  selected: boolean;
  onClick: () => void;
}) {
  const pullCount = ticket.items.filter((item) => item.pullRequest).length;
  const progress =
    pullCount === 0 ? 0 : Math.round((ticket.mergedCount / pullCount) * 100);

  return (
    <button
      className={`service-card ticket-card ${selected ? "selected" : ""}`}
      onClick={onClick}
      type="button"
    >
      <div className="service-card-header">
        <span className={`service-avatar ticket-avatar ${ticket.readiness}`}>
          {ticket.issue.key.split("-")[0]?.slice(0, 2) ?? "TK"}
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
            <strong>{ticket.serviceCount}</strong>{" "}
            {ticket.serviceCount === 1 ? "service" : "services"}
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
      {pullCount > 0 && (
        <div
          className="progress-track"
          role="progressbar"
          aria-label={`${ticket.issue.key} merge progress`}
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
    </button>
  );
}

type Props = {
  tickets: ReleaseTicket[];
  ticketFilter: TicketFilter;
  ticketAssigneeFilter: string;
  ticketSearch: string;
  selectedIssueKey: string;
  removeError: string;
  viewToggle?: ReactNode;
  onFilterChange: (filter: TicketFilter) => void;
  onAssigneeFilterChange: (assignee: string) => void;
  onSearchChange: (value: string) => void;
  onSelectTicket: (issueKey: string) => void;
  onRemoveTicket: () => void;
};

export function ReleaseTicketsView({
  tickets,
  ticketFilter,
  ticketAssigneeFilter,
  ticketSearch,
  selectedIssueKey,
  removeError,
  viewToggle,
  onFilterChange,
  onAssigneeFilterChange,
  onSearchChange,
  onSelectTicket,
  onRemoveTicket,
}: Props) {
  const query = ticketSearch.trim().toLowerCase();
  const assignees = listTicketAssignees(tickets);
  const hasUnassigned = tickets.some(
    (ticket) => !ticket.issue.assignee?.trim(),
  );
  const scoped = tickets.filter((ticket) => {
    if (!ticketMatchesAssignee(ticket, ticketAssigneeFilter)) return false;
    if (!query) return true;
    return (
      ticket.issue.key.toLowerCase().includes(query) ||
      ticket.issue.summary.toLowerCase().includes(query) ||
      ticket.items.some((item) =>
        (item.repository ?? "").toLowerCase().includes(query),
      )
    );
  });
  const filtered = scoped.filter((ticket) =>
    ticketMatchesFilter(ticket, ticketFilter),
  );
  const selected =
    filtered.find((ticket) => ticket.issue.key === selectedIssueKey) ??
    tickets.find((ticket) => ticket.issue.key === selectedIssueKey);

  const counts = {
    all: scoped.length,
    blocked: scoped.filter((ticket) =>
      ticketMatchesFilter(ticket, "blocked"),
    ).length,
    "not-merge-ready": scoped.filter((ticket) =>
      ticketMatchesFilter(ticket, "not-merge-ready"),
    ).length,
    unmatched: scoped.filter((ticket) =>
      ticketMatchesFilter(ticket, "unmatched"),
    ).length,
    merged: scoped.filter((ticket) =>
      ticketMatchesFilter(ticket, "merged"),
    ).length,
  };

  return (
    <div className="dashboard-grid">
      <section className="services-panel">
        <div className="section-heading">
          <div className="section-heading-start">
            <h2>Tickets</h2>
            {viewToggle}
          </div>
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
            onFocus={scrollDashboardGridIntoView}
            placeholder="Search tickets"
            aria-label="Search tickets"
          />
        </label>
        <label className="service-search ticket-assignee-filter">
          <select
            value={ticketAssigneeFilter}
            onChange={(event) => {
              onAssigneeFilterChange(event.target.value);
              scheduleScrollDashboardGridIntoView(FILTER_SCROLL_DELAY_MS);
            }}
            aria-label="Filter by assignee"
          >
            <option value="">All assignees</option>
            {hasUnassigned && (
              <option value={UNASSIGNED_ASSIGNEE}>Unassigned</option>
            )}
            {assignees.map((assignee) => (
              <option value={assignee} key={assignee}>
                {assignee}
              </option>
            ))}
          </select>
        </label>
        <div className="service-filters" aria-label="Filter tickets">
          {(
            [
              [
                "all",
                "All",
                "Shows every Jira ticket in this release, including ones with and without matching PRs.",
              ],
              [
                "blocked",
                "Blocked",
                "Shows tickets with an open PR blocked by a hard issue such as missing review, merge conflicts, wrong base branch, or draft status.",
              ],
              [
                "not-merge-ready",
                "Not merge-ready",
                "Shows tickets whose open PRs are not eligible to merge yet — including hard blockers and softer issues like pending or failed checks.",
              ],
              [
                "unmatched",
                "Unmatched",
                "Shows tickets with no matching pull request linked across the release services.",
              ],
              [
                "merged",
                "Merged",
                "Shows tickets whose linked pull requests are all already merged into dev.",
              ],
            ] as const
          ).map(([filter, label, tooltip]) => (
            <button
              key={filter}
              className={ticketFilter === filter ? "active" : ""}
              type="button"
              data-tooltip={tooltip}
              onClick={() => {
                onFilterChange(filter);
                scheduleScrollDashboardGridIntoView(FILTER_SCROLL_DELAY_MS);
              }}
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
                <a href={selected.issue.url} target="_blank" rel="noreferrer">
                  {selected.issue.key}
                </a>
              </h2>
              <p className="muted">{selected.issue.summary}</p>
            </div>
            <div className="detail-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={onRemoveTicket}
              >
                Remove from release
              </button>
            </div>
          </div>
          {removeError && (
            <div className="alert warning detail-alert">
              <strong>Could not remove ticket.</strong> {removeError}
            </div>
          )}
          <div className="service-operations">
            <div className="operation-section">
              <div className="operation-heading">
                <div>
                  <p className="eyebrow">Linked work</p>
                  <h3>Service linked PRs</h3>
                </div>
                <div className="summary-badge">
                  {selected.mergedCount}/
                  {selected.items.filter((item) => item.pullRequest).length}
                  <small>merged</small>
                </div>
              </div>
              {selected.readiness === "unmatched" ? (
                <div className="empty-state ticket-unmatched-empty">
                  <h2>No matching PR</h2>
                  <p>
                    This ticket is on the release but has no linked GitHub pull
                    request.
                  </p>
                </div>
              ) : (
                <div className="pr-list">
                  {selected.items
                    .filter((item) => item.pullRequest)
                    .map((item) => {
                      const pull = item.pullRequest!;
                      const reasons = [
                        ...item.blockingReasons,
                        ...item.warningReasons,
                      ].filter(
                        (reason) =>
                          !(pull.merged && reason === "ALREADY_MERGED"),
                      );
                      return (
                        <article
                          className="pr-row"
                          key={`${item.repository}-${pull.id}`}
                        >
                          <div className="pr-main">
                            <div className="pr-title-row">
                              <strong>
                                {(item.repository ?? pull.repository)
                                  .split("/")
                                  .at(-1)}
                              </strong>
                              <span
                                className={`status-pill ${
                                  pull.merged
                                    ? "merged"
                                    : item.eligible
                                      ? "ready"
                                      : "blocked"
                                }`}
                              >
                                {pull.merged
                                  ? "Merged"
                                  : item.eligible
                                    ? "Ready"
                                    : "Blocked"}
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
                      );
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
  );
}

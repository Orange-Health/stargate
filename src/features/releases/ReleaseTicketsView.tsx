import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../shared/api";
import type {
  EligibilityReason,
  ReleaseItem,
  ServiceRelease,
} from "../../shared/types";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  featureMergeActions,
  isFeatureForceMergeReady,
  isFeatureMergeReady,
  isFeatureRetargetReady,
  type FeatureMergeAction,
} from "./featureMerge";
import {
  listTicketAssignees,
  ticketMatchesAssignee,
  ticketMatchesFilter,
  ticketReadinessLabel,
  UNASSIGNED_ASSIGNEE,
  type ReleaseTicket,
  type ReleaseTicketItem,
  type TicketFilter,
} from "./releaseTickets";
import {
  FILTER_SCROLL_DELAY_MS,
  scheduleScrollDashboardGridIntoView,
  scrollDashboardGridIntoView,
} from "./scrollDashboard";

type PendingTicketMerge = FeatureMergeAction & {
  retargetToDev: boolean;
  bypassBranchProtection: boolean;
};

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

function reasonLabel(
  reason: EligibilityReason,
  item: ReleaseItem,
  defaultBranch?: string,
) {
  if (
    reason === "WRONG_BASE_BRANCH" &&
    item.pullRequest?.baseBranch === defaultBranch
  ) {
    return "Targets default branch";
  }
  return reasonLabels[reason];
}

function serviceForItem(
  item: ReleaseTicketItem,
  services: ServiceRelease[],
) {
  if (!item.repository) return undefined;
  return services.find((service) => service.repository === item.repository);
}

function mergeKey(repository: string, pullNumber: number) {
  return `${repository}:${pullNumber}`;
}

function skippedPullsForItem(
  item: ReleaseTicketItem,
  skippedKeys: Set<string>,
) {
  const pull = item.pullRequest;
  const repository = item.repository ?? pull?.repository;
  if (!pull || !repository) return new Set<number>();
  if (!skippedKeys.has(mergeKey(repository, pull.number))) {
    return new Set<number>();
  }
  return new Set([pull.number]);
}

function ticketReadyMergeActions(
  ticket: ReleaseTicket,
  services: ServiceRelease[],
  skippedKeys: Set<string>,
): FeatureMergeAction[] {
  return ticket.items.flatMap((item) => {
    const service = serviceForItem(item, services);
    if (!service) return [];
    return featureMergeActions(
      { ...service, items: [item] },
      skippedPullsForItem(item, skippedKeys),
    );
  });
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
  services: ServiceRelease[];
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
  onRefreshTicket: (issueKey: string) => Promise<void>;
  onDataChanged: () => void | Promise<void>;
};

export function ReleaseTicketsView({
  tickets,
  services,
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
  onRefreshTicket,
  onDataChanged,
}: Props) {
  const [refreshingTicket, setRefreshingTicket] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [merging, setMerging] = useState<string>();
  const [bulkMerging, setBulkMerging] = useState(false);
  const [mergeError, setMergeError] = useState("");
  const [optimisticallyMerged, setOptimisticallyMerged] = useState<Set<string>>(
    new Set(),
  );
  const [pendingMerge, setPendingMerge] = useState<PendingTicketMerge>();
  const [pendingBulkMerge, setPendingBulkMerge] = useState(false);
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
  const readyMergeActions = selected
    ? ticketReadyMergeActions(selected, services, optimisticallyMerged)
    : [];
  const mergeBusy = bulkMerging || merging !== undefined;

  useEffect(() => {
    setRefreshError("");
    setMergeError("");
    setPendingMerge(undefined);
    setPendingBulkMerge(false);
    setOptimisticallyMerged(new Set());
  }, [selectedIssueKey]);

  async function refreshSelectedTicket() {
    if (!selected || refreshingTicket || mergeBusy) return;
    setRefreshingTicket(true);
    setRefreshError("");
    setMergeError("");
    try {
      await onRefreshTicket(selected.issue.key);
    } catch (reason) {
      setRefreshError(
        reason instanceof Error
          ? reason.message
          : "Could not refresh this ticket.",
      );
    } finally {
      setRefreshingTicket(false);
    }
  }

  function requestMerge(
    action: FeatureMergeAction,
    options: { retargetToDev?: boolean; bypassBranchProtection?: boolean } = {},
  ) {
    setPendingBulkMerge(false);
    setPendingMerge({
      ...action,
      retargetToDev: options.retargetToDev ?? Boolean(action.retargetToDev),
      bypassBranchProtection:
        options.bypassBranchProtection ??
        Boolean(action.bypassBranchProtection),
    });
  }

  function requestBulkMerge() {
    if (readyMergeActions.length === 0 || mergeBusy) return;
    setPendingMerge(undefined);
    setPendingBulkMerge(true);
  }

  async function mergePullRequest(pending: PendingTicketMerge) {
    const { repository, pullNumber, retargetToDev, bypassBranchProtection } =
      pending;
    setPendingMerge(undefined);
    setMerging(mergeKey(repository, pullNumber));
    setMergeError("");
    try {
      await api.mergeFeaturePullRequest({
        repository,
        pullNumber,
        retargetToDev,
        ...(bypassBranchProtection ? { bypassBranchProtection: true } : {}),
      });
      setOptimisticallyMerged((current) =>
        new Set(current).add(mergeKey(repository, pullNumber)),
      );
      await onDataChanged();
    } catch (reason) {
      setMergeError(
        reason instanceof Error ? reason.message : "Could not merge the PR.",
      );
    } finally {
      setMerging(undefined);
    }
  }

  async function mergeAllReadyPullRequests() {
    if (readyMergeActions.length === 0 || mergeBusy) return;
    setPendingBulkMerge(false);
    setBulkMerging(true);
    setMergeError("");
    const merged = new Set<string>();
    const failures: string[] = [];
    for (const action of readyMergeActions) {
      const key = mergeKey(action.repository, action.pullNumber);
      try {
        await api.mergeFeaturePullRequest({
          repository: action.repository,
          pullNumber: action.pullNumber,
          retargetToDev: Boolean(action.retargetToDev),
        });
        merged.add(key);
      } catch (reason) {
        failures.push(
          `#${action.pullNumber}: ${
            reason instanceof Error ? reason.message : "Could not merge the PR."
          }`,
        );
      }
    }
    if (merged.size > 0) {
      setOptimisticallyMerged((current) => new Set([...current, ...merged]));
      await onDataChanged();
    }
    if (failures.length > 0) {
      setMergeError(
        `Merged ${merged.size}/${readyMergeActions.length}. ${failures.join(" ")}`,
      );
    }
    setBulkMerging(false);
  }

  const pendingMergeCopy = pendingMerge
    ? pendingMerge.bypassBranchProtection
      ? {
          title: "Force merge to dev?",
          message: `Force merge feature PR #${pendingMerge.pullNumber} into dev?\n\nThis bypasses approvals and required checks. Your GitHub token must have branch-protection bypass access.`,
          confirmLabel: "Force merge",
        }
      : pendingMerge.retargetToDev
        ? {
            title: "Retarget and merge?",
            message: `Retarget feature PR #${pendingMerge.pullNumber} to dev and merge it?`,
            confirmLabel: "Retarget and merge",
          }
        : {
            title: "Merge to dev?",
            message: `Merge feature PR #${pendingMerge.pullNumber} into dev?`,
            confirmLabel: "Merge",
          }
    : undefined;

  const bulkMergeRetargetCount = readyMergeActions.filter(
    (action) => action.retargetToDev,
  ).length;
  const pendingBulkMergeCopy = pendingBulkMerge
    ? {
        title: "Merge all ready to dev?",
        message:
          bulkMergeRetargetCount > 0
            ? `Merge ${readyMergeActions.length} ready PR(s) into dev for ${selected?.issue.key}?\n\n${bulkMergeRetargetCount} will be retargeted from the default branch first.`
            : `Merge ${readyMergeActions.length} ready PR(s) into dev for ${selected?.issue.key}?`,
        confirmLabel: "Merge all",
      }
    : undefined;

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
                  onClick={() => {
                    setRefreshError("");
                    onSelectTicket(ticket.issue.key);
                  }}
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
                onClick={() => void refreshSelectedTicket()}
                disabled={refreshingTicket || mergeBusy}
              >
                {refreshingTicket ? "Refreshing…" : "↻ Refresh PRs"}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={onRemoveTicket}
                disabled={refreshingTicket || mergeBusy}
              >
                Remove from release
              </button>
            </div>
          </div>
          {refreshError && (
            <div className="alert error detail-alert" role="alert">
              <strong>Could not refresh ticket.</strong> {refreshError}
            </div>
          )}
          {mergeError && (
            <div className="alert error detail-alert" role="alert">
              {mergeError}
            </div>
          )}
          {removeError && (
            <div className="alert warning detail-alert">
              <strong>Could not remove ticket.</strong> {removeError}
            </div>
          )}
          <div className="service-operations">
            {selected.readiness !== "unmatched" && (
              <div className="service-tab-panel-actions">
                <div className="service-bulk-merge-actions">
                  <button
                    className="merge-feature-button"
                    type="button"
                    aria-label="Merge all ready PRs into dev for this ticket"
                    onClick={() => requestBulkMerge()}
                    disabled={
                      readyMergeActions.length === 0 ||
                      mergeBusy ||
                      refreshingTicket
                    }
                  >
                    {bulkMerging
                      ? "Merging all…"
                      : readyMergeActions.length > 0
                        ? `Merge all ready to dev (${readyMergeActions.length})`
                        : "No ready PRs to merge"}
                  </button>
                </div>
              </div>
            )}
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
                      const service = serviceForItem(item, services);
                      const repository =
                        item.repository ?? pull.repository;
                      const skipped = skippedPullsForItem(
                        item,
                        optimisticallyMerged,
                      );
                      const alreadyMerged =
                        pull.merged ||
                        skipped.has(pull.number);
                      const mergeReady = Boolean(
                        service &&
                          isFeatureMergeReady(item, service, skipped),
                      );
                      const retargetReady = Boolean(
                        service &&
                          isFeatureRetargetReady(item, service, skipped),
                      );
                      const forceMergeReady = Boolean(
                        service &&
                          !mergeReady &&
                          pull.baseBranch === "dev" &&
                          isFeatureForceMergeReady(item, service, skipped),
                      );
                      return (
                        <article
                          className="pr-row"
                          key={`${repository}-${pull.id}`}
                        >
                          <div className="pr-main">
                            <div className="pr-title-row">
                              <strong>
                                {repository.split("/").at(-1)}
                              </strong>
                              <span
                                className={`status-pill ${
                                  alreadyMerged
                                    ? "merged"
                                    : item.eligible
                                      ? "ready"
                                      : "blocked"
                                }`}
                              >
                                {alreadyMerged
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
                          </div>
                          <div className="reason-list">
                            {[
                              ...item.blockingReasons,
                              ...item.warningReasons,
                            ]
                              .filter(
                                (reason) =>
                                  !(
                                    alreadyMerged &&
                                    reason === "ALREADY_MERGED"
                                  ),
                              )
                              .map((reason) => (
                                <span
                                  className={`reason ${item.warningReasons.includes(reason) ? "warning" : ""}`}
                                  key={reason}
                                >
                                  {reasonLabel(
                                    reason,
                                    item,
                                    service?.defaultBranch,
                                  )}
                                </span>
                              ))}
                            {item.eligible &&
                              item.warningReasons.length === 0 &&
                              !alreadyMerged && (
                                <span className="reason success">
                                  All criteria met
                                </span>
                              )}
                            {retargetReady && (
                              <button
                                className="merge-feature-button"
                                type="button"
                                disabled={mergeBusy}
                                onClick={() =>
                                  requestMerge(
                                    {
                                      repository,
                                      pullNumber: pull.number,
                                    },
                                    { retargetToDev: true },
                                  )
                                }
                              >
                                {merging ===
                                mergeKey(repository, pull.number)
                                  ? "Retargeting…"
                                  : "Retarget to dev and merge"}
                              </button>
                            )}
                            {mergeReady && (
                              <button
                                className="merge-feature-button"
                                type="button"
                                disabled={mergeBusy}
                                onClick={() =>
                                  requestMerge({
                                    repository,
                                    pullNumber: pull.number,
                                  })
                                }
                              >
                                {merging ===
                                mergeKey(repository, pull.number)
                                  ? "Merging…"
                                  : "Merge to dev"}
                              </button>
                            )}
                            {forceMergeReady && (
                              <button
                                className="merge-feature-button"
                                type="button"
                                disabled={mergeBusy}
                                onClick={() =>
                                  requestMerge(
                                    {
                                      repository,
                                      pullNumber: pull.number,
                                    },
                                    { bypassBranchProtection: true },
                                  )
                                }
                              >
                                {merging ===
                                mergeKey(repository, pull.number)
                                  ? "Force merging…"
                                  : "Force merge to dev"}
                              </button>
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
      {pendingMergeCopy && pendingMerge && (
        <ConfirmDialog
          title={pendingMergeCopy.title}
          message={pendingMergeCopy.message}
          confirmLabel={pendingMergeCopy.confirmLabel}
          onCancel={() => setPendingMerge(undefined)}
          onConfirm={() => void mergePullRequest(pendingMerge)}
        />
      )}
      {pendingBulkMergeCopy && pendingBulkMerge && (
        <ConfirmDialog
          title={pendingBulkMergeCopy.title}
          message={pendingBulkMergeCopy.message}
          confirmLabel={pendingBulkMergeCopy.confirmLabel}
          onCancel={() => setPendingBulkMerge(false)}
          onConfirm={() => void mergeAllReadyPullRequests()}
        />
      )}
    </div>
  );
}

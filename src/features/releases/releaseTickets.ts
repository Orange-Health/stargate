import type {
  EligibilityReason,
  JiraIssue,
  ReleaseDashboard,
  ReleaseItem,
} from '../../shared/types'

export type TicketReadiness =
  | 'unmatched'
  | 'merged'
  | 'ready'
  | 'blocked'
  | 'pending'

export type TicketFilter =
  | 'all'
  | 'blocked'
  | 'not-merge-ready'
  | 'unmatched'
  | 'merged'

export type ReleaseTicketItem = ReleaseItem & {
  repository?: string
}

export type ReleaseTicket = {
  issue: JiraIssue
  items: ReleaseTicketItem[]
  readiness: TicketReadiness
  eligibleCount: number
  blockedCount: number
  mergedCount: number
  serviceCount: number
}

const HARD_BLOCKERS: EligibilityReason[] = [
  'WRONG_BASE_BRANCH',
  'REVIEW_REQUIRED',
  'CHANGES_REQUESTED',
  'UNRESOLVED_COMMENTS',
  'HAS_CONFLICTS',
  'MERGEABILITY_PENDING',
  'DRAFT',
]

function isMergedItem(item: ReleaseItem) {
  return (
    Boolean(item.pullRequest?.merged) ||
    item.blockingReasons.includes('ALREADY_MERGED')
  )
}

export function ticketReadiness(items: ReleaseTicketItem[]): TicketReadiness {
  const withPulls = items.filter((item) => item.pullRequest)
  if (withPulls.length === 0) return 'unmatched'
  if (withPulls.every(isMergedItem)) return 'merged'
  const open = withPulls.filter((item) => !isMergedItem(item))
  if (
    open.some((item) =>
      item.blockingReasons.some((reason) => HARD_BLOCKERS.includes(reason)),
    )
  ) {
    return 'blocked'
  }
  if (open.some((item) => !item.eligible)) return 'pending'
  return 'ready'
}

export function groupReleaseTickets(
  dashboard: ReleaseDashboard,
): ReleaseTicket[] {
  const byKey = new Map<string, ReleaseTicketItem[]>()

  for (const service of dashboard.services) {
    for (const item of service.items) {
      const key = item.issue.key.toUpperCase()
      const current = byKey.get(key) ?? []
      current.push({
        ...item,
        repository: service.repository,
      })
      byKey.set(key, current)
    }
  }

  for (const item of dashboard.unmatched) {
    const key = item.issue.key.toUpperCase()
    if (byKey.has(key)) continue
    byKey.set(key, [{ ...item }])
  }

  return [...byKey.values()]
    .map((items) => {
      const issue = items[0].issue
      const readiness = ticketReadiness(items)
      const withPulls = items.filter((item) => item.pullRequest)
      return {
        issue,
        items,
        readiness,
        eligibleCount: withPulls.filter((item) => item.eligible).length,
        blockedCount: withPulls.filter(
          (item) => !item.eligible && !isMergedItem(item),
        ).length,
        mergedCount: withPulls.filter(isMergedItem).length,
        serviceCount: new Set(
          withPulls
            .map((item) => item.repository)
            .filter((repository): repository is string => Boolean(repository)),
        ).size,
      }
    })
    .sort((left, right) => left.issue.key.localeCompare(right.issue.key))
}

export function ticketMatchesFilter(
  ticket: ReleaseTicket,
  filter: TicketFilter,
) {
  switch (filter) {
    case 'all':
      return true
    case 'blocked':
      return ticket.readiness === 'blocked'
    case 'not-merge-ready':
      return (
        ticket.readiness === 'blocked' || ticket.readiness === 'pending'
      )
    case 'unmatched':
      return ticket.readiness === 'unmatched'
    case 'merged':
      return ticket.readiness === 'merged'
  }
}

/** Sentinel for filtering tickets with no Jira assignee. */
export const UNASSIGNED_ASSIGNEE = '__unassigned__'

export function listTicketAssignees(tickets: ReleaseTicket[]): string[] {
  const names = new Set<string>()
  for (const ticket of tickets) {
    const assignee = ticket.issue.assignee?.trim()
    if (assignee) names.add(assignee)
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

export function ticketMatchesAssignee(
  ticket: ReleaseTicket,
  assigneeFilter: string,
) {
  if (!assigneeFilter) return true
  const assignee = ticket.issue.assignee?.trim()
  if (assigneeFilter === UNASSIGNED_ASSIGNEE) return !assignee
  return assignee === assigneeFilter
}

export function ticketReadinessLabel(readiness: TicketReadiness) {
  switch (readiness) {
    case 'unmatched':
      return 'No matching PR'
    case 'merged':
      return 'Merged'
    case 'ready':
      return 'Ready'
    case 'blocked':
      return 'Blocked'
    case 'pending':
      return 'Not merge-ready'
  }
}

function isClearedMergeItem(item: ReleaseItem) {
  return (
    Boolean(item.pullRequest?.merged) &&
    (item.pullRequest?.baseBranch === 'dev' ||
      item.pullRequest?.baseBranch === 'main')
  )
}

/** Optimistically drop a Jira issue from the in-memory release dashboard. */
export function removeIssueFromDashboard(
  dashboard: ReleaseDashboard,
  issueKey: string,
): ReleaseDashboard {
  const key = issueKey.toUpperCase()
  const hadIssue =
    dashboard.unmatched.some((item) => item.issue.key.toUpperCase() === key) ||
    dashboard.services.some((service) =>
      service.items.some((item) => item.issue.key.toUpperCase() === key),
    )
  if (!hadIssue) return dashboard

  const services = dashboard.services
    .map((service) => {
      const items = service.items.filter(
        (item) => item.issue.key.toUpperCase() !== key,
      )
      if (items.length === service.items.length) return service
      return {
        ...service,
        items,
        eligibleCount: items.filter((item) => item.eligible).length,
        blockedCount: items.filter(
          (item) => !item.eligible && !item.pullRequest?.merged,
        ).length,
        mergedCount: items.filter(isClearedMergeItem).length,
      }
    })
    .filter((service) => service.items.length > 0)

  return {
    ...dashboard,
    services,
    unmatched: dashboard.unmatched.filter(
      (item) => item.issue.key.toUpperCase() !== key,
    ),
    version: {
      ...dashboard.version,
      issueCount: Math.max(0, (dashboard.version.issueCount ?? 0) - 1),
    },
    cached: false,
  }
}

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
  if (withPulls.some((item) => item.eligible)) return 'ready'
  if (
    withPulls.some(
      (item) =>
        !isMergedItem(item) &&
        item.blockingReasons.some((reason) => HARD_BLOCKERS.includes(reason)),
    )
  ) {
    return 'blocked'
  }
  return 'pending'
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

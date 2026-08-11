import { describe, expect, it } from 'vitest'
import type { ReleaseDashboard, ReleaseItem } from '../../shared/types'
import {
  groupReleaseTickets,
  listTicketAssignees,
  ticketMatchesAssignee,
  ticketMatchesFilter,
  ticketReadiness,
  UNASSIGNED_ASSIGNEE,
} from './releaseTickets'

function item(
  key: string,
  overrides: Partial<ReleaseItem> & {
    pull?: Partial<NonNullable<ReleaseItem['pullRequest']>> | null
  } = {},
): ReleaseItem {
  const { pull, ...rest } = overrides
  return {
    issue: {
      key,
      summary: `${key} summary`,
      status: 'In Progress',
      url: `https://jira.test/${key}`,
    },
    eligible: false,
    blockingReasons: ['REVIEW_REQUIRED'],
    warningReasons: [],
    ...(pull === null
      ? {}
      : {
          pullRequest: {
            id: 1,
            number: 8,
            repository: 'orange/service-api',
            title: key,
            url: 'https://github.test/pull/8',
            state: 'open',
            draft: false,
            merged: false,
            baseBranch: 'dev',
            headBranch: `feature/${key}`,
            author: 'dev',
            assignees: [],
            reviewDecision: 'review_required',
            mergeable: true,
            mergeableState: 'clean',
            checks: 'success',
            updatedAt: '2026-07-13T12:00:00Z',
            ...pull,
          },
        }),
    ...rest,
  }
}

const dashboard: ReleaseDashboard = {
  version: {
    id: '10351',
    name: 'OH Release',
    overdue: false,
  },
  services: [
    {
      repository: 'orange/service-api',
      items: [
        item('OH-1', {
          eligible: true,
          blockingReasons: [],
        }),
        item('OH-2', {
          blockingReasons: ['HAS_CONFLICTS'],
        }),
      ],
      eligibleCount: 1,
      blockedCount: 1,
      mergedCount: 0,
      backMergePending: false,
    },
    {
      repository: 'orange/service-web',
      items: [
        item('OH-1', {
          eligible: false,
          blockingReasons: ['ALREADY_MERGED'],
          pull: { id: 2, number: 9, merged: true, repository: 'orange/service-web' },
        }),
        item('OH-3', {
          eligible: false,
          blockingReasons: ['ALREADY_MERGED'],
          pull: { merged: true },
        }),
      ],
      eligibleCount: 0,
      blockedCount: 0,
      mergedCount: 2,
      backMergePending: false,
    },
  ],
  unmatched: [
    item('OH-9', {
      pull: null,
      blockingReasons: ['NO_MATCHING_PR'],
    }),
  ],
  warnings: [],
  fetchedAt: '2026-07-13T12:00:00Z',
  cached: false,
}

describe('groupReleaseTickets', () => {
  it('groups multi-service tickets and unmatched issues', () => {
    const tickets = groupReleaseTickets(dashboard)
    expect(tickets.map((ticket) => ticket.issue.key)).toEqual([
      'OH-1',
      'OH-2',
      'OH-3',
      'OH-9',
    ])
    const multi = tickets.find((ticket) => ticket.issue.key === 'OH-1')
    expect(multi?.serviceCount).toBe(2)
    expect(multi?.items).toHaveLength(2)
    expect(multi?.readiness).toBe('ready')
  })

  it('classifies readiness buckets', () => {
    expect(ticketReadiness([item('OH-A', { pull: null })])).toBe('unmatched')
    expect(
      ticketReadiness([
        item('OH-B', {
          blockingReasons: ['ALREADY_MERGED'],
          pull: { merged: true },
        }),
      ]),
    ).toBe('merged')
    expect(
      ticketReadiness([
        item('OH-C', { eligible: true, blockingReasons: [] }),
      ]),
    ).toBe('ready')
    expect(
      ticketReadiness([
        item('OH-D', { blockingReasons: ['REVIEW_REQUIRED'] }),
      ]),
    ).toBe('blocked')
    expect(
      ticketReadiness([
        item('OH-E', {
          eligible: false,
          blockingReasons: [],
          warningReasons: ['CHECKS_PENDING'],
        }),
      ]),
    ).toBe('pending')
  })

  it('filters ticket lists', () => {
    const tickets = groupReleaseTickets(dashboard)
    expect(
      tickets.filter((ticket) => ticketMatchesFilter(ticket, 'unmatched')),
    ).toHaveLength(1)
    expect(
      tickets.filter((ticket) => ticketMatchesFilter(ticket, 'merged')),
    ).toHaveLength(1)
    expect(
      tickets.filter((ticket) => ticketMatchesFilter(ticket, 'blocked')),
    ).toHaveLength(1)
    expect(
      tickets.filter((ticket) => ticketMatchesFilter(ticket, 'not-merge-ready')),
    ).toHaveLength(1)
  })

  it('lists and filters by Jira assignee', () => {
    const tickets = groupReleaseTickets(dashboard).map((ticket) => {
      if (ticket.issue.key === 'OH-1') {
        return {
          ...ticket,
          issue: { ...ticket.issue, assignee: 'Ada Lovelace' },
        }
      }
      if (ticket.issue.key === 'OH-2') {
        return {
          ...ticket,
          issue: { ...ticket.issue, assignee: 'Grace Hopper' },
        }
      }
      return ticket
    })

    expect(listTicketAssignees(tickets)).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ])
    expect(
      tickets.filter((ticket) =>
        ticketMatchesAssignee(ticket, 'Ada Lovelace'),
      ),
    ).toEqual([expect.objectContaining({ issue: expect.objectContaining({ key: 'OH-1' }) })])
    expect(
      tickets.filter((ticket) =>
        ticketMatchesAssignee(ticket, UNASSIGNED_ASSIGNEE),
      ),
    ).toHaveLength(2)
    expect(
      tickets.every((ticket) => ticketMatchesAssignee(ticket, '')),
    ).toBe(true)
  })
})

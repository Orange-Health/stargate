import { describe, expect, it } from 'vitest'
import { snapshotCounts } from './releaseSnapshots.js'
import type { ReleaseDashboard } from '../../src/shared/types.js'

const dashboard: ReleaseDashboard = {
  version: {
    id: '1',
    name: 'OH Release',
    overdue: false,
    issueCount: 3,
  },
  services: [
    {
      repository: 'Orange-Health/api',
      items: [],
      eligibleCount: 1,
      blockedCount: 1,
      mergedCount: 1,
      backMergePending: false,
    },
  ],
  unmatched: [],
  warnings: [],
  fetchedAt: '2026-08-28T00:00:00.000Z',
  cached: false,
}

describe('snapshotCounts', () => {
  it('rolls up planning totals from a dashboard', () => {
    expect(snapshotCounts(dashboard)).toEqual({
      ticketCount: 3,
      eligibleCount: 1,
      blockedCount: 1,
      mergedCount: 1,
      unmatchedCount: 0,
      serviceCount: 1,
    })
  })
})

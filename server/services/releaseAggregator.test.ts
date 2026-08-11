import { describe, expect, it } from 'vitest'
import type { JiraIssue, PullRequest } from '../../src/shared/types.js'
import {
  evaluateEligibility,
  isClearedMerge,
} from './releaseAggregator.js'

const issue: JiraIssue = {
  key: 'OH-123',
  summary: 'Ship release desk',
  status: 'In Progress',
  url: 'https://orange-health.atlassian.net/browse/OH-123',
}

const readyPull: PullRequest = {
  id: 1,
  number: 42,
  repository: 'orange/release-desk',
  title: 'OH-123 Ship release desk',
  url: 'https://github.com/orange/release-desk/pull/42',
  state: 'open',
  draft: false,
  merged: false,
  baseBranch: 'dev',
  headBranch: 'feature/OH-123',
  author: 'developer',
  assignees: [],
  reviewDecision: 'approved',
  mergeable: true,
  mergeableState: 'clean',
  checks: 'success',
  updatedAt: '2026-07-13T12:00:00Z',
}

describe('evaluateEligibility', () => {
  it('marks an approved conflict-free dev PR as eligible', () => {
    expect(evaluateEligibility(issue, readyPull)).toMatchObject({
      eligible: true,
      blockingReasons: [],
      warningReasons: [],
    })
  })

  it('reports all independent blocking reasons', () => {
    const result = evaluateEligibility(issue, {
      ...readyPull,
      draft: true,
      baseBranch: 'main',
      reviewDecision: 'changes_requested',
      mergeable: false,
      mergeableState: 'dirty',
      checks: 'failure',
    })

    expect(result.eligible).toBe(false)
    expect(result.blockingReasons).toEqual([
      'DRAFT',
      'WRONG_BASE_BRANCH',
      'CHANGES_REQUESTED',
      'HAS_CONFLICTS',
    ])
    expect(result.warningReasons).toEqual(['CHECKS_FAILED'])
  })

  it('reports unresolved comments when approval exists', () => {
    expect(
      evaluateEligibility(issue, {
        ...readyPull,
        reviewDecision: 'approved',
        unresolvedReviewThreads: 2,
        mergeableState: 'blocked',
      }),
    ).toMatchObject({
      eligible: false,
      blockingReasons: ['UNRESOLVED_COMMENTS'],
    })
  })

  it('keeps unmatched tickets visible and blocked', () => {
    expect(evaluateEligibility(issue)).toMatchObject({
      eligible: false,
      blockingReasons: ['NO_MATCHING_PR'],
    })
  })

  it('treats closed unmerged PRs as absent', () => {
    expect(
      evaluateEligibility(issue, {
        ...readyPull,
        state: 'closed',
      }),
    ).toMatchObject({
      pullRequest: undefined,
      eligible: false,
      blockingReasons: ['NO_MATCHING_PR'],
    })
  })
})

describe('isClearedMerge', () => {
  it('clears release PRs merged into dev or main', () => {
    expect(
      isClearedMerge({ ...readyPull, state: 'closed', merged: true }),
    ).toBe(true)
    expect(
      isClearedMerge({ ...readyPull, merged: true, baseBranch: 'main' }),
    ).toBe(true)
  })

  it('does not clear unmerged PRs or PRs merged into other branches', () => {
    expect(isClearedMerge(readyPull)).toBe(false)
    expect(
      isClearedMerge({ ...readyPull, merged: true, baseBranch: 'release' }),
    ).toBe(false)
  })
})

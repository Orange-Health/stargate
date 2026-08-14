import { describe, expect, it } from 'vitest'
import type {
  DeploymentFreshness,
  ReleaseControlRoomState,
  ServiceRelease,
} from '../../shared/types'
import type { ReleaseTicket } from './releaseTickets'
import {
  computeControlRoomProgress,
  computeReleaseProgress,
  completedProgressStepIds,
  isStepComplete,
  newlyCompletedProgressStepIds,
  progressRatio,
  readStoredReleaseProgress,
  releaseProgressDate,
  releaseProgressSteps,
  serviceTagIsDeployed,
  writeStoredReleaseProgress,
} from './releaseProgress'

function ticket(
  key: string,
  readiness: ReleaseTicket['readiness'],
): ReleaseTicket {
  return {
    issue: {
      key,
      summary: key,
      status: 'In Progress',
      url: `https://jira.test/${key}`,
    },
    items: [],
    readiness,
    eligibleCount: 0,
    blockedCount: readiness === 'blocked' ? 1 : 0,
    mergedCount: readiness === 'merged' ? 1 : 0,
    serviceCount: readiness === 'unmatched' ? 0 : 1,
  }
}

function service(repository: string, merged: boolean): ServiceRelease {
  return {
    repository,
    eligibleCount: merged ? 0 : 1,
    blockedCount: merged ? 0 : 1,
    mergedCount: merged ? 1 : 0,
    backMergePending: false,
    items: [
      {
        issue: {
          key: merged ? 'OH-3' : 'OH-1',
          summary: repository,
          status: 'In Progress',
          url: 'https://jira.test/OH-1',
        },
        pullRequest: {
          id: 1,
          number: 8,
          repository,
          title: repository,
          url: 'https://github.test/pull/8',
          state: merged ? 'closed' : 'open',
          draft: false,
          merged,
          baseBranch: 'dev',
          headBranch: 'feature/x',
          author: 'dev',
          assignees: [],
          reviewDecision: merged ? 'approved' : 'review_required',
          mergeable: true,
          mergeableState: 'clean',
          checks: 'success',
          updatedAt: '2026-08-14T10:00:00Z',
        },
        eligible: merged,
        blockingReasons: merged ? ['ALREADY_MERGED'] : ['REVIEW_REQUIRED'],
        warningReasons: [],
      },
    ],
  }
}

function freshness(
  repository: string,
  overrides: Partial<DeploymentFreshness> = {},
): DeploymentFreshness {
  return {
    repository,
    liveQaTags: [],
    jenkinsServices: ['svc'],
    outdated: false,
    checkFailed: false,
    ...overrides,
  }
}

describe('releaseProgress', () => {
  it('uses a valid release date and falls back to today', () => {
    expect(releaseProgressDate('2026-08-27')).toBe('2026-08-27')
    expect(releaseProgressDate('27 Aug 2026', new Date('2026-08-14T00:00:00'))).toBe(
      '2026-08-14',
    )
  })

  it('counts compatible tickets, merged PRs, created tags, and QA deploys', () => {
    const snapshot = computeReleaseProgress({
      versionId: '10351',
      tickets: [
        ticket('OH-1', 'blocked'),
        ticket('OH-2', 'unmatched'),
        ticket('OH-3', 'merged'),
      ],
      mergedIssueCount: 1,
      issueCount: 3,
      services: [
        service('orange/service-api', true),
        service('orange/bifrost', false),
      ],
      stagingTags: {
        'orange/service-api': ['v-qa-26.0827.1'],
        'orange/bifrost': [],
      },
      freshness: {
        'orange/service-api': freshness('orange/service-api', {
          latestBuiltQaTag: 'v-qa-26.0827.1',
          liveQaTags: ['v-qa-26.0827.1'],
        }),
        'orange/bifrost': freshness('orange/bifrost'),
      },
      now: '2026-08-14T10:00:00Z',
    })

    expect(snapshot.ticketsFinalised).toEqual({ current: 2, total: 3 })
    expect(snapshot.prsMerged).toEqual({ current: 1, total: 3 })
    expect(snapshot.tagsCreated).toEqual({ current: 1, total: 2 })
    expect(snapshot.deployedOnQa).toEqual({ current: 1, total: 1 })
    expect(snapshot.pendingRepositories).toEqual({
      prsMerged: ['orange/bifrost'],
      tagsCreated: ['orange/bifrost'],
      deployedOnQa: [],
    })
    expect(releaseProgressSteps(snapshot).map((step) => step.label)).toEqual([
      'Tickets finalised',
      "PR's merged",
      'Tags created',
      'Deployed on QA',
    ])
    expect(isStepComplete(snapshot.deployedOnQa)).toBe(true)
    expect(progressRatio(snapshot.prsMerged)).toBeCloseTo(1 / 3)
  })

  it('treats a created tag as deployed when it is live on QA', () => {
    expect(
      serviceTagIsDeployed(
        'orange/service-api',
        { 'orange/service-api': ['v-qa-26.0827.1'] },
        {
          'orange/service-api': freshness('orange/service-api', {
            liveQaTags: ['v-qa-26.0827.1'],
          }),
        },
      ),
    ).toBe(true)
    expect(
      serviceTagIsDeployed(
        'orange/service-api',
        { 'orange/service-api': ['v-qa-26.0827.1'] },
        {
          'orange/service-api': freshness('orange/service-api', {
            latestBuiltQaTag: 'v-qa-26.0827.1',
            outdated: true,
            liveQaTags: ['v-qa-26.0716.1'],
          }),
        },
      ),
    ).toBe(false)
  })

  it('persists and restores a snapshot for the release version', () => {
    const storage = new Map<string, string>()
    const snapshot = computeReleaseProgress({
      versionId: '10351',
      tickets: [ticket('OH-1', 'ready')],
      mergedIssueCount: 0,
      issueCount: 1,
      services: [service('orange/service-api', false)],
      stagingTags: { 'orange/service-api': ['v-qa-26.0827.1'] },
      freshness: {},
      now: '2026-08-14T10:00:00Z',
    })
    writeStoredReleaseProgress(snapshot, {
      setItem: (key, value) => storage.set(key, value),
    })
    expect(
      readStoredReleaseProgress('10351', {
        getItem: (key) => storage.get(key) ?? null,
      }),
    ).toEqual(snapshot)
    expect(
      readStoredReleaseProgress('other', {
        getItem: (key) => storage.get(key) ?? null,
      }),
    ).toBeUndefined()
  })

  it('detects newly completed steps after the first snapshot', () => {
    const pending = computeReleaseProgress({
      versionId: '10351',
      tickets: [ticket('OH-1', 'blocked')],
      mergedIssueCount: 0,
      issueCount: 1,
      services: [service('orange/service-api', false)],
      stagingTags: {},
      freshness: {},
      now: '2026-08-14T10:00:00Z',
    })
    const merged = computeReleaseProgress({
      versionId: '10351',
      tickets: [ticket('OH-1', 'merged')],
      mergedIssueCount: 1,
      issueCount: 1,
      services: [service('orange/service-api', true)],
      stagingTags: {},
      freshness: {},
      now: '2026-08-14T10:00:01Z',
    })
    expect(
      newlyCompletedProgressStepIds(null, completedProgressStepIds(pending)),
    ).toEqual([])
    expect(
      newlyCompletedProgressStepIds(
        completedProgressStepIds(pending),
        completedProgressStepIds(merged),
      ),
    ).toEqual(['prs-merged'])
  })
})

function controlRoomState(
  repository: string,
  lastHopState: 'up_to_date' | 'needs_pr' | 'pr_open',
  extras: Partial<ReleaseControlRoomState> = {},
): ReleaseControlRoomState {
  return {
    repository,
    defaultBranch: 'main',
    productionReleases: [],
    deployedTags: [],
    deploymentLookupFailed: false,
    productionReady: lastHopState === 'up_to_date',
    promotionSteps: [
      {
        route: 'dev-to-release',
        fromBranch: 'dev',
        toBranch: 'release',
        commitsAhead: 0,
        commitsBehind: 0,
        state: 'up_to_date',
      },
      {
        route: 'release-to-default',
        fromBranch: 'release',
        toBranch: 'main',
        commitsAhead: lastHopState === 'up_to_date' ? 0 : 1,
        commitsBehind: 0,
        state: lastHopState,
      },
    ],
    jenkinsServices: [repository.split('/').at(-1) ?? repository],
    fetchedAt: '2026-08-14T10:00:00Z',
    ...extras,
  }
}

describe('computeControlRoomProgress', () => {
  const apiRepo = 'Orange-Health/service-api'
  const webRepo = 'Orange-Health/service-web'

  it('counts last-hop merges, production tags, and prod deploys for selected repos', () => {
    const snapshot = computeControlRoomProgress({
      versionId: 'release-1:control-room',
      tickets: [ticket('OH-1', 'merged'), ticket('OH-2', 'unmatched')],
      selectedRepositories: [apiRepo, webRepo],
      lastHop: 'release-to-default',
      states: {
        [apiRepo]: controlRoomState(apiRepo, 'up_to_date', {
          productionReleases: [
            {
              id: 1,
              tag: 'v-26.0716.1',
              url: 'https://github.test/releases/v-26.0716.1',
              createdAt: '2026-07-16T09:00:00Z',
              buildStatus: 'succeeded',
              runs: [],
            },
          ],
          deployedTags: [
            {
              service: 'service-api',
              tag: 'v-26.0716.1',
              environment: 'production',
              status: 'succeeded',
              buildNumber: 9,
              buildUrl: 'https://jenkins.test/9',
              deployedAt: '2026-07-16T10:00:00Z',
            },
          ],
        }),
        [webRepo]: controlRoomState(webRepo, 'needs_pr'),
      },
      productionReleases: {
        [apiRepo]: {
          tag: 'v-26.0716.1',
          createdAt: '2026-07-16T09:00:00Z',
        },
      },
      releaseDate: '2026-07-16',
      now: '2026-07-16T12:00:00Z',
    })

    expect(snapshot.ticketsFinalised).toEqual({ current: 1, total: 2 })
    expect(snapshot.prsMerged).toEqual({ current: 1, total: 2 })
    expect(snapshot.tagsCreated).toEqual({ current: 1, total: 2 })
    expect(snapshot.deployedOnQa).toEqual({ current: 1, total: 1 })
    expect(snapshot.pendingRepositories).toEqual({
      prsMerged: [webRepo],
      tagsCreated: [webRepo],
      deployedOnQa: [],
    })
    expect(snapshot.deployedLabel).toBe('Deployed to prod')
    expect(releaseProgressSteps(snapshot).at(-1)?.label).toBe(
      'Deployed to prod',
    )
  })

  it('lists tagged repos that are not live on production as remaining deploys', () => {
    const snapshot = computeControlRoomProgress({
      versionId: 'release-1:control-room',
      tickets: [ticket('OH-1', 'merged')],
      selectedRepositories: [apiRepo],
      lastHop: 'release-to-default',
      states: {
        [apiRepo]: controlRoomState(apiRepo, 'up_to_date', {
          productionReleases: [
            {
              id: 1,
              tag: 'v-26.0716.1',
              url: 'https://github.test/releases/v-26.0716.1',
              createdAt: '2026-07-16T09:00:00Z',
              buildStatus: 'succeeded',
              runs: [],
            },
          ],
          deployedTags: [],
        }),
      },
      productionReleases: {
        [apiRepo]: {
          tag: 'v-26.0716.1',
          createdAt: '2026-07-16T09:00:00Z',
        },
      },
      releaseDate: '2026-07-16',
    })

    expect(snapshot.tagsCreated).toEqual({ current: 1, total: 1 })
    expect(snapshot.deployedOnQa).toEqual({ current: 0, total: 1 })
    expect(snapshot.pendingRepositories.deployedOnQa).toEqual([apiRepo])
  })

  it('ignores canceled production tags', () => {
    const snapshot = computeControlRoomProgress({
      versionId: 'release-1:control-room',
      tickets: [],
      selectedRepositories: [apiRepo],
      lastHop: 'release-to-default',
      states: {
        [apiRepo]: controlRoomState(apiRepo, 'up_to_date', {
          productionReleases: [
            {
              id: 1,
              tag: 'v-26.0716.1',
              url: 'https://github.test/releases/v-26.0716.1',
              createdAt: '2026-07-16T09:00:00Z',
              buildStatus: 'canceled',
              runs: [],
            },
          ],
        }),
      },
      productionReleases: {
        [apiRepo]: {
          tag: 'v-26.0716.1',
          createdAt: '2026-07-16T09:00:00Z',
        },
      },
      releaseDate: '2026-07-16',
    })

    expect(snapshot.tagsCreated).toEqual({ current: 0, total: 1 })
    expect(snapshot.pendingRepositories.tagsCreated).toEqual([apiRepo])
  })
})


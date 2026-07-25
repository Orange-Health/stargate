import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import type {
  PromotionStep,
  ReleaseDashboard,
  RepositoryReleaseState,
} from '../../shared/types'
import {
  ReleaseDayOperations,
  cleanGitHubReleaseDescription,
  developersForReleaseService,
  latestProductionReleaseOnDate,
  releaseCreatedOnDate,
  releaseNotesForDashboard,
} from './ReleaseDayOperations'

const repository = 'Orange-Health/service-api'
const dashboard: ReleaseDashboard = {
  version: {
    id: 'release-1',
    name: 'OH Release 26.0716',
    releaseDate: '2026-07-16',
    overdue: false,
    issueCount: 1,
  },
  services: [
    {
      repository,
      items: [],
      eligibleCount: 0,
      blockedCount: 0,
      mergedCount: 1,
      backMergePending: false,
    },
  ],
  unmatched: [],
  warnings: [],
  fetchedAt: '2026-07-16T08:00:00Z',
  cached: false,
}

function promotionStep(
  route: PromotionStep['route'],
  state: PromotionStep['state'],
): PromotionStep {
  const devRoute = route === 'dev-to-release'
  return {
    route,
    fromBranch: devRoute ? 'dev' : 'release',
    toBranch: devRoute ? 'release' : 'main',
    commitsAhead: state === 'up_to_date' ? 0 : 1,
    commitsBehind: 0,
    state,
    pullRequest:
      state === 'pr_open'
        ? {
            number: devRoute ? 12 : 13,
            title: devRoute ? 'Promote dev to release' : 'Promote release to main',
            url: `https://github.test/pull/${devRoute ? 12 : 13}`,
            baseBranch: devRoute ? 'release' : 'main',
            headBranch: devRoute ? 'dev' : 'release',
            draft: false,
            mergeable: true,
            mergeableState: 'clean',
            reviewDecision: 'approved',
            checks: 'success',
          }
        : undefined,
  }
}

function repositoryState(
  devState: PromotionStep['state'],
  defaultState: PromotionStep['state'],
  repositoryName = repository,
): RepositoryReleaseState {
  return {
    repository: repositoryName,
    defaultBranch: 'main',
    stagingReleases: [],
    productionReleases: [],
    deployedTags: [],
    deploymentLookupFailed: false,
    productionReady: defaultState === 'up_to_date',
    promotionSteps: [
      promotionStep('dev-to-release', devState),
      promotionStep('release-to-default', defaultState),
    ],
    backMergeSteps: [],
    pendingBackMerges: [],
    jenkinsServices: ['service-api'],
    fetchedAt: new Date().toISOString(),
  }
}

describe('ReleaseDayOperations', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.spyOn(api, 'refreshRepository').mockResolvedValue()
  })

  afterEach(() => vi.restoreAllMocks())

  it('selects all services from the table header checkbox', async () => {
    const user = userEvent.setup()
    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )
    const selectAll = screen.getByRole('checkbox', {
      name: 'Select all services',
    })
    const serviceCheckbox = screen.getByRole('checkbox', {
      name: `Include ${repository}`,
    })

    expect(selectAll).toBeChecked()
    await user.click(serviceCheckbox)
    expect(selectAll).not.toBeChecked()
    await user.click(selectAll)
    expect(serviceCheckbox).toBeChecked()
  })

  it('shows included avatars immediately and caches the detailed modal', async () => {
    const user = userEvent.setup()
    const service = {
      ...dashboard.services[0],
      items: [101, 102].map((number) => ({
        issue: {
          key: `OH-${number}`,
          summary: `Issue ${number}`,
          status: 'Done',
          url: `https://jira.test/OH-${number}`,
        },
        pullRequest: {
          id: number,
          repository,
          number,
          title: `OH-${number}: feature`,
          url: `https://github.test/pull/${number}`,
          state: 'closed' as const,
          draft: false,
          merged: true,
          baseBranch: 'dev',
          headBranch: `feature-${number}`,
          author: 'alice',
          assignees: [],
          reviewDecision: 'approved' as const,
          mergeable: true,
          mergeableState: 'clean',
          checks: 'success' as const,
          updatedAt: '2026-07-16T08:00:00Z',
          participants: [
            {
              login: 'alice',
              avatarUrl: 'https://avatars.test/alice.png',
              role: 'author' as const,
            },
            {
              login: `reviewer-${number}`,
              avatarUrl: `https://avatars.test/reviewer-${number}.png`,
              role: 'reviewer' as const,
            },
          ],
        },
        eligible: false,
        blockingReasons: [],
        warningReasons: [],
      })),
    }
    const developerDashboard = {
      ...dashboard,
      services: [service],
    }

    expect(developersForReleaseService(service)[0]).toMatchObject({
      login: 'alice',
      pullRequests: [101, 102],
    })
    render(
      <ReleaseDayOperations
        dashboard={developerDashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByAltText('alice')).toBeVisible()
    await user.click(
      screen.getByRole('button', { name: 'View Developers' }),
    )

    expect(
      await screen.findByRole('dialog', { name: 'service-api Developers' }),
    ).toBeVisible()
    const aliceRow = screen.getByText('alice').closest('article')
    expect(aliceRow).not.toBeNull()
    expect(within(aliceRow!).getByRole('link', { name: '#101' })).toBeVisible()
    expect(within(aliceRow!).getByRole('link', { name: '#102' })).toBeVisible()
    expect(
      window.localStorage.getItem('release-day-developers:release-1'),
    ).toContain('alice')
  })

  it('allows build refresh only for tags created on the release date', () => {
    expect(
      releaseCreatedOnDate(
        '2026-07-16T23:59:59Z',
        '2026-07-16',
      ),
    ).toBe(true)
    expect(
      releaseCreatedOnDate(
        '2026-07-15T23:59:59Z',
        '2026-07-16',
      ),
    ).toBe(false)
    expect(
      releaseCreatedOnDate(
        '2026-07-17T00:00:00Z',
        '2026-07-16',
      ),
    ).toBe(false)
    expect(
      latestProductionReleaseOnDate(
        [
          {
            id: 3,
            tag: 'v-prod-26.0716.3',
            url: 'https://github.test/releases/3',
            createdAt: '2026-07-16T11:26:05Z',
            buildStatus: 'succeeded',
            runs: [],
          },
          {
            id: 6,
            tag: 'v-prod-26.0716.6',
            url: 'https://github.test/releases/6',
            createdAt: '2026-07-16T13:30:45Z',
            buildStatus: 'succeeded',
            runs: [],
          },
          {
            id: 7,
            tag: 'v-prod-26.0717.1',
            url: 'https://github.test/releases/7',
            createdAt: '2026-07-17T06:00:00Z',
            buildStatus: 'succeeded',
            runs: [],
          },
        ],
        '2026-07-16',
      )?.tag,
    ).toBe('v-prod-26.0716.6')
  })

  it('does not show a saved build from a different release date', () => {
    const saved = {
      id: 90,
      repository,
      tag: 'v-26.0716.1',
      sourceBranch: 'main',
      url: 'https://github.test/releases/90',
      createdAt: '2026-07-16T08:05:00Z',
    }
    const state = {
      ...repositoryState('up_to_date', 'up_to_date'),
      productionReleases: [
        {
          id: saved.id,
          tag: saved.tag,
          url: saved.url,
          createdAt: saved.createdAt,
          buildStatus: 'succeeded' as const,
          runs: [],
        },
      ],
    }
    window.localStorage.setItem(
      'release-day-operations:release-1',
      JSON.stringify({
        versionId: 'release-1',
        operationId: 'operation-1',
        releaseDate: '2026-06-23',
        startedAt: '2026-06-23T08:00:00Z',
        selectedRepositories: [repository],
        repositories: {
          [repository]: { productionRelease: saved },
        },
        logs: [],
      }),
    )
    window.localStorage.setItem(
      'release-day-repository-states:release-1',
      JSON.stringify({
        cachedAt: Date.now(),
        states: { [repository]: state },
      }),
    )

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Not created')).toBeVisible()
    expect(screen.queryByText('Build succeeded')).not.toBeInTheDocument()
    expect(screen.queryByText(saved.tag)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled()
  })

  it('offers a new production tag when default is ahead of the latest tag', async () => {
    const user = userEvent.setup()
    const existing = {
      id: 92,
      repository,
      tag: 'v26.0716.1',
      sourceBranch: 'main',
      url: 'https://github.test/releases/92',
      createdAt: '2026-07-16T08:05:00Z',
    }
    const created = {
      id: 93,
      repository,
      tag: 'v26.0716.2',
      sourceBranch: 'main',
      url: 'https://github.test/releases/93',
      createdAt: '2026-07-16T10:00:00Z',
    }
    let state: RepositoryReleaseState = {
      ...repositoryState('up_to_date', 'up_to_date'),
      productionReleases: [
        {
          id: existing.id,
          tag: existing.tag,
          url: existing.url,
          createdAt: existing.createdAt,
          buildStatus: 'succeeded',
          runs: [],
        },
      ],
      latestProductionTagDelta: {
        tag: existing.tag,
        commitsAhead: 2,
        filesChanged: 3,
        hasSourceChanges: true,
      },
    }
    window.localStorage.setItem(
      'release-day-operations:release-1',
      JSON.stringify({
        versionId: 'release-1',
        operationId: 'operation-ahead',
        releaseDate: '2026-07-16',
        startedAt: '2026-07-16T08:00:00Z',
        selectedRepositories: [repository],
        repositories: {
          [repository]: { productionRelease: existing },
        },
        logs: [],
      }),
    )
    window.localStorage.setItem(
      'release-day-repository-states:release-1',
      JSON.stringify({
        cachedAt: Date.now(),
        states: { [repository]: state },
      }),
    )
    vi.spyOn(api, 'repositoryState').mockImplementation(async () => state)
    const createRelease = vi
      .spyOn(api, 'createProductionRelease')
      .mockImplementation(async () => {
        state = {
          ...state,
          productionReleases: [
            {
              id: created.id,
              tag: created.tag,
              url: created.url,
              createdAt: created.createdAt,
              buildStatus: 'starting',
              runs: [],
            },
            ...state.productionReleases,
          ],
          latestProductionTagDelta: {
            tag: created.tag,
            commitsAhead: 0,
            filesChanged: 0,
            hasSourceChanges: false,
          },
        }
        return created
      })

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )

    expect(
      screen.getByText(/main is 2 commits ahead of v26\.0716\.1/),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: '+ Create tag' }))

    await waitFor(() =>
      expect(createRelease).toHaveBeenCalledWith({
        repository,
        date: '2026-07-16',
      }),
    )
    expect(
      await screen.findByText(`Created ${created.tag} from main.`),
    ).toBeVisible()
    expect(createRelease.mock.calls[0][0]).not.toHaveProperty('operationId')
  })

  it('allows a new production release when the saved build was canceled', async () => {
    const user = userEvent.setup()
    const canceled = {
      id: 91,
      repository,
      tag: 'v-26.0716.1',
      sourceBranch: 'main',
      url: 'https://github.test/releases/91',
      createdAt: '2026-07-16T08:05:00Z',
    }
    const state = {
      ...repositoryState('up_to_date', 'up_to_date'),
      productionReleases: [
        {
          id: canceled.id,
          tag: canceled.tag,
          url: canceled.url,
          createdAt: canceled.createdAt,
          buildStatus: 'canceled' as const,
          runs: [],
        },
      ],
    }
    window.localStorage.setItem(
      'release-day-operations:release-1',
      JSON.stringify({
        versionId: 'release-1',
        operationId: 'operation-1',
        releaseDate: '2026-07-16',
        startedAt: '2026-07-16T08:00:00Z',
        selectedRepositories: [repository],
        repositories: {
          [repository]: { productionRelease: canceled },
        },
        logs: [],
      }),
    )
    window.localStorage.setItem(
      'release-day-repository-states:release-1',
      JSON.stringify({
        cachedAt: Date.now(),
        states: { [repository]: state },
      }),
    )
    const replacement = {
      ...canceled,
      id: 92,
      tag: 'v-26.0716.2',
      url: 'https://github.test/releases/92',
      createdAt: '2026-07-16T08:10:00Z',
    }
    const createRelease = vi
      .spyOn(api, 'createProductionRelease')
      .mockResolvedValue(replacement)

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Not created')).toBeVisible()
    expect(screen.queryByText('Build succeeded')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '+ Create tag' }))

    await waitFor(() =>
      expect(createRelease).toHaveBeenCalledWith({
        repository,
        date: '2026-07-16',
        operationId: 'operation-1',
      }),
    )
    expect(
      await screen.findByRole('link', { name: `${replacement.tag} ↗` }),
    ).toBeVisible()
  })

  it('copies rich Slack notes and ignores back-merge bot PRs', async () => {
    const user = userEvent.setup()
    const write = vi.fn().mockResolvedValue(undefined)
    class TestClipboardItem {
      readonly types: string[]
      private readonly items: Record<string, Blob>
      constructor(items: Record<string, Blob>) {
        this.items = items
        this.types = Object.keys(items)
      }
      async getType(type: string) {
        return this.items[type]
      }
    }
    vi.stubGlobal('ClipboardItem', TestClipboardItem)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText: vi.fn() },
    })
    expect(
      cleanGitHubReleaseDescription(`<!-- release-desk-operation:operation-id -->

## What's Changed
* Upgrade to Django 5.2 by @rdvs in https://github.com/Orange-Health/accounts/pull/1090
* Backport master -> release (backmerging through bot) by @devopsautomation-oh in https://github.com/Orange-Health/accounts/pull/1103
* OH-3978 enhance feedback by @pi-prakhar in https://github.com/Orange-Health/accounts/pull/1105`),
    ).toBe(`## What's Changed
* Upgrade to Django 5.2 by @rdvs in https://github.com/Orange-Health/accounts/pull/1090
* OH-3978 enhance feedback by @pi-prakhar in https://github.com/Orange-Health/accounts/pull/1105`)

    const productionRelease = {
      id: 96,
      tag: 'v-26.0716.1',
      url: 'https://github.test/releases/96',
      createdAt: '2026-07-16T13:30:45Z',
      description: `## What's Changed
* Real feature by @alice in https://github.com/Orange-Health/service-api/pull/101
* Backport release -> dev (backmerging through bot) by @devopsautomation-oh in https://github.com/Orange-Health/service-api/pull/102`,
      buildStatus: 'succeeded' as const,
      runs: [],
    }
    const notesDashboard = {
      ...dashboard,
      services: [
        {
          ...dashboard.services[0],
          items: [
            {
              issue: {
                key: 'OH-101',
                summary: 'Improve checkout',
                status: 'Done',
                url: 'https://jira.test/OH-101',
              },
              pullRequest: {
                id: 101,
                repository,
                number: 101,
                title: 'OH-101: Improve checkout',
                url: 'https://github.test/pull/101',
                state: 'closed' as const,
                draft: false,
                merged: true,
                baseBranch: 'dev',
                headBranch: 'feature-101',
                author: 'alice',
                assignees: [],
                reviewDecision: 'approved' as const,
                mergeable: true,
                mergeableState: 'clean',
                checks: 'success' as const,
                updatedAt: '2026-07-16T08:00:00Z',
              },
              eligible: false,
              blockingReasons: [],
              warningReasons: [],
            },
            {
              issue: {
                key: 'OH-102',
                summary: 'Bot back-merge',
                status: 'Done',
                url: 'https://jira.test/OH-102',
              },
              pullRequest: {
                id: 102,
                repository,
                number: 102,
                title: 'Backport release -> dev',
                url: 'https://github.test/pull/102',
                state: 'closed' as const,
                draft: false,
                merged: true,
                baseBranch: 'dev',
                headBranch: 'release',
                author: 'devopsautomation-oh',
                assignees: [],
                reviewDecision: 'approved' as const,
                mergeable: true,
                mergeableState: 'clean',
                checks: 'success' as const,
                updatedAt: '2026-07-16T08:00:00Z',
              },
              eligible: false,
              blockingReasons: [],
              warningReasons: [],
            },
          ],
        },
      ],
    }
    vi.spyOn(api, 'releaseHistory').mockResolvedValue({
      repository,
      stagingReleases: [],
      productionReleases: [productionRelease],
    })

    const notes = releaseNotesForDashboard(
      notesDashboard,
      { [repository]: [productionRelease] },
      '2026-07-16',
    )
    expect(notes.slack).toContain(
      '*service-api* : <https://github.test/releases/96|v-26.0716.1>',
    )
    expect(notes.html).toContain(
      '<b>service-api</b>: <a href="https://github.test/releases/96">v-26.0716.1</a>',
    )
    expect(notes.slack).toContain(
      '- <https://jira.test/OH-101|OH-101>: Improve checkout by <https://github.com/alice|@alice> in <https://github.test/pull/101|PR>',
    )
    expect(notes.slack).not.toContain('Real feature by @alice')
    expect(notes.slack).not.toContain('devopsautomation-oh')
    expect(notes.plain).toContain(
      '• OH-101: Improve checkout by @alice (https://github.com/alice)',
    )
    expect(notes.plain).not.toContain('devopsautomation-oh')
    expect(notes.plain).not.toContain('release-desk-operation')

    render(
      <ReleaseDayOperations
        dashboard={notesDashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: /Copy Release Notes/i }),
    )
    await user.click(screen.getByRole('menuitem', { name: 'Slack' }))

    await waitFor(() => expect(write).toHaveBeenCalled())
    const item = write.mock.calls[0][0][0] as ClipboardItem
    expect(item.types).toEqual(
      expect.arrayContaining(['text/plain', 'text/html']),
    )
    expect(
      screen.getByRole('button', { name: /Copied!/i }),
    ).toBeVisible()
  })

  it('waits for manual synchronization and then shows progress', async () => {
    const user = userEvent.setup()
    let resolveState!: (state: RepositoryReleaseState) => void
    vi.spyOn(api, 'repositoryState').mockReturnValue(
      new Promise((resolve) => {
        resolveState = resolve
      }),
    )

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )

    expect(api.repositoryState).not.toHaveBeenCalled()
    expect(screen.getAllByText('Refresh pending')).toHaveLength(2)
    await user.click(
      screen.getByRole('button', { name: '↻ Refresh status' }),
    )
    expect(screen.getAllByText('Checking')).toHaveLength(2)
    expect(
      await screen.findByRole('button', { name: 'Syncing 0/1' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Sync service-api' }),
    ).toHaveTextContent('Syncing…')
    const syncingRow = screen.getByText(repository).closest('tr')
    expect(syncingRow).toHaveClass('sync-in-progress')
    expect(syncingRow).toHaveAttribute('inert')
    expect(syncingRow).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      resolveState(repositoryState('needs_pr', 'needs_pr'))
    })

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '↻ Refresh status' }),
      ).toBeEnabled(),
    )
    expect(screen.getByText('Synced')).toBeVisible()
    expect(syncingRow).not.toHaveClass('sync-in-progress')
    expect(syncingRow).not.toHaveAttribute('inert')
    expect(syncingRow).toHaveAttribute('aria-busy', 'false')
  })

  it('syncs an individual table row and updates it immediately', async () => {
    const user = userEvent.setup()
    let state = repositoryState('needs_pr', 'needs_pr')
    vi.spyOn(api, 'repositoryState').mockImplementation(async () => state)
    const refreshRepository = vi
      .spyOn(api, 'refreshRepository')
      .mockResolvedValue()

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )

    state = repositoryState('up_to_date', 'up_to_date')
    await user.click(screen.getByRole('button', { name: 'Sync service-api' }))

    const row = screen.getByText(repository).closest('tr')
    expect(row).not.toBeNull()
    await waitFor(() =>
      expect(within(row as HTMLElement).getAllByText('Merged')).toHaveLength(2),
    )
    expect(refreshRepository).toHaveBeenCalledWith(repository)
  })

  it('restores repository state from the one-minute local cache', async () => {
    const user = userEvent.setup()
    const repositoryStateRequest = vi
      .spyOn(api, 'repositoryState')
      .mockResolvedValue(repositoryState('up_to_date', 'up_to_date'))
    vi.spyOn(api, 'refreshRepository').mockResolvedValue()
    const firstRender = render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Sync service-api' }))
    await waitFor(() =>
      expect(
        window.localStorage.getItem(
          'release-day-repository-states:release-1',
        ),
      ).not.toBeNull(),
    )
    firstRender.unmount()
    repositoryStateRequest.mockClear()

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getAllByText('Merged')).toHaveLength(2)
    expect(screen.getByText('Synced')).toBeVisible()
    expect(repositoryStateRequest).not.toHaveBeenCalled()
  })

  it('updates each table row as bulk synchronization completes', async () => {
    const user = userEvent.setup()
    const secondRepository = 'Orange-Health/service-web'
    const twoServiceDashboard: ReleaseDashboard = {
      ...dashboard,
      services: [
        dashboard.services[0],
        { ...dashboard.services[0], repository: secondRepository },
      ],
    }
    let resolveSecond!: (state: RepositoryReleaseState) => void
    vi.spyOn(api, 'repositoryState').mockImplementation((repositoryName) =>
      repositoryName === repository
        ? Promise.resolve(
            repositoryState('up_to_date', 'up_to_date', repositoryName),
          )
        : new Promise((resolve) => {
            resolveSecond = resolve
          }),
    )

    render(
      <ReleaseDayOperations
        dashboard={twoServiceDashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: '↻ Refresh status' }),
    )
    await waitFor(() =>
      expect(api.repositoryState).toHaveBeenCalledWith(secondRepository),
    )

    const firstRow = screen.getByText(repository).closest('tr')
    const secondRow = screen.getByText(secondRepository).closest('tr')
    expect(firstRow).not.toBeNull()
    expect(secondRow).not.toBeNull()
    expect(within(firstRow as HTMLElement).getAllByText('Ready')).toHaveLength(2)
    expect(
      within(secondRow as HTMLElement).getAllByText('Checking'),
    ).toHaveLength(2)

    await act(async () => {
      resolveSecond(
        repositoryState('needs_pr', 'needs_pr', secondRepository),
      )
    })
  })

  it('logs existing PRs and unlocks the next phase only after merge', async () => {
    const user = userEvent.setup()
    let state = repositoryState('pr_open', 'needs_pr')
    vi.spyOn(api, 'repositoryState').mockImplementation(async () => state)
    vi.spyOn(api, 'mergePromotionPullRequest').mockImplementation(async () => {
      state = repositoryState('up_to_date', 'needs_pr')
      return { merged: true, message: 'Merged' }
    })
    vi.spyOn(api, 'refreshRepository').mockResolvedValue()

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: '↻ Refresh status' }),
    )
    await screen.findByText('PR #12')

    expect(
      screen.getByRole('button', { name: 'Create PRs' }),
    ).toBeDisabled()
    const devMergeStep = screen
      .getByText('Merge Dev → Release PRs')
      .closest('article')
    expect(devMergeStep).not.toBeNull()
    await user.click(
      within(devMergeStep as HTMLElement).getByRole('button', {
        name: 'Merge ready PRs',
      }),
    )

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Create PRs' }),
      ).toBeEnabled(),
    )
    expect(screen.getByText('Result: merged PR #12 into release.')).toBeVisible()
    expect(api.refreshRepository).toHaveBeenCalledTimes(1)
    expect(api.repositoryState).toHaveBeenCalledTimes(1)
  })

  it('force merges promotion PRs when checks are the only blocker', async () => {
    const user = userEvent.setup()
    const pendingState = repositoryState('pr_open', 'needs_pr')
    pendingState.promotionSteps[0] = {
      ...pendingState.promotionSteps[0],
      pullRequest: {
        ...pendingState.promotionSteps[0].pullRequest!,
        checks: 'pending',
        mergeableState: 'blocked',
      },
    }
    let state = pendingState
    vi.spyOn(api, 'repositoryState').mockImplementation(async () => state)
    const merge = vi
      .spyOn(api, 'mergePromotionPullRequest')
      .mockImplementation(async () => {
        state = repositoryState('up_to_date', 'needs_pr')
        return { merged: true, message: 'Force-merged' }
      })
    vi.spyOn(api, 'refreshRepository').mockResolvedValue()

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: '↻ Refresh status' }),
    )
    await screen.findByText('Checks are pending')

    const devMergeStep = screen
      .getByText('Merge Dev → Release PRs')
      .closest('article')
    await user.click(
      within(devMergeStep as HTMLElement).getByRole('button', {
        name: 'Merge ready PRs',
      }),
    )

    await waitFor(() =>
      expect(merge).toHaveBeenCalledWith({
        repository,
        pullNumber: 12,
        bypassBranchProtection: true,
      }),
    )
    expect(
      screen.getByText(/force-merging with branch-protection bypass/i),
    ).toBeVisible()
  })

  it('creates PRs sequentially and patches state without full reconciliation', async () => {
    const user = userEvent.setup()
    const secondRepository = 'Orange-Health/service-web'
    const twoServiceDashboard: ReleaseDashboard = {
      ...dashboard,
      services: [
        dashboard.services[0],
        {
          ...dashboard.services[0],
          repository: secondRepository,
        },
      ],
    }
    let activeStateRequests = 0
    let maxActiveStateRequests = 0
    const repositoryStateRequest = vi
      .spyOn(api, 'repositoryState')
      .mockImplementation(async (repositoryName) => {
        activeStateRequests += 1
        maxActiveStateRequests = Math.max(
          maxActiveStateRequests,
          activeStateRequests,
        )
        await Promise.resolve()
        activeStateRequests -= 1
        return repositoryState('needs_pr', 'needs_pr', repositoryName)
      })
    let resolveFirst!: () => void
    const firstPending = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const creationOrder: string[] = []
    const create = vi
      .spyOn(api, 'createPromotionPullRequest')
      .mockImplementation(async ({ repository: repositoryName }) => {
        creationOrder.push(repositoryName)
        if (repositoryName === repository) await firstPending
        return {
          number: repositoryName === repository ? 21 : 22,
          title: 'Promote dev to release',
          url: `https://github.test/${repositoryName}/pull`,
          baseBranch: 'release',
          headBranch: 'dev',
          draft: false,
          mergeable: true,
          mergeableState: 'clean',
          reviewDecision: 'approved',
          checks: 'success',
        }
      })

    render(
      <ReleaseDayOperations
        dashboard={twoServiceDashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: '↻ Refresh status' }),
    )
    await waitFor(() => expect(repositoryStateRequest).toHaveBeenCalledTimes(2))
    expect(
      screen.getAllByText('Checking repository promotion and release state.'),
    ).toHaveLength(2)
    const createStep = screen
      .getByText('Create Dev → Release PRs')
      .closest('article')
    expect(createStep).not.toBeNull()
    await user.click(
      within(createStep as HTMLElement).getByRole('button', {
        name: 'Create PRs',
      }),
    )

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(creationOrder).toEqual([repository])
    expect(maxActiveStateRequests).toBe(2)
    expect(screen.getByText('Creating PR')).toBeVisible()
    expect(
      screen.getByText(
        'Discovery: no open dev → release PR in loaded state.',
      ),
    ).toBeVisible()
    expect(
      screen.getByText('Attempting Dev → Release PR creation (1/2).'),
    ).toBeVisible()

    resolveFirst()
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(creationOrder).toEqual([repository, secondRepository])
    await waitFor(() =>
      expect(
        screen.getByText('Attempting Dev → Release PR creation (2/2).'),
      ).toBeVisible(),
    )
    expect(screen.getByText('GitHub created PR #21.')).toBeVisible()
    expect(screen.getByText('GitHub created PR #22.')).toBeVisible()
    expect(repositoryStateRequest).toHaveBeenCalledTimes(2)
  })

  it('refreshes the newest eligible production tag instead of the saved tag', async () => {
    const user = userEvent.setup()
    let state = {
      ...repositoryState('up_to_date', 'up_to_date'),
      productionReady: false,
    }
    const created = {
      id: 91,
      repository,
      tag: 'v26.0716.1',
      sourceBranch: 'main',
      url: 'https://github.test/releases/91',
      createdAt: '2026-07-16T08:05:00Z',
    }
    vi.spyOn(api, 'repositoryState').mockImplementation(async () => state)
    const createRelease = vi
      .spyOn(api, 'createProductionRelease')
      .mockImplementation(async () => {
        state = {
          ...state,
          productionReleases: [
            {
              id: created.id,
              tag: created.tag,
              url: created.url,
              createdAt: created.createdAt,
              buildStatus: 'succeeded',
              runs: [],
            },
          ],
        }
        return created
      })
    const refreshBuild = vi
      .spyOn(api, 'releaseBuildStatuses')
      .mockImplementation(async (releases) =>
        releases.map((release) => ({
          ...release,
          buildStatus: 'succeeded',
          runs: [],
        })),
      )

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: '↻ Refresh status' }),
    )
    await screen.findAllByText('Merged')
    await user.click(
      screen.getByRole('button', { name: '+ Create tag' }),
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled(),
    )
    expect(createRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        repository,
        date: '2026-07-16',
        operationId: expect.any(String),
      }),
    )
    expect(
      screen.getByRole('link', { name: new RegExp(created.tag) }),
    ).toBeVisible()
    const latest = {
      id: 96,
      tag: 'v-prod-26.0716.6',
      url: 'https://github.test/releases/96',
      createdAt: '2026-07-16T13:30:45Z',
      buildStatus: 'succeeded' as const,
      runs: [],
    }
    state = {
      ...state,
      productionReleases: [latest, ...state.productionReleases],
      deployedTags: [
        {
          service: 'service-api',
          tag: latest.tag,
          environment: 'production',
          buildNumber: 2201,
          buildUrl:
            'https://jenkins.test/job/Prod-new-cluster-deployment/2201/',
          deployedAt: '2026-07-16T14:00:00Z',
        },
      ],
    }
    await user.click(
      screen.getByRole('button', { name: '↻ Check latest build' }),
    )
    await waitFor(() =>
      expect(refreshBuild).toHaveBeenCalledWith(
        [
          {
            repository,
            tag: latest.tag,
            createdAt: latest.createdAt,
          },
        ],
        true,
      ),
    )
    expect(
      await screen.findByRole('link', { name: `${latest.tag} ↗` }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Already deployed' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('link', { name: `Live: ${latest.tag} ↗` }),
    ).toBeVisible()
  })

  it('retries a failed production tag from its table cell', async () => {
    const user = userEvent.setup()
    const created = {
      id: 92,
      repository,
      tag: 'v26.0716.2',
      sourceBranch: 'main',
      url: 'https://github.test/releases/92',
      createdAt: '2026-07-16T08:10:00Z',
    }
    vi.spyOn(api, 'repositoryState').mockResolvedValue(
      repositoryState('up_to_date', 'up_to_date'),
    )
    const createRelease = vi
      .spyOn(api, 'createProductionRelease')
      .mockRejectedValueOnce(new Error('GitHub rejected the tag.'))
      .mockResolvedValue(created)

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: '↻ Refresh status' }),
    )
    await screen.findAllByText('Merged')
    await user.click(
      screen.getByRole('button', { name: 'Create releases' }),
    )

    expect(await screen.findByText('Tag creation failed')).toBeVisible()
    expect(screen.getAllByText('GitHub rejected the tag.')).toHaveLength(2)
    const retry = screen.getByRole('button', {
      name: '↻ Retry tag creation',
    })
    await waitFor(() => expect(retry).toBeEnabled())
    await user.click(retry)

    expect(createRelease).toHaveBeenCalledTimes(2)
    expect(
      await screen.findByRole('link', { name: new RegExp(created.tag) }),
    ).toBeVisible()
  })
})

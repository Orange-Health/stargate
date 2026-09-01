import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import type { DeploymentFreshness, ServiceRelease } from '../../shared/types'
import { BulkQaDeployDialog } from './BulkQaDeployDialog'
import {
  deployableQaTargets,
  latestQaTagAlreadyDeployed,
  liveQaIsAtLeast,
  pendingQaDeployTargets,
  servicesWithoutQaBuilds,
} from './deployableQaTargets'

const mergedService: ServiceRelease = {
  repository: 'orange/service-api',
  defaultBranch: 'main',
  eligibleCount: 0,
  blockedCount: 0,
  mergedCount: 1,
  backMergePending: false,
  items: [
    {
      issue: {
        key: 'OH-1',
        summary: 'Merged',
        status: 'Done',
        url: 'https://jira.test/OH-1',
      },
      pullRequest: {
        id: 1,
        number: 8,
        repository: 'orange/service-api',
        title: 'OH-1',
        url: 'https://github.test/pull/8',
        state: 'closed',
        draft: false,
        merged: true,
        baseBranch: 'dev',
        headBranch: 'feature/OH-1',
        author: 'dev',
        assignees: [],
        reviewDecision: 'approved',
        mergeable: null,
        mergeableState: 'unknown',
        checks: 'success',
        updatedAt: '2026-07-16T12:00:00Z',
      },
      eligible: false,
      blockingReasons: ['ALREADY_MERGED'],
      warningReasons: [],
    },
  ],
}

const openService: ServiceRelease = {
  ...mergedService,
  repository: 'orange/service-web',
  mergedCount: 0,
  blockedCount: 1,
  items: [
    {
      ...mergedService.items[0],
      issue: {
        key: 'OH-2',
        summary: 'Open',
        status: 'In Progress',
        url: 'https://jira.test/OH-2',
      },
      pullRequest: {
        ...mergedService.items[0].pullRequest!,
        id: 2,
        number: 9,
        repository: 'orange/service-web',
        merged: false,
        state: 'open',
      },
      eligible: true,
      blockingReasons: [],
    },
  ],
}

const freshness: Record<string, DeploymentFreshness> = {
  'orange/service-api': {
    repository: 'orange/service-api',
    latestBuiltQaTag: 'v-qa-26.0716.1',
    liveQaTags: [],
    jenkinsServices: ['service-api'],
    outdated: true,
    checkFailed: false,
  },
  'orange/service-web': {
    repository: 'orange/service-web',
    latestBuiltQaTag: 'v-qa-26.0716.2',
    liveQaTags: [],
    jenkinsServices: ['service-web'],
    outdated: true,
    checkFailed: false,
  },
}

function mockStatusApis() {
  vi.spyOn(api, 'listStagingTags').mockResolvedValue([
    {
      repository: 'orange/service-api',
      tags: ['v-qa-26.0716.1'],
      checkFailed: false,
    },
    {
      repository: 'orange/service-web',
      tags: [],
      checkFailed: false,
    },
  ])
  vi.spyOn(api, 'repositoryDeploymentStatuses').mockResolvedValue({
    results: [
      {
        repository: 'orange/service-api',
        deployedTags: [],
        deploymentLookupFailed: false,
      },
      {
        repository: 'orange/service-web',
        deployedTags: [],
        deploymentLookupFailed: false,
      },
    ],
    fetchedAt: '2026-07-16T12:00:00Z',
  })
  vi.spyOn(api, 'releaseBuildStatuses').mockResolvedValue([
    {
      repository: 'orange/service-api',
      tag: 'v-qa-26.0716.1',
      createdAt: '2026-07-16T00:00:00Z',
      buildStatus: 'succeeded',
      runs: [],
    },
  ])
}

describe('deployableQaTargets', () => {
  it('only includes release services whose PRs are merged to dev', () => {
    const mergedToMain: ServiceRelease = {
      ...mergedService,
      repository: 'orange/service-billing',
      items: [
        {
          ...mergedService.items[0],
          pullRequest: {
            ...mergedService.items[0].pullRequest!,
            repository: 'orange/service-billing',
            baseBranch: 'main',
          },
        },
      ],
    }
    const freshnessWithBilling: Record<string, DeploymentFreshness> = {
      ...freshness,
      'orange/service-billing': {
        repository: 'orange/service-billing',
        latestBuiltQaTag: 'v-qa-26.0716.3',
        liveQaTags: [],
        jenkinsServices: ['service-billing'],
        outdated: true,
        checkFailed: false,
      },
    }

    expect(
      deployableQaTargets(
        [mergedService, openService, mergedToMain],
        freshnessWithBilling,
      ),
    ).toEqual([
      {
        repository: 'orange/service-api',
        tag: 'v-qa-26.0716.1',
        jenkinsServices: ['service-api'],
      },
    ])
  })

  it('lists release services that do not have a successful QA build', () => {
    expect(
      servicesWithoutQaBuilds(
        [mergedService, openService],
        {
          'orange/service-api': freshness['orange/service-api'],
          'orange/service-web': {
            repository: 'orange/service-web',
            liveQaTags: [],
            jenkinsServices: ['service-web'],
            outdated: false,
            checkFailed: false,
          },
        },
      ),
    ).toEqual([openService])
  })

  it('skips targets whose latest QA tag is already live or currently deploying', () => {
    const targets = deployableQaTargets([mergedService], freshness)
    expect(
      pendingQaDeployTargets(targets, freshness, {
        'orange/service-api': [
          {
            service: 'service-api',
            tag: 'v-qa-26.0716.1',
            environment: 'qa',
            status: 'succeeded',
            buildNumber: 12,
            buildUrl: 'https://jenkins.test/qa/12',
            deployedAt: '2026-07-16T12:00:00Z',
          },
        ],
      }),
    ).toEqual([])
    expect(
      latestQaTagAlreadyDeployed('v-qa-26.0716.1', ['service-api'], [
        {
          service: 'service-api',
          tag: 'v-qa-26.0716.1',
          environment: 'qa',
          status: 'succeeded',
          buildNumber: 12,
          buildUrl: 'https://jenkins.test/qa/12',
          deployedAt: '2026-07-16T12:00:00Z',
        },
      ]),
    ).toBe(true)
  })

  it('does not treat an older QA tag as pending when a newer tag is already live', () => {
    const targets = deployableQaTargets([mergedService], freshness)
    expect(
      latestQaTagAlreadyDeployed('v-qa-26.0716.1', ['service-api'], [
        {
          service: 'service-api',
          tag: 'v-qa-26.0716.2',
          environment: 'qa',
          status: 'succeeded',
          buildNumber: 18,
          buildUrl: 'https://jenkins.test/qa/18',
          deployedAt: '2026-07-16T13:00:00Z',
        },
      ]),
    ).toBe(true)
    expect(liveQaIsAtLeast('v-qa-26.0716.1', ['v-qa-26.0716.2'])).toBe(true)
    expect(
      pendingQaDeployTargets(targets, freshness, {
        'orange/service-api': [
          {
            service: 'service-api',
            tag: 'v-qa-26.0716.2',
            environment: 'qa',
            status: 'succeeded',
            buildNumber: 18,
            buildUrl: 'https://jenkins.test/qa/18',
            deployedAt: '2026-07-16T13:00:00Z',
          },
        ],
      }),
    ).toEqual([])
    expect(
      pendingQaDeployTargets(targets, {
        'orange/service-api': {
          ...freshness['orange/service-api'],
          liveQaTags: ['v-qa-26.0716.2'],
          outdated: true,
        },
      }, {}),
    ).toEqual([])
  })
})

describe('BulkQaDeployDialog', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('queues QA deployments for eligible merged services', async () => {
    const user = userEvent.setup()
    mockStatusApis()
    const triggerDeployment = vi
      .spyOn(api, 'triggerDeployment')
      .mockResolvedValue({
        queueId: 11,
        queueUrl: 'https://jenkins.test/queue/11',
        jobName: 'QA/QA-DEPLOYMENT',
        service: 'service-api',
        tag: 'v-qa-26.0716.1',
        environment: 'qa',
      })

    render(
      <BulkQaDeployDialog
        services={[mergedService, openService]}
        freshness={freshness}
        releaseName="OH Release 26.0716"
        releaseDate="2026-07-16"
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('service-api')).toBeVisible()
    expect(await screen.findByText('Ready', { exact: true })).toBeVisible()
    expect(screen.getByText('1 of 1 selected')).toBeVisible()
    expect(
      screen.getByRole('checkbox', { name: 'Include service-api' }),
    ).toBeChecked()

    await user.click(
      screen.getByRole('button', { name: 'Deploy to QA (1)' }),
    )

    await waitFor(() =>
      expect(triggerDeployment).toHaveBeenCalledWith({
        repository: 'orange/service-api',
        service: 'service-api',
        tag: 'v-qa-26.0716.1',
        environment: 'qa',
      }),
    )
    expect(
      await screen.findByRole('heading', {
        name: 'Queued 1/1 QA deploys',
      }),
    ).toBeVisible()
  })

  it('skips deselected ready services instead of deploying every pending target', async () => {
    const user = userEvent.setup()
    const secondMerged: ServiceRelease = {
      ...mergedService,
      repository: 'orange/service-billing',
      items: [
        {
          ...mergedService.items[0],
          pullRequest: {
            ...mergedService.items[0].pullRequest!,
            id: 3,
            number: 10,
            repository: 'orange/service-billing',
          },
        },
      ],
    }
    vi.spyOn(api, 'listStagingTags').mockResolvedValue([
      {
        repository: 'orange/service-api',
        tags: ['v-qa-26.0716.1'],
        checkFailed: false,
      },
      {
        repository: 'orange/service-billing',
        tags: ['v-qa-26.0716.2'],
        checkFailed: false,
      },
    ])
    vi.spyOn(api, 'repositoryDeploymentStatuses').mockResolvedValue({
      results: [
        {
          repository: 'orange/service-api',
          deployedTags: [],
          deploymentLookupFailed: false,
        },
        {
          repository: 'orange/service-billing',
          deployedTags: [],
          deploymentLookupFailed: false,
        },
      ],
      fetchedAt: '2026-07-16T12:00:00Z',
    })
    vi.spyOn(api, 'releaseBuildStatuses').mockResolvedValue([
      {
        repository: 'orange/service-api',
        tag: 'v-qa-26.0716.1',
        createdAt: '2026-07-16T00:00:00Z',
        buildStatus: 'succeeded',
        runs: [],
      },
      {
        repository: 'orange/service-billing',
        tag: 'v-qa-26.0716.2',
        createdAt: '2026-07-16T00:00:00Z',
        buildStatus: 'succeeded',
        runs: [],
      },
    ])
    const triggerDeployment = vi
      .spyOn(api, 'triggerDeployment')
      .mockImplementation(async ({ service, tag }) => ({
        queueId: 11,
        queueUrl: 'https://jenkins.test/queue/11',
        jobName: 'QA/QA-DEPLOYMENT',
        service,
        tag,
        environment: 'qa' as const,
      }))

    render(
      <BulkQaDeployDialog
        services={[mergedService, secondMerged]}
        freshness={{
          ...freshness,
          'orange/service-billing': {
            repository: 'orange/service-billing',
            latestBuiltQaTag: 'v-qa-26.0716.2',
            liveQaTags: [],
            jenkinsServices: ['service-billing'],
            outdated: true,
            checkFailed: false,
          },
        }}
        releaseName="OH Release 26.0716"
        releaseDate="2026-07-16"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('2 of 2 selected')).toBeVisible()
    await user.click(
      screen.getByRole('checkbox', { name: 'Include service-api' }),
    )
    expect(screen.getByText('1 of 2 selected')).toBeVisible()

    await user.click(
      screen.getByRole('button', { name: 'Deploy to QA (1)' }),
    )

    await waitFor(() => expect(triggerDeployment).toHaveBeenCalledTimes(1))
    expect(triggerDeployment).toHaveBeenCalledWith({
      repository: 'orange/service-billing',
      service: 'service-billing',
      tag: 'v-qa-26.0716.2',
      environment: 'qa',
    })
    expect(
      await screen.findByRole('heading', {
        name: 'Queued 1/1 QA deploys',
      }),
    ).toBeVisible()
  })

  it('shows when the latest QA tag is already deployed', async () => {
    mockStatusApis()
    vi.mocked(api.repositoryDeploymentStatuses).mockResolvedValue({
      results: [
        {
          repository: 'orange/service-api',
          deployedTags: [
            {
              service: 'service-api',
              tag: 'v-qa-26.0716.1',
              environment: 'qa',
              status: 'succeeded',
              buildNumber: 44,
              buildUrl: 'https://jenkins.test/qa/44',
              deployedAt: '2026-07-16T11:00:00Z',
            },
          ],
          deploymentLookupFailed: false,
        },
        {
          repository: 'orange/service-web',
          deployedTags: [],
          deploymentLookupFailed: false,
        },
      ],
      fetchedAt: '2026-07-16T12:00:00Z',
    })

    render(
      <BulkQaDeployDialog
        services={[mergedService, openService]}
        freshness={{
          ...freshness,
          'orange/service-api': {
            ...freshness['orange/service-api'],
            liveQaTags: ['v-qa-26.0716.1'],
            outdated: false,
          },
        }}
        releaseName="OH Release 26.0716"
        releaseDate="2026-07-16"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('Live', { exact: true })).toBeVisible()
    expect(screen.getByText('Already live (1)')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'All services already live' }),
    ).toBeDisabled()
  })

  it('does not mark an older QA tag as ready when a newer tag is already live', async () => {
    mockStatusApis()
    vi.mocked(api.listStagingTags).mockResolvedValue([
      {
        repository: 'orange/service-api',
        tags: ['v-qa-26.0716.1', 'v-qa-26.0716.2'],
        checkFailed: false,
      },
    ])
    vi.mocked(api.repositoryDeploymentStatuses).mockResolvedValue({
      results: [
        {
          repository: 'orange/service-api',
          deployedTags: [
            {
              service: 'service-api',
              tag: 'v-qa-26.0716.2',
              environment: 'qa',
              status: 'succeeded',
              buildNumber: 48,
              buildUrl: 'https://jenkins.test/qa/48',
              deployedAt: '2026-07-16T13:00:00Z',
            },
          ],
          deploymentLookupFailed: false,
        },
      ],
      fetchedAt: '2026-07-16T13:00:00Z',
    })
    vi.mocked(api.releaseBuildStatuses).mockResolvedValue([
      {
        repository: 'orange/service-api',
        tag: 'v-qa-26.0716.2',
        createdAt: '2026-07-16T00:00:00Z',
        buildStatus: 'succeeded',
        runs: [],
      },
    ])

    render(
      <BulkQaDeployDialog
        services={[mergedService]}
        freshness={{
          'orange/service-api': {
            ...freshness['orange/service-api'],
            latestBuiltQaTag: 'v-qa-26.0716.1',
            liveQaTags: ['v-qa-26.0716.2'],
            outdated: true,
          },
        }}
        releaseName="OH Release 26.0716"
        releaseDate="2026-07-16"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('Live', { exact: true })).toBeVisible()
    expect(screen.getByText('Already live (1)')).toBeVisible()
    expect(screen.getByRole('link', { name: 'v-qa-26.0716.2' })).toBeVisible()
    expect(screen.queryByText('Ready', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText(/Ready to deploy/)).not.toBeInTheDocument()
    expect(
      screen.queryByText('QA is on v-qa-26.0716.2'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'All services already live' }),
    ).toBeDisabled()
  })

  it('polls in-progress QA deployments', async () => {
    vi.useFakeTimers()
    mockStatusApis()
    const deploymentStatus = vi
      .mocked(api.repositoryDeploymentStatuses)
      .mockResolvedValueOnce({
        results: [
          {
            repository: 'orange/service-api',
            deployedTags: [
              {
                service: 'service-api',
                tag: 'v-qa-26.0716.1',
                environment: 'qa',
                status: 'running',
                currentStage: 'Deploy',
                buildNumber: 45,
                buildUrl: 'https://jenkins.test/qa/45',
                deployedAt: '2026-07-16T12:00:00Z',
              },
            ],
            deploymentLookupFailed: false,
          },
        ],
        fetchedAt: '2026-07-16T12:00:00Z',
      })
      .mockResolvedValue({
        results: [
          {
            repository: 'orange/service-api',
            deployedTags: [
              {
                service: 'service-api',
                tag: 'v-qa-26.0716.1',
                environment: 'qa',
                status: 'succeeded',
                buildNumber: 45,
                buildUrl: 'https://jenkins.test/qa/45',
                deployedAt: '2026-07-16T12:04:00Z',
              },
            ],
            deploymentLookupFailed: false,
          },
        ],
        fetchedAt: '2026-07-16T12:04:00Z',
      })

    render(
      <BulkQaDeployDialog
        services={[mergedService]}
        freshness={freshness}
        releaseName="OH Release 26.0716"
        releaseDate="2026-07-16"
        onClose={vi.fn()}
      />,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.getByText('Deploying', { exact: true })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Running in QA' })).toBeVisible()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(deploymentStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Live', { exact: true })).toBeVisible()
  })

  it('lists release services that do not have QA builds yet', async () => {
    mockStatusApis()
    vi.mocked(api.listStagingTags).mockResolvedValue([
      {
        repository: 'orange/service-api',
        tags: ['v-qa-26.0716.1'],
        checkFailed: false,
      },
      {
        repository: 'orange/service-web',
        tags: ['v-qa-26.0716.1'],
        checkFailed: false,
      },
    ])
    vi.mocked(api.releaseBuildStatuses).mockResolvedValue([
      {
        repository: 'orange/service-api',
        tag: 'v-qa-26.0716.1',
        createdAt: '2026-07-16T00:00:00Z',
        buildStatus: 'succeeded',
        runs: [],
      },
      {
        repository: 'orange/service-web',
        tag: 'v-qa-26.0716.1',
        createdAt: '2026-07-16T00:00:00Z',
        buildStatus: 'running',
        runs: [],
      },
    ])

    render(
      <BulkQaDeployDialog
        services={[mergedService, openService]}
        freshness={{
          'orange/service-api': freshness['orange/service-api'],
          'orange/service-web': {
            repository: 'orange/service-web',
            liveQaTags: [],
            jenkinsServices: ['service-web'],
            outdated: false,
            checkFailed: false,
          },
        }}
        releaseName="OH Release 26.0716"
        releaseDate="2026-07-16"
        onClose={vi.fn()}
      />,
    )

    expect(
      await screen.findByRole('list', { name: 'Services without QA builds' }),
    ).toBeVisible()
    expect(screen.getByText('No QA builds yet (1)')).toBeVisible()
    expect(await screen.findByText('Building', { exact: true })).toBeVisible()
    expect(
      within(
        screen.getByRole('list', { name: 'Services without QA builds' }),
      ).getByRole('link', { name: 'v-qa-26.0716.1' }),
    ).toBeVisible()
  })

  it('does not mark a failed QA build as ready to deploy', async () => {
    mockStatusApis()
    vi.mocked(api.releaseBuildStatuses).mockResolvedValue([
      {
        repository: 'orange/service-api',
        tag: 'v-qa-26.0716.1',
        createdAt: '2026-07-16T00:00:00Z',
        buildStatus: 'failed',
        runs: [],
      },
    ])

    render(
      <BulkQaDeployDialog
        services={[mergedService]}
        freshness={freshness}
        releaseName="OH Release 26.0716"
        releaseDate="2026-07-16"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('Failed', { exact: true })).toBeVisible()
    expect(screen.getByText('Build failed (1)')).toBeVisible()
    expect(screen.queryByText('Ready', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText(/Ready to deploy/)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'No QA deploys ready' }),
    ).toBeDisabled()
  })

  it('refreshes tags and deployment status on demand', async () => {
    const user = userEvent.setup()
    mockStatusApis()

    render(
      <BulkQaDeployDialog
        services={[mergedService]}
        freshness={freshness}
        releaseName="OH Release 26.0716"
        releaseDate="2026-07-16"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('Ready', { exact: true })).toBeVisible()
    const tags = vi.mocked(api.listStagingTags)
    const deployments = vi.mocked(api.repositoryDeploymentStatuses)
    const initialTags = tags.mock.calls.length
    const initialDeployments = deployments.mock.calls.length

    await user.click(screen.getByRole('button', { name: 'Refresh QA status' }))

    await waitFor(() => {
      expect(tags.mock.calls.length).toBeGreaterThan(initialTags)
      expect(deployments.mock.calls.length).toBeGreaterThan(initialDeployments)
    })
  })
})

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import type { DeploymentFreshness, ServiceRelease } from '../../shared/types'
import {
  BulkQaDeployDialog,
  deployableQaTargets,
} from './BulkQaDeployDialog'

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
})

describe('BulkQaDeployDialog', () => {
  afterEach(() => vi.restoreAllMocks())

  it('queues QA deployments for eligible merged services', async () => {
    const user = userEvent.setup()
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
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('service-api')).toBeVisible()
    expect(screen.queryByText('service-web')).not.toBeInTheDocument()

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
})

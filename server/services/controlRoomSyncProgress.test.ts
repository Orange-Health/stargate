import { describe, expect, it } from 'vitest'
import {
  completeControlRoomSyncProgress,
  createControlRoomSyncProgress,
  getControlRoomSyncProgress,
  publishControlRoomServiceState,
  updateControlRoomProviderProgress,
} from './controlRoomSyncProgress.js'

describe('control-room sync progress', () => {
  it('tracks provider stages and completes repositories independently', () => {
    const progressId = 'progress-service-test'
    const repositories = [
      'Orange-Health/service-api',
      'Orange-Health/service-web',
    ]
    createControlRoomSyncProgress(progressId, repositories)

    updateControlRoomProviderProgress(
      progressId,
      repositories[0],
      'jenkins',
      'failed',
      'Jenkins unavailable.',
      'jenkins-failed',
    )
    updateControlRoomProviderProgress(
      progressId,
      repositories[0],
      'github',
      'succeeded',
      'GitHub ready.',
      'github-ready',
    )
    updateControlRoomProviderProgress(
      progressId,
      repositories[1],
      'github',
      'running',
      'Checking pull requests.',
      'github-metadata',
    )

    const partial = getControlRoomSyncProgress(progressId)
    expect(partial).toMatchObject({ status: 'running', completed: 1, total: 2 })
    expect(partial?.percent).toBeGreaterThan(50)
    expect(partial?.services[0]).toMatchObject({
      status: 'synced',
      stage: 'complete',
      weight: 1,
      github: 'succeeded',
      jenkins: 'failed',
      message: 'Repository synced; Jenkins deployment status is unavailable.',
    })
    expect(partial?.services[1]).toMatchObject({
      status: 'syncing',
      stage: 'github',
      step: 'github-metadata',
      weight: 0.22,
      message: 'Checking pull requests.',
    })

    updateControlRoomProviderProgress(
      progressId,
      repositories[1],
      'jenkins',
      'succeeded',
      'Jenkins ready.',
      'jenkins-ready',
    )
    updateControlRoomProviderProgress(
      progressId,
      repositories[1],
      'github',
      'failed',
      'GitHub rate limited.',
      'github-failed',
    )

    expect(getControlRoomSyncProgress(progressId)).toMatchObject({
      status: 'completed',
      completed: 2,
      percent: 100,
      services: [
        { status: 'synced' },
        { status: 'failed', message: 'GitHub rate limited.' },
      ],
    })
  })

  it('advances the aggregate percent through weighted service steps', () => {
    const progressId = 'progress-weight-test'
    const repositories = [
      'Orange-Health/service-api',
      'Orange-Health/service-web',
    ]
    createControlRoomSyncProgress(progressId, repositories)

    for (const repository of repositories) {
      updateControlRoomProviderProgress(
        progressId,
        repository,
        'jenkins',
        'running',
        'Loading deployment status from Jenkins.',
        'jenkins-loading',
      )
    }
    expect(getControlRoomSyncProgress(progressId)?.percent).toBe(12)

    updateControlRoomProviderProgress(
      progressId,
      repositories[0],
      'github',
      'running',
      'Loading repository metadata and pull requests from GitHub.',
      'github-metadata',
    )
    expect(getControlRoomSyncProgress(progressId)?.percent).toBe(23)

    updateControlRoomProviderProgress(
      progressId,
      repositories[0],
      'github',
      'running',
      'Checking promotion branches and release workflows.',
      'github-branches',
    )
    expect(getControlRoomSyncProgress(progressId)?.percent).toBe(36)

    updateControlRoomProviderProgress(
      progressId,
      repositories[0],
      'github',
      'succeeded',
      'GitHub release and promotion state is ready.',
      'github-ready',
    )
    updateControlRoomProviderProgress(
      progressId,
      repositories[0],
      'jenkins',
      'succeeded',
      'Jenkins deployment status is ready.',
      'jenkins-ready',
    )
    expect(getControlRoomSyncProgress(progressId)?.percent).toBe(56)
    expect(getControlRoomSyncProgress(progressId)?.completed).toBe(1)
  })

  it('forces remaining in-flight services to complete', () => {
    const progressId = 'progress-complete-test'
    createControlRoomSyncProgress(progressId, ['Orange-Health/service-api'])
    updateControlRoomProviderProgress(
      progressId,
      'Orange-Health/service-api',
      'github',
      'running',
      'Still loading GitHub.',
      'github-metadata',
    )

    completeControlRoomSyncProgress(progressId)

    expect(getControlRoomSyncProgress(progressId)).toMatchObject({
      status: 'completed',
      completed: 1,
      percent: 100,
      services: [{ status: 'synced', stage: 'complete', weight: 1 }],
    })
  })

  it('attaches and replaces progressive repository state', () => {
    const progressId = 'progress-state-test'
    const repository = 'Orange-Health/service-api'
    createControlRoomSyncProgress(progressId, [repository])
    updateControlRoomProviderProgress(
      progressId,
      repository,
      'jenkins',
      'succeeded',
      'Deployments load separately.',
      'jenkins-ready',
    )

    const partialState = {
      repository,
      defaultBranch: 'main',
      productionReleases: [],
      deployedTags: [],
      deploymentLookupFailed: false,
      productionReady: false,
      promotionSteps: [],
      jenkinsServices: [],
      fetchedAt: new Date().toISOString(),
      partial: true,
    }
    updateControlRoomProviderProgress(
      progressId,
      repository,
      'github',
      'succeeded',
      'GitHub promotion state is ready.',
      'github-ready',
      partialState,
    )

    expect(getControlRoomSyncProgress(progressId)?.services[0].state).toEqual(
      partialState,
    )

    const enriched = { ...partialState, partial: false }
    publishControlRoomServiceState(
      progressId,
      repository,
      enriched,
      'Release build and tag details are ready.',
    )
    expect(getControlRoomSyncProgress(progressId)?.services[0]).toMatchObject({
      state: enriched,
      message: 'Release build and tag details are ready.',
    })
  })
})

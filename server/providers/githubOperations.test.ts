import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConnectionConfig,
  WorkflowRun,
} from '../../src/shared/types.js'
import {
  aggregateBuildStatus,
  backMergeBranches,
  clearRepositoryCaches,
  getReleaseBuildStatuses,
  getRepositoryReleaseState,
  hasActualMergeConflict,
  promotionBranches,
  releaseTimestamp,
  sortReleasesNewestFirst,
} from './githubOperations.js'

afterEach(() => vi.unstubAllGlobals())

function run(
  status: string,
  conclusion?: string,
): WorkflowRun {
  return {
    id: Math.random(),
    name: 'Build image',
    status,
    conclusion,
    url: 'https://github.test/run',
    startedAt: '2026-07-13T12:00:00Z',
    updatedAt: '2026-07-13T12:01:00Z',
  }
}

describe('aggregateBuildStatus', () => {
  it('reports starting while GitHub has not created a run', () => {
    expect(aggregateBuildStatus([])).toBe('starting')
    expect(aggregateBuildStatus([run('queued')])).toBe('starting')
  })

  it('reports running when any workflow is in progress', () => {
    expect(
      aggregateBuildStatus([
        run('completed', 'success'),
        run('in_progress'),
      ]),
    ).toBe('running')
  })

  it('fails the release when any workflow fails', () => {
    expect(
      aggregateBuildStatus([
        run('completed', 'success'),
        run('completed', 'failure'),
      ]),
    ).toBe('failed')
  })

  it('reports canceled when a workflow is canceled without a failure', () => {
    expect(
      aggregateBuildStatus([
        run('completed', 'success'),
        run('completed', 'cancelled'),
      ]),
    ).toBe('canceled')
  })

  it('succeeds only after all workflows complete successfully', () => {
    expect(
      aggregateBuildStatus([
        run('completed', 'success'),
        run('completed', 'skipped'),
      ]),
    ).toBe('succeeded')
  })
})

describe('promotionBranches', () => {
  it('uses release as the intermediate branch', () => {
    expect(promotionBranches('dev-to-release', 'main')).toEqual({
      fromBranch: 'dev',
      toBranch: 'release',
    })
  })

  it('uses each repository default branch for final promotion', () => {
    expect(promotionBranches('release-to-default', 'master')).toEqual({
      fromBranch: 'release',
      toBranch: 'master',
    })
  })
})

describe('backMergeBranches', () => {
  it('uses the repository default branch when syncing release', () => {
    expect(backMergeBranches('default-to-release', 'master')).toEqual({
      fromBranch: 'master',
      toBranch: 'release',
    })
  })

  it('syncs release changes back to dev', () => {
    expect(backMergeBranches('release-to-dev', 'main')).toEqual({
      fromBranch: 'release',
      toBranch: 'dev',
    })
  })
})

describe('merge conflict classification', () => {
  it('does not treat bypassable branch protection as a conflict', () => {
    expect(hasActualMergeConflict(true, 'blocked')).toBe(false)
  })

  it('detects actual Git merge conflicts', () => {
    expect(hasActualMergeConflict(false, 'dirty')).toBe(true)
  })
})

describe('release ordering', () => {
  it('sorts by publication time and uses it for display', () => {
    const older = {
      tag: 'v-s2-v26.0715.1',
      created_at: '2026-07-15T10:00:00Z',
      published_at: '2026-07-15T10:00:00Z',
    }
    const newlyPublished = {
      tag: 'v-qa-v26.0716.1',
      created_at: '2026-07-15T08:00:00Z',
      published_at: '2026-07-16T06:00:00Z',
    }

    expect(sortReleasesNewestFirst([older, newlyPublished])).toEqual([
      newlyPublished,
      older,
    ])
    expect(releaseTimestamp(newlyPublished)).toBe('2026-07-16T06:00:00Z')
  })

  it('falls back to creation time when publication time is unavailable', () => {
    expect(releaseTimestamp({ created_at: '2026-07-16T06:00:00Z' })).toBe(
      '2026-07-16T06:00:00Z',
    )
  })
})

describe('repository state cache', () => {
  it('coalesces concurrent reads for the same repository', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/repos/Orange-Health/service-api')) {
        return new Response(
          JSON.stringify({
            full_name: 'Orange-Health/service-api',
            default_branch: 'main',
          }),
          { status: 200 },
        )
      }
      if (url.includes('/releases?')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/compare/')) {
        return new Response(
          JSON.stringify({ ahead_by: 0, behind_by: 0 }),
          { status: 200 },
        )
      }
      if (url.includes('/pulls?')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      throw new Error(`Unexpected GitHub request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const config: ConnectionConfig = {
      jiraSite: 'https://jira.test',
      jiraEmail: 'rm@test.com',
      jiraToken: 'jira',
      githubOrg: 'Orange-Health',
      githubToken: 'github',
      jenkinsUrl: 'https://jenkins.test',
      jenkinsUsername: 'rm',
      jenkinsToken: 'jenkins',
    }
    clearRepositoryCaches(config, 'Orange-Health/service-api')

    const [first, second] = await Promise.all([
      getRepositoryReleaseState(config, 'Orange-Health/service-api'),
      getRepositoryReleaseState(config, 'Orange-Health/service-api'),
    ])

    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(12)
    clearRepositoryCaches(config, 'Orange-Health/service-api')
  })
})

describe('release build status polling', () => {
  it('fetches only workflow runs for the requested active tag', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 7,
              name: 'Build image',
              event: 'release',
              head_branch: 'v-26.0715.1',
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://github.test/actions/7',
              run_started_at: '2026-07-15T09:00:00Z',
              updated_at: '2026-07-15T09:02:00Z',
            },
          ],
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const config: ConnectionConfig = {
      jiraSite: 'https://jira.test',
      jiraEmail: 'rm@test.com',
      jiraToken: 'jira',
      githubOrg: 'Orange-Health',
      githubToken: 'github',
      jenkinsUrl: 'https://jenkins.test',
      jenkinsUsername: 'rm',
      jenkinsToken: 'jenkins',
    }

    const [result] = await getReleaseBuildStatuses(config, [
      {
        repository: 'Orange-Health/service-api',
        tag: 'v-26.0715.1',
        createdAt: '2026-07-15T08:59:00Z',
      },
    ])

    expect(result.buildStatus).toBe('succeeded')
    expect(result.runs).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/actions/runs?branch=v-26.0715.1',
    )
    const [cached] = await getReleaseBuildStatuses(config, [
      {
        repository: 'Orange-Health/service-api',
        tag: 'v-26.0715.1',
        createdAt: '2026-07-15T08:59:00Z',
      },
    ])
    expect(cached).toEqual(result)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    clearRepositoryCaches(
      config,
      'Orange-Health/service-api',
      [],
      true,
    )
  })
})

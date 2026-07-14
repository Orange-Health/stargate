import { describe, expect, it } from 'vitest'
import type { WorkflowRun } from '../../src/shared/types.js'
import {
  aggregateBuildStatus,
  hasActualMergeConflict,
  promotionBranches,
} from './githubOperations.js'

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

describe('merge conflict classification', () => {
  it('does not treat bypassable branch protection as a conflict', () => {
    expect(hasActualMergeConflict(true, 'blocked')).toBe(false)
  })

  it('detects actual Git merge conflicts', () => {
    expect(hasActualMergeConflict(false, 'dirty')).toBe(true)
  })
})

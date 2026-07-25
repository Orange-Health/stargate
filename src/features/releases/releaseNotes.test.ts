import { describe, expect, it } from 'vitest'
import type { ReleaseDashboard, TrackedProductionRelease } from '../../shared/types'
import {
  cleanGitHubReleaseDescription,
  isInternalReleaseNoteTitle,
  releaseNotesForDashboard,
} from './releaseNotes'

const sampleDescription = `## What's Changed
* Remove default group_id injection from groups SSO payload by @manascs789 in https://github.com/Orange-Health/accounts/pull/1153
* Dev Cut: Dev -> Release by @shrish789 in https://github.com/Orange-Health/accounts/pull/1111

## New Contributors
* @divinsmathew made their first contribution in https://github.com/Orange-Health/accounts/pull/169

**Full Changelog**: https://github.com/Orange-Health/accounts/compare/v26.0723.1...v26.0723.2`

describe('release notes formatting', () => {
  it('still cleans github descriptions when asked, but does not use them for copy', () => {
    const cleaned = cleanGitHubReleaseDescription(sampleDescription)
    expect(cleaned).toContain(
      'Remove default group_id injection from groups SSO payload by @manascs789',
    )
    expect(cleaned).not.toContain('Full Changelog')
    expect(cleaned).not.toContain('New Contributors')
    expect(cleaned).not.toContain('Dev Cut: Dev -> Release')
  })

  it('recognizes internal release note titles', () => {
    expect(isInternalReleaseNoteTitle('Dev Cut: Dev -> Release')).toBe(true)
    expect(isInternalReleaseNoteTitle('Dev by @shrish789')).toBe(true)
    expect(isInternalReleaseNoteTitle('OH-4509 Group funnel')).toBe(false)
  })

  it('builds slack and plain notes from jira tickets, using github only for tag links', () => {
    const repository = 'Orange-Health/accounts'
    const productionRelease: TrackedProductionRelease = {
      id: 1,
      tag: 'v26.0723.2',
      url: 'https://github.com/Orange-Health/accounts/releases/tag/v26.0723.2',
      createdAt: '2026-07-23T10:00:00Z',
      description: sampleDescription,
      buildStatus: 'succeeded',
      runs: [],
    }
    const dashboard: ReleaseDashboard = {
      version: {
        id: 'release-1',
        name: '23/07/2026',
        releaseDate: '2026-07-23',
        overdue: false,
        issueCount: 2,
      },
      services: [
        {
          repository,
          eligibleCount: 1,
          blockedCount: 0,
          mergedCount: 1,
          backMergePending: false,
          items: [
            {
              issue: {
                key: 'OH-4509',
                summary: 'Group funnel slot pricing',
                status: 'Done',
                url: 'https://jira.test/browse/OH-4509',
              },
              pullRequest: {
                id: 1653,
                repository,
                number: 1653,
                title: 'OH-4509 Group funnel',
                url: 'https://github.com/Orange-Health/accounts/pull/1653',
                state: 'closed',
                draft: false,
                merged: true,
                baseBranch: 'dev',
                headBranch: 'feature',
                author: 'Ankita297',
                assignees: [],
                reviewDecision: 'approved',
                mergeable: true,
                mergeableState: 'clean',
                checks: 'success',
                updatedAt: '2026-07-23T08:00:00Z',
              },
              eligible: false,
              blockingReasons: [],
              warningReasons: [],
            },
            {
              issue: {
                key: 'OH-999',
                summary: 'Bot back-merge',
                status: 'Done',
                url: 'https://jira.test/browse/OH-999',
              },
              pullRequest: {
                id: 999,
                repository,
                number: 999,
                title: 'Backport release -> dev',
                url: 'https://github.com/Orange-Health/accounts/pull/999',
                state: 'closed',
                draft: false,
                merged: true,
                baseBranch: 'dev',
                headBranch: 'release',
                author: 'devopsautomation-oh',
                assignees: [],
                reviewDecision: 'approved',
                mergeable: true,
                mergeableState: 'clean',
                checks: 'success',
                updatedAt: '2026-07-23T08:00:00Z',
              },
              eligible: false,
              blockingReasons: [],
              warningReasons: [],
            },
          ],
        },
      ],
      unmatched: [],
      warnings: [],
      fetchedAt: '2026-07-23T10:00:00Z',
      cached: false,
    }

    const notes = releaseNotesForDashboard(
      dashboard,
      { [repository]: [productionRelease] },
      '2026-07-23',
    )

    expect(notes.slack).toContain(
      '*accounts* : <https://github.com/Orange-Health/accounts/releases/tag/v26.0723.2|v26.0723.2>',
    )
    expect(notes.html).toContain(
      '<b>accounts</b>: <a href="https://github.com/Orange-Health/accounts/releases/tag/v26.0723.2">v26.0723.2</a>',
    )
    expect(notes.slack).toContain(
      '- <https://jira.test/browse/OH-4509|OH-4509>: Group funnel slot pricing by <https://github.com/Ankita297|@Ankita297> in <https://github.com/Orange-Health/accounts/pull/1653|PR>',
    )
    expect(notes.slack).not.toContain('Remove default group_id')
    expect(notes.slack).not.toContain('Full Changelog')
    expect(notes.slack).not.toContain('devopsautomation-oh')
    expect(notes.plain).toContain(
      '• OH-4509: Group funnel slot pricing by @Ankita297 (https://github.com/Ankita297) in https://github.com/Orange-Health/accounts/pull/1653',
    )
    expect(notes.plain).not.toContain('Remove default group_id')
  })
})

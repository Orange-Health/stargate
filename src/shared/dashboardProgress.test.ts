import { describe, expect, it } from 'vitest'
import { dashboardProgressPercent } from './dashboardProgress.js'

describe('dashboardProgressPercent', () => {
  it('maps each phase into a non-overlapping overall range', () => {
    expect(
      dashboardProgressPercent({
        phase: 'starting',
        message: 'Preparing…',
        current: 0,
        total: 1,
      }),
    ).toBe(0)
    expect(
      dashboardProgressPercent({
        phase: 'jira',
        message: 'Loading Jira…',
        current: 0,
        total: 1,
      }),
    ).toBe(5)
    expect(
      dashboardProgressPercent({
        phase: 'jira',
        message: 'Found tickets…',
        current: 1,
        total: 1,
      }),
    ).toBe(15)
    expect(
      dashboardProgressPercent({
        phase: 'github-search',
        message: 'Searching…',
        current: 0,
        total: 4,
      }),
    ).toBe(15)
    expect(
      dashboardProgressPercent({
        phase: 'github-details',
        message: 'Loading pull request details…',
        current: 0,
        total: 5,
      }),
    ).toBe(40)
    expect(
      dashboardProgressPercent({
        phase: 'github-details',
        message: 'Loading pull request details…',
        current: 5,
        total: 5,
      }),
    ).toBe(90)
    expect(
      dashboardProgressPercent({
        phase: 'mapping',
        message: 'Mapped…',
        current: 1,
        total: 1,
      }),
    ).toBe(100)
  })

  it('does not treat in-progress details as complete', () => {
    const percent = dashboardProgressPercent({
      phase: 'github-details',
      message: 'Loading pull request details…',
      current: 1,
      total: 8,
    })
    expect(percent).toBeGreaterThan(40)
    expect(percent).toBeLessThan(90)
  })
})

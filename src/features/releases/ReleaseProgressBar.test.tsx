import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReleaseProgressBar, STEP_CELEBRATION_MS } from './ReleaseProgressBar'
import {
  emptyPendingRepositories,
  type ReleaseProgressSnapshot,
} from './releaseProgress'

function snapshot(
  overrides: Partial<ReleaseProgressSnapshot> = {},
): ReleaseProgressSnapshot {
  return {
    versionId: '10351',
    ticketsFinalised: { current: 1, total: 2 },
    prsMerged: { current: 0, total: 2 },
    tagsCreated: { current: 0, total: 1 },
    deployedOnQa: { current: 0, total: 0 },
    pendingRepositories: emptyPendingRepositories(),
    updatedAt: '2026-08-14T10:00:00Z',
    ...overrides,
  }
}

describe('ReleaseProgressBar celebration', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not celebrate already complete steps on first render', () => {
    render(
      <ReleaseProgressBar
        progress={snapshot({
          ticketsFinalised: { current: 2, total: 2 },
        })}
      />,
    )
    expect(screen.queryByText('You are the best RM')).not.toBeInTheDocument()
  })

  it('shows confetti for 5 seconds when a step becomes complete', async () => {
    vi.useFakeTimers()
    const view = render(<ReleaseProgressBar progress={snapshot()} />)
    expect(screen.queryByText('You are the best RM')).not.toBeInTheDocument()

    view.rerender(
      <ReleaseProgressBar
        progress={snapshot({
          ticketsFinalised: { current: 2, total: 2 },
        })}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('You are the best RM')
    expect(screen.getByRole('status').className).toContain('rm-celebration')
    expect(document.body.contains(screen.getByRole('status'))).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STEP_CELEBRATION_MS)
    })
    expect(screen.queryByText('You are the best RM')).not.toBeInTheDocument()
  })

  it('does not celebrate steps that complete while the bar is still priming', () => {
    const view = render(
      <ReleaseProgressBar progress={snapshot()} ready={false} />,
    )
    view.rerender(
      <ReleaseProgressBar
        progress={snapshot({
          ticketsFinalised: { current: 2, total: 2 },
        })}
        ready={false}
      />,
    )
    view.rerender(
      <ReleaseProgressBar
        progress={snapshot({
          ticketsFinalised: { current: 2, total: 2 },
        })}
        ready
      />,
    )
    expect(screen.queryByText('You are the best RM')).not.toBeInTheDocument()
  })
})

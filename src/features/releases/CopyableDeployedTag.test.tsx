import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CopyableDeployedTag,
  liveProductionTags,
} from './CopyableDeployedTag'

describe('liveProductionTags', () => {
  const deployments = [
    {
      service: 'accounts',
      tag: 'v-s1-26.0713.1',
      environment: 's1' as const,
      buildNumber: 1,
      buildUrl: 'https://jenkins.test/1',
      deployedAt: '2026-07-13T11:30:00Z',
    },
    {
      service: 'accounts',
      tag: 'v26.0713.1',
      environment: 'production' as const,
      status: 'succeeded' as const,
      buildNumber: 2,
      buildUrl: 'https://jenkins.test/2',
      deployedAt: '2026-07-13T12:00:00Z',
    },
    {
      service: 'accounts',
      tag: 'v26.0713.2',
      environment: 'production' as const,
      status: 'running' as const,
      buildNumber: 3,
      buildUrl: 'https://jenkins.test/3',
      deployedAt: '2026-07-13T12:30:00Z',
    },
    {
      service: 'billing',
      tag: 'v26.0712.9',
      environment: 'production' as const,
      buildNumber: 4,
      buildUrl: 'https://jenkins.test/4',
      deployedAt: '2026-07-12T12:00:00Z',
    },
  ]

  it('returns unique succeeded production tags', () => {
    expect(liveProductionTags(deployments)).toEqual([
      'v26.0713.1',
      'v26.0712.9',
    ])
  })

  it('filters succeeded production tags by service', () => {
    expect(liveProductionTags(deployments, 'billing')).toEqual(['v26.0712.9'])
  })
})

describe('CopyableDeployedTag', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('copies the tag to the clipboard', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(<CopyableDeployedTag tag="v26.0713.1" />)

    await user.click(
      screen.getByRole('button', {
        name: 'Copy currently deployed tag v26.0713.1',
      }),
    )

    expect(writeText).toHaveBeenCalledWith('v26.0713.1')
    expect(screen.getByTitle('Copied')).toBeVisible()
    expect(screen.getByText('v26.0713.1').tagName).toBe('CODE')
  })
})

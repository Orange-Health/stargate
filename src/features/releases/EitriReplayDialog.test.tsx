import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import type { EitriBuild } from '../../shared/types'
import { EitriReplayDialog } from './EitriReplayDialog'

const build: EitriBuild = {
  buildNumber: 12,
  buildUrl: 'https://jenkins.test/eitri/12/',
  service: 'accounts',
  namespace: 's2',
  branch: 'deploy/s2',
  commitSha: 'abcdef1',
  stagingEnvUpdateJob: 'DEV/DEV Deployer',
  status: 'succeeded',
  createdAt: '2026-08-12T06:00:00.000Z',
}

afterEach(() => vi.restoreAllMocks())

describe('EitriReplayDialog', () => {
  it('shows parameters and re-triggers the same EITRI build', async () => {
    const user = userEvent.setup()
    const onQueued = vi.fn()
    const onClose = vi.fn()
    const trigger = vi.spyOn(api, 'triggerEitriDeployment').mockResolvedValue({
      queueId: 99,
      queueUrl: 'https://jenkins.test/queue/item/99/',
      jobName: 'DEV/Stag EITRI',
      service: 'accounts',
      namespace: 's2',
      branch: 'deploy/s2',
      commitSha: 'abcdef1',
      stagingEnvUpdateJob: 'DEV/DEV Deployer',
    })

    render(
      <EitriReplayDialog
        repository="Orange-Health/accounts"
        build={build}
        onClose={onClose}
        onQueued={onQueued}
      />,
    )

    expect(screen.getByText('SERVICE_NAME')).toBeInTheDocument()
    expect(screen.getByText('accounts')).toBeInTheDocument()
    expect(screen.getByText('s2')).toBeInTheDocument()
    expect(screen.getByText('deploy/s2')).toBeInTheDocument()
    expect(screen.getByText('abcdef1')).toBeInTheDocument()
    expect(screen.getByText('DEV/DEV Deployer')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Replay build' }))

    expect(trigger).toHaveBeenCalledWith({
      repository: 'Orange-Health/accounts',
      service: 'accounts',
      namespace: 's2',
      branch: 'deploy/s2',
      commitSha: 'abcdef1',
      stagingEnvUpdateJob: 'DEV/DEV Deployer',
    })
    expect(onQueued).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

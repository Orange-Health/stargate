import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import type { TrackedStagingRelease } from '../../shared/types'
import { DeployDialog } from './DeployDialog'

const release: TrackedStagingRelease = {
  id: 1,
  tag: 'v-qa-v26.0713.2',
  environment: 'qa',
  url: 'https://github.test/release/1',
  createdAt: '2026-07-13T12:00:00Z',
  buildStatus: 'succeeded',
  runs: [],
}

afterEach(() => vi.restoreAllMocks())

describe('DeployDialog', () => {
  it('submits the selected Jenkins service, tag, and environment', async () => {
    const user = userEvent.setup()
    const trigger = vi.spyOn(api, 'triggerDeployment').mockResolvedValue({
      queueId: 81,
      queueUrl: 'https://jenkins.test/queue/item/81/',
      buildUrl:
        'https://jenkins.test/job/DEV/job/DEV%20Deployer/2152/',
      jobName: 'DEV/DEV Deployer',
      service: 'clr-web',
      tag: release.tag,
      environment: 's2',
    })
    render(
      <DeployDialog
        repository="Orange-Health/clr"
        release={release}
        services={['clr-api', 'clr-web']}
        onClose={vi.fn()}
      />,
    )

    await user.selectOptions(
      screen.getByLabelText('Jenkins service'),
      'clr-web',
    )
    await user.selectOptions(screen.getByLabelText('Target environment'), 's2')
    expect(screen.getByRole('option', { name: /S6/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Deploy' }))

    expect(trigger).toHaveBeenCalledWith({
      repository: 'Orange-Health/clr',
      service: 'clr-web',
      tag: 'v-qa-v26.0713.2',
      environment: 's2',
    })
    expect(await screen.findByText('Jenkins build queued')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /Open Jenkins build/ }),
    ).toHaveAttribute(
      'href',
      'https://jenkins.test/job/DEV/job/DEV%20Deployer/2152/',
    )
  })
})

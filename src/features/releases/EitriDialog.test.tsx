import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import { EitriDialog } from './EitriDialog'

afterEach(() => vi.restoreAllMocks())

describe('EitriDialog', () => {
  it('submits EITRI parameters with the default staging env update job', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'repositoryBranches').mockResolvedValue([
      'dev',
      'deploy/s1',
      'deploy/s2',
    ])
    const trigger = vi.spyOn(api, 'triggerEitriDeployment').mockResolvedValue({
      queueId: 91,
      queueUrl: 'https://jenkins.test/queue/item/91/',
      buildUrl: 'https://jenkins.test/job/DEV/job/Stag%20EITRI/12/',
      buildNumber: 12,
      jobName: 'DEV/Stag EITRI',
      service: 'accounts',
      namespace: 's2',
      branch: 'deploy/s2',
      stagingEnvUpdateJob: 'DEV/DEV Deployer',
    })

    render(
      <EitriDialog
        repository="Orange-Health/accounts"
        services={['accounts']}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Branch')).toHaveValue('deploy/s1'),
    )
    await user.selectOptions(screen.getByLabelText('Namespace'), 's2')
    await waitFor(() =>
      expect(screen.getByLabelText('Branch')).toHaveValue('deploy/s2'),
    )
    await user.click(screen.getByRole('button', { name: 'Build & deploy' }))

    expect(trigger).toHaveBeenCalledWith({
      repository: 'Orange-Health/accounts',
      service: 'accounts',
      namespace: 's2',
      branch: 'deploy/s2',
      stagingEnvUpdateJob: 'DEV/DEV Deployer',
    })
    expect(await screen.findByText('Jenkins EITRI queued')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /Open Jenkins build/ }),
    ).toHaveAttribute(
      'href',
      'https://jenkins.test/job/DEV/job/Stag%20EITRI/12/',
    )
  })

  it('includes optional commit SHA and keeps a custom branch selection', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'repositoryBranches').mockResolvedValue([
      'dev',
      'deploy/s1',
      'feature/eitri',
    ])
    const trigger = vi.spyOn(api, 'triggerEitriDeployment').mockResolvedValue({
      queueId: 92,
      queueUrl: 'https://jenkins.test/queue/item/92/',
      jobName: 'DEV/Stag EITRI',
      service: 'bifrost-web',
      namespace: 's1',
      branch: 'feature/eitri',
      commitSha: 'abcdef1',
      stagingEnvUpdateJob: 'DEV/DEV Deployer',
    })

    render(
      <EitriDialog
        repository="Orange-Health/bifrost"
        services={['bifrost-web']}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Branch')).toHaveValue('deploy/s1'),
    )
    await user.clear(screen.getByLabelText('Branch'))
    await user.type(screen.getByLabelText('Branch'), 'feature/eitri')
    await user.type(screen.getByLabelText('Commit SHA'), 'abcdef1')
    await user.click(screen.getByRole('button', { name: 'Build & deploy' }))

    expect(trigger).toHaveBeenCalledWith({
      repository: 'Orange-Health/bifrost',
      service: 'bifrost-web',
      namespace: 's1',
      branch: 'feature/eitri',
      commitSha: 'abcdef1',
      stagingEnvUpdateJob: 'DEV/DEV Deployer',
    })
  })
})

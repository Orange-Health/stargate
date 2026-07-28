import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import { StagingReleaseDialog } from './StagingReleaseDialog'

describe('StagingReleaseDialog', () => {
  afterEach(() => vi.restoreAllMocks())

  it('creates an all-services staging release from a selected branch', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'repositoryBranches').mockResolvedValue([
      'dev',
      'feature/OH-42',
      'main',
    ])
    vi.spyOn(api, 'createStagingRelease').mockResolvedValue({
      id: 100,
      repository: 'Orange-Health/service-api',
      environment: 's2',
      tag: 'v-s2-v26.0728.1',
      sourceBranch: 'feature/OH-42',
      url: 'https://github.test/releases/100',
      createdAt: '2026-07-28T10:00:00Z',
    })

    render(
      <StagingReleaseDialog
        repository="Orange-Health/service-api"
        releaseDate=""
        allowBranchSelection
        onClose={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Source branch')).toHaveAttribute(
        'list',
        'staging-source-branches',
      ),
    )
    await user.clear(screen.getByLabelText('Source branch'))
    await user.type(screen.getByLabelText('Source branch'), 'feature/OH-42')
    await user.selectOptions(screen.getByLabelText('Environment'), 's2')
    await user.click(
      screen.getByRole('button', { name: 'Create pre-release' }),
    )

    await waitFor(() =>
      expect(api.createStagingRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: 'Orange-Health/service-api',
          environment: 's2',
          sourceBranch: 'feature/OH-42',
        }),
      ),
    )
    expect(screen.getByText('feature/OH-42')).toBeVisible()
  })
})

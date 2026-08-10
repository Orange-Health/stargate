import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import { BulkQaReleaseDialog } from './BulkQaReleaseDialog'

describe('BulkQaReleaseDialog', () => {
  afterEach(() => vi.restoreAllMocks())

  it('creates QA tags for every service in the release', async () => {
    const user = userEvent.setup()
    const createStagingRelease = vi
      .spyOn(api, 'createStagingRelease')
      .mockImplementation(async ({ repository }) => ({
        id: repository.endsWith('api') ? 1 : 2,
        repository,
        environment: 'qa' as const,
        tag: repository.endsWith('api') ? 'v-qa-26.0716.1' : 'v-qa-26.0716.2',
        sourceBranch: 'dev',
        url: `https://github.test/${repository}/releases`,
        createdAt: '2026-07-16T10:00:00Z',
      }))
    const onClose = vi.fn()

    render(
      <BulkQaReleaseDialog
        repositories={['orange/service-api', 'orange/service-web']}
        releaseDate="2026-07-16"
        releaseName="OH Release 26.0716"
        onClose={onClose}
      />,
    )

    expect(screen.getByText('v-qa-26.0716.N')).toBeVisible()
    expect(screen.getByText('service-api')).toBeVisible()
    expect(screen.getByText('service-web')).toBeVisible()

    await user.click(
      screen.getByRole('button', { name: 'Create QA tags (2)' }),
    )

    await waitFor(() =>
      expect(createStagingRelease).toHaveBeenCalledTimes(2),
    )
    expect(createStagingRelease).toHaveBeenCalledWith({
      repository: 'orange/service-api',
      environment: 'qa',
      date: '2026-07-16',
      sourceBranch: 'dev',
    })
    expect(createStagingRelease).toHaveBeenCalledWith({
      repository: 'orange/service-web',
      environment: 'qa',
      date: '2026-07-16',
      sourceBranch: 'dev',
    })
    expect(
      await screen.findByRole('heading', {
        name: 'Created 2/2 QA tags',
      }),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'v-qa-26.0716.1' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'v-qa-26.0716.2' })).toBeVisible()
  })

  it('keeps going when one service fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'createStagingRelease').mockImplementation(
      async ({ repository }) => {
        if (repository.endsWith('api')) {
          throw new Error('Branch protection blocked the tag.')
        }
        return {
          id: 2,
          repository,
          environment: 'qa' as const,
          tag: 'v-qa-26.0716.1',
          sourceBranch: 'dev',
          url: 'https://github.test/releases/2',
          createdAt: '2026-07-16T10:00:00Z',
        }
      },
    )

    render(
      <BulkQaReleaseDialog
        repositories={['orange/service-api', 'orange/service-web']}
        releaseDate="2026-07-16"
        releaseName="OH Release 26.0716"
        onClose={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole('button', { name: 'Create QA tags (2)' }),
    )

    expect(
      await screen.findByRole('heading', {
        name: 'Created 1/2 QA tags',
      }),
    ).toBeVisible()
    expect(
      screen.getByText('Branch protection blocked the tag.'),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'v-qa-26.0716.1' })).toBeVisible()
  })
})

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import { BulkQaReleaseDialog } from './BulkQaReleaseDialog'

describe('BulkQaReleaseDialog', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows existing release-day tags and creates QA tags for selected services', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'listStagingTags').mockResolvedValue([
      {
        repository: 'orange/service-api',
        tags: ['v-qa-26.0716.1', 'v-qa-26.0716.3'],
        checkFailed: false,
      },
      {
        repository: 'orange/service-web',
        tags: [],
        checkFailed: false,
      },
    ])
    const createStagingRelease = vi
      .spyOn(api, 'createStagingRelease')
      .mockImplementation(async ({ repository }) => ({
        id: repository.endsWith('api') ? 1 : 2,
        repository,
        environment: 'qa' as const,
        tag: repository.endsWith('api') ? 'v-qa-26.0716.2' : 'v-qa-26.0716.1',
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
    expect(
      await screen.findByRole('link', { name: 'v-qa-26.0716.3' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/orange/service-api/releases/tag/v-qa-26.0716.3',
    )
    expect(
      screen.queryByRole('link', { name: 'v-qa-26.0716.1' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('No tags yet'),
    ).toBeVisible()
    expect(screen.getByText('2 of 2 selected')).toBeVisible()

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
    expect(screen.getByRole('link', { name: 'v-qa-26.0716.2' })).toBeVisible()
    expect(
      screen.getAllByRole('link', { name: 'v-qa-26.0716.1' }).length,
    ).toBeGreaterThan(0)
  })

  it('skips deselected services instead of creating tags for every service', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'listStagingTags').mockResolvedValue([
      {
        repository: 'orange/service-api',
        tags: ['v-qa-26.0716.1'],
        checkFailed: false,
      },
      {
        repository: 'orange/service-web',
        tags: [],
        checkFailed: false,
      },
    ])
    const createStagingRelease = vi
      .spyOn(api, 'createStagingRelease')
      .mockResolvedValue({
        id: 2,
        repository: 'orange/service-web',
        environment: 'qa',
        tag: 'v-qa-26.0716.1',
        sourceBranch: 'dev',
        url: 'https://github.test/releases/2',
        createdAt: '2026-07-16T10:00:00Z',
      })

    render(
      <BulkQaReleaseDialog
        repositories={['orange/service-api', 'orange/service-web']}
        releaseDate="2026-07-16"
        releaseName="OH Release 26.0716"
        onClose={vi.fn()}
      />,
    )

    await screen.findByRole('link', { name: 'v-qa-26.0716.1' })
    await user.click(
      screen.getByRole('checkbox', { name: 'Include service-api' }),
    )
    expect(screen.getByText('1 of 2 selected')).toBeVisible()

    await user.click(
      screen.getByRole('button', { name: 'Create QA tags (1)' }),
    )

    await waitFor(() =>
      expect(createStagingRelease).toHaveBeenCalledTimes(1),
    )
    expect(createStagingRelease).toHaveBeenCalledWith({
      repository: 'orange/service-web',
      environment: 'qa',
      date: '2026-07-16',
      sourceBranch: 'dev',
    })
    expect(
      await screen.findByRole('heading', {
        name: 'Created 1/1 QA tags',
      }),
    ).toBeVisible()
    expect(
      screen.queryByRole('checkbox', { name: 'Include service-api' }),
    ).not.toBeInTheDocument()
  })

  it('keeps going when one service fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'listStagingTags').mockResolvedValue([
      {
        repository: 'orange/service-api',
        tags: [],
        checkFailed: false,
      },
      {
        repository: 'orange/service-web',
        tags: [],
        checkFailed: false,
      },
    ])
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

    await screen.findByText('2 of 2 selected')
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

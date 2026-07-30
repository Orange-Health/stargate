import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import { RepositoryPullRequests } from './RepositoryPullRequests'

describe('RepositoryPullRequests', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows pull request skeletons during the initial load', () => {
    vi.spyOn(api, 'repositoryPullRequests').mockReturnValue(new Promise(() => {}))
    vi.spyOn(api, 'repositoryPullRequestAuthors').mockResolvedValue([])

    render(<RepositoryPullRequests repository="Orange-Health/service-api" />)

    expect(
      screen.getByRole('status', { name: 'Loading pull requests' }),
    ).toBeVisible()
    expect(document.querySelectorAll('.skeleton-pr-row')).toHaveLength(4)
  })

  it('filters, paginates, and merges recent pull requests', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'repositoryPullRequests').mockResolvedValue({
      repository: 'Orange-Health/service-api',
      defaultBranch: 'main',
      page: 1,
      hasMore: true,
      items: [
        {
          number: 42,
          title: 'Improve release flow',
          url: 'https://github.test/pull/42',
          state: 'open',
          draft: false,
          merged: false,
          author: 'developer',
          headBranch: 'feature/OH-42',
          baseBranch: 'dev',
          updatedAt: '2026-07-27T10:00:00Z',
        },
      ],
    })
    vi.spyOn(api, 'repositoryPullRequestAuthors').mockResolvedValue([
      'developer',
      'release-manager',
    ])
    vi.spyOn(api, 'mergeRepositoryPullRequest').mockResolvedValue({
      merged: true,
      message: 'Merged',
      sha: 'abc123',
    })

    render(<RepositoryPullRequests repository="Orange-Health/service-api" />)

    expect(
      await screen.findByRole('link', { name: /Improve release flow/ }),
    ).toHaveAttribute('href', 'https://github.test/pull/42')
    await user.selectOptions(screen.getByLabelText('State'), 'all')
    await waitFor(() =>
      expect(api.repositoryPullRequests).toHaveBeenLastCalledWith(
        'Orange-Health/service-api',
        expect.objectContaining({ state: 'all', page: 1 }),
      ),
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Author')).toHaveTextContent('developer'),
    )
    await user.selectOptions(screen.getByLabelText('Author'), 'developer')
    await waitFor(() =>
      expect(api.repositoryPullRequests).toHaveBeenLastCalledWith(
        'Orange-Health/service-api',
        expect.objectContaining({
          state: 'all',
          author: 'developer',
          page: 1,
        }),
      ),
    )

    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() =>
      expect(api.repositoryPullRequests).toHaveBeenLastCalledWith(
        'Orange-Health/service-api',
        expect.objectContaining({ state: 'all', page: 2 }),
      ),
    )

    await user.click(screen.getByRole('button', { name: 'Merge' }))
    await user.click(screen.getByRole('button', { name: 'Merge PR' }))
    await waitFor(() =>
      expect(api.mergeRepositoryPullRequest).toHaveBeenCalledWith({
        repository: 'Orange-Health/service-api',
        pullNumber: 42,
      }),
    )
  })
})

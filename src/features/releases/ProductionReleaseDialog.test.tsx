import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import { ProductionReleaseDialog } from './ProductionReleaseDialog'
import {
  nextPatchProductionTagPreview,
  releaseDayProductionTagPreview,
} from './productionTags'

afterEach(() => vi.restoreAllMocks())

describe('production tag previews', () => {
  it('builds release-day and patch previews', () => {
    expect(
      releaseDayProductionTagPreview('Orange-Health/accounts', '2026-08-12'),
    ).toBe('v26.0812.N')
    expect(
      releaseDayProductionTagPreview('Orange-Health/asbru', '2026-08-12'),
    ).toBe('v-prod-26.0812.N')
    expect(
      nextPatchProductionTagPreview('Orange-Health/accounts', 'v26.0714.3'),
    ).toBe('v26.0714.4')
    expect(
      nextPatchProductionTagPreview('Orange-Health/asbru', 'v-prod-26.0714.3'),
    ).toBe('v-prod-26.0714.4')
  })
})

describe('ProductionReleaseDialog', () => {
  it('defaults to patching the latest production tag from the list', async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(api, 'createProductionRelease').mockResolvedValue({
      id: 2,
      repository: 'Orange-Health/accounts',
      tag: 'v26.0714.4',
      sourceBranch: 'main',
      url: 'https://github.test/releases/2',
      createdAt: '2026-08-12T12:00:00Z',
    })

    render(
      <ProductionReleaseDialog
        repository="Orange-Health/accounts"
        latestProductionTag="v26.0714.3"
        onClose={vi.fn()}
      />,
    )

    expect(
      screen.getByText(/Patches the latest production tag \(v26\.0714\.3\)/),
    ).toBeInTheDocument()
    expect(screen.getByText('v26.0714.4')).toBeInTheDocument()
    expect(screen.queryByLabelText('Release date')).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Create production release' }),
    )

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        repository: 'Orange-Health/accounts',
        mode: 'patch',
      }),
    )
  })

  it('can patch without waiting for the production list tag', async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(api, 'createProductionRelease').mockResolvedValue({
      id: 4,
      repository: 'Orange-Health/accounts',
      tag: 'v26.0714.4',
      sourceBranch: 'main',
      url: 'https://github.test/releases/4',
      createdAt: '2026-08-12T12:00:00Z',
    })

    render(
      <ProductionReleaseDialog
        repository="Orange-Health/accounts"
        onClose={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Create production release' }),
    ).toBeEnabled()

    await user.click(
      screen.getByRole('button', { name: 'Create production release' }),
    )

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        repository: 'Orange-Health/accounts',
        mode: 'patch',
      }),
    )
  })

  it('creates a date-based tag when release day is selected', async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(api, 'createProductionRelease').mockResolvedValue({
      id: 3,
      repository: 'Orange-Health/accounts',
      tag: 'v26.0812.1',
      sourceBranch: 'main',
      url: 'https://github.test/releases/3',
      createdAt: '2026-08-12T12:00:00Z',
    })

    render(
      <ProductionReleaseDialog
        repository="Orange-Health/accounts"
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('checkbox', { name: /release day/i }))
    expect(screen.getByLabelText('Release date')).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: 'Create production release' }),
    )

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        repository: 'Orange-Health/accounts',
        mode: 'release-day',
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
  })
})

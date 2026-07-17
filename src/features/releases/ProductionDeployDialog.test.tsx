import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import {
  ProductionDeployDialog,
} from './ProductionDeployDialog'
import { productionTagForFormat } from './productionTags'

afterEach(() => vi.restoreAllMocks())

describe('ProductionDeployDialog', () => {
  it('switches between read-only standard and frontend tag formats', () => {
    expect(productionTagForFormat('v-26.0714.2', false)).toBe('v-26.0714.2')
    expect(productionTagForFormat('v-26.0714.2', true)).toBe(
      'v-prod-26.0714.2',
    )
  })

  it('shows the selected production release tag as read-only', () => {
    render(
      <ProductionDeployDialog
        repository="Orange-Health/accounts"
        services={['accounts']}
        sourceTag="v-26.0714.2"
        onClose={vi.fn()}
      />,
    )

    const tag = screen.getByLabelText('Image tag')
    expect(tag).toHaveValue('v-26.0714.2')
    expect(tag).toBeDisabled()
  })

  it('defaults to frontend formatting from the repository configuration', () => {
    render(
      <ProductionDeployDialog
        repository="Orange-Health/asbru"
        services={['asbru-web']}
        sourceTag="v-26.0714.2"
        onClose={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('checkbox', {
        name: /use frontend tag format/i,
      }),
    ).toBeChecked()
    expect(screen.getByLabelText('Image tag')).toHaveValue(
      'v-prod-26.0714.2',
    )
  })

  it('updates the read-only tag when frontend format is toggled', async () => {
    const user = userEvent.setup()
    render(
      <ProductionDeployDialog
        repository="Orange-Health/accounts"
        services={['accounts']}
        sourceTag="v-26.0714.2"
        onClose={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole('checkbox', {
        name: /use frontend tag format/i,
      }),
    )
    expect(screen.getByLabelText('Image tag')).toHaveValue(
      'v-prod-26.0714.2',
    )
  })

  it('submits the production Jenkins parameters', async () => {
    const user = userEvent.setup()
    const trigger = vi
      .spyOn(api, 'triggerProductionDeployment')
      .mockResolvedValue({
        queueId: 944,
        queueUrl: 'https://pitstop.test/queue/item/944/',
        buildUrl:
          'https://pitstop.test/job/Prod-new-cluster-deployment/944/',
        jobName: 'Prod-new-cluster-deployment',
        service: 'accounts',
        imageTag: 'v-26.0714.2',
      })
    render(
      <ProductionDeployDialog
        repository="Orange-Health/accounts"
        services={['accounts']}
        sourceTag="v-26.0714.2"
        onClose={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole('button', { name: 'Deploy production' }),
    )

    expect(trigger).toHaveBeenCalledWith({
      repository: 'Orange-Health/accounts',
      service: 'accounts',
      imageTag: 'v-26.0714.2',
      qaApprovalRequired: false,
      qaName: undefined,
      skipProdMigration: false,
      prodMigrationJob: 'Prod-new-cluster-migration',
    })
    expect(await screen.findByText('Production deployment')).toBeVisible()
  })
})

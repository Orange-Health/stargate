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
    expect(productionTagForFormat('v26.0714.2', false)).toBe('v26.0714.2')
    expect(productionTagForFormat('v-26.0714.2', false)).toBe('v26.0714.2')
    expect(productionTagForFormat('v26.0714.2', true)).toBe(
      'v-prod-26.0714.2',
    )
  })

  it('shows the selected production release tag as read-only', () => {
    render(
      <ProductionDeployDialog
        repository="Orange-Health/accounts"
        services={['accounts']}
        sourceTag="v26.0714.2"
        onClose={vi.fn()}
      />,
    )

    const tag = screen.getByLabelText('Image tag')
    expect(tag).toHaveValue('v26.0714.2')
    expect(tag).toBeDisabled()
  })

  it('defaults to frontend formatting from the repository configuration', () => {
    render(
      <ProductionDeployDialog
        repository="Orange-Health/asbru"
        services={['asbru-web']}
        sourceTag="v26.0714.2"
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
        sourceTag="v26.0714.2"
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
    const onDeploymentUpdated = vi.fn()
    const trigger = vi
      .spyOn(api, 'triggerProductionDeployment')
      .mockResolvedValue({
        queueId: 944,
        queueUrl: 'https://pitstop.test/queue/item/944/',
        buildUrl:
          'https://pitstop.test/job/Prod%20Deployments/job/Prod-cluster-deployment/944/',
        jobName: 'Prod Deployments/Prod-cluster-deployment',
        service: 'accounts',
        imageTag: 'v26.0714.2',
      })
    render(
      <ProductionDeployDialog
        repository="Orange-Health/accounts"
        services={['accounts']}
        sourceTag="v26.0714.2"
        onDeploymentUpdated={onDeploymentUpdated}
        onClose={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole('button', { name: 'Deploy production' }),
    )

    expect(trigger).toHaveBeenCalledWith({
      repository: 'Orange-Health/accounts',
      service: 'accounts',
      imageTag: 'v26.0714.2',
      qaApprovalRequired: false,
      qaName: undefined,
      skipProdMigration: false,
      prodMigrationJob: 'Prod Deployments/Prod-cluster-migration',
    })
    expect(onDeploymentUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        queueId: 944,
        service: 'accounts',
        imageTag: 'v26.0714.2',
      }),
    )
    expect(await screen.findByText('Production deployment')).toBeVisible()
  })

  it('shows a copyable currently deployed tag near the deploy button', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <ProductionDeployDialog
        repository="Orange-Health/accounts"
        services={['accounts', 'billing']}
        sourceTag="v26.0714.2"
        deployedTags={[
          {
            service: 'accounts',
            tag: 'v26.0713.1',
            environment: 'production',
            buildNumber: 2201,
            buildUrl: 'https://jenkins.test/production/2201/',
            deployedAt: '2026-07-13T13:30:00Z',
          },
          {
            service: 'billing',
            tag: 'v26.0712.9',
            environment: 'production',
            buildNumber: 2190,
            buildUrl: 'https://jenkins.test/production/2190/',
            deployedAt: '2026-07-12T13:30:00Z',
          },
        ]}
        onClose={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('button', {
        name: 'Copy currently deployed tag v26.0713.1',
      }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', {
        name: 'Copy currently deployed tag v26.0712.9',
      }),
    ).not.toBeInTheDocument()

    await user.selectOptions(
      screen.getByRole('combobox', { name: /jenkins service/i }),
      'billing',
    )

    expect(
      screen.getByRole('button', {
        name: 'Copy currently deployed tag v26.0712.9',
      }),
    ).toBeVisible()

    await user.click(
      screen.getByRole('button', {
        name: 'Copy currently deployed tag v26.0712.9',
      }),
    )
    expect(writeText).toHaveBeenCalledWith('v26.0712.9')
  })
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionScreen } from './ConnectionScreen'

describe('ConnectionScreen', () => {
  it('populates every credential from a seven-line paste', async () => {
    const user = userEvent.setup()
    render(<ConnectionScreen onConnect={vi.fn()} />)

    const email = screen.getByLabelText('Email')
    await user.click(email)
    await user.paste(
      [
        'rm@orange.test',
        'jira-token',
        'github-token',
        'stage-user',
        'stage-token',
        'prod-user',
        'prod-token',
      ].join('\n'),
    )

    expect(email).toHaveValue('rm@orange.test')
    expect(screen.getByLabelText('Jira API token')).toHaveValue('jira-token')
    expect(screen.getByLabelText('Personal access token')).toHaveValue(
      'github-token',
    )
    expect(screen.getByLabelText('Staging username')).toHaveValue('stage-user')
    expect(screen.getByLabelText('Staging API token')).toHaveValue('stage-token')
    expect(screen.getByLabelText('Production username')).toHaveValue('prod-user')
    expect(screen.getByLabelText('Production API token')).toHaveValue(
      'prod-token',
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'All seven credentials were populated.',
    )
  })

  it('submits runtime credentials without rendering their values afterward', async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn().mockResolvedValue({
      connected: true,
      jiraUser: 'Release Manager',
      githubUser: 'rm',
      githubOrg: 'Orange-Health',
      projectKey: 'OH',
    })
    render(<ConnectionScreen onConnect={onConnect} />)

    expect(screen.queryByLabelText('Organization')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Email'), 'rm@orange.test')
    await user.type(screen.getByLabelText('Jira API token'), 'jira-secret')
    await user.type(
      screen.getByLabelText('Staging username'),
      'release-manager',
    )
    await user.type(
      screen.getByLabelText('Staging API token'),
      'jenkins-secret',
    )
    await user.type(
      screen.getByLabelText('Personal access token'),
      'github-secret',
    )
    await user.click(
      screen.getByRole('button', { name: 'Connect and continue' }),
    )

    expect(onConnect).toHaveBeenCalledWith({
      jiraSite: 'https://orange-health.atlassian.net',
      jiraEmail: 'rm@orange.test',
      jiraToken: 'jira-secret',
      githubOrg: 'Orange-Health',
      githubToken: 'github-secret',
      jenkinsUrl: 'https://jenkins.stage.orangehealth.dev',
      jenkinsUsername: 'release-manager',
      jenkinsToken: 'jenkins-secret',
      productionJenkins: undefined,
      jiraProject: 'OH',
    })
  })

  it('shows provider connection errors', async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn().mockRejectedValue(new Error('GitHub denied access.'))
    render(<ConnectionScreen onConnect={onConnect} />)

    await user.type(screen.getByLabelText('Email'), 'rm@orange.test')
    await user.type(screen.getByLabelText('Jira API token'), 'jira-secret')
    await user.type(
      screen.getByLabelText('Staging username'),
      'release-manager',
    )
    await user.type(
      screen.getByLabelText('Staging API token'),
      'jenkins-secret',
    )
    await user.type(
      screen.getByLabelText('Personal access token'),
      'github-secret',
    )
    await user.click(
      screen.getByRole('button', { name: 'Connect and continue' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'GitHub denied access.',
    )
  })

  it('includes optional production Jenkins credentials when supplied', async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn().mockResolvedValue({ connected: true })
    render(<ConnectionScreen onConnect={onConnect} />)

    await user.type(screen.getByLabelText('Email'), 'stage@test.com')
    await user.type(screen.getByLabelText('Jira API token'), 'jira-token')
    await user.type(screen.getByLabelText('Staging username'), 'stage-user')
    await user.type(screen.getByLabelText('Staging API token'), 'stage-token')
    await user.type(
      screen.getByLabelText('Production username'),
      'prod-user',
    )
    await user.type(
      screen.getByLabelText('Production API token'),
      'prod-token',
    )
    await user.type(
      screen.getByLabelText('Personal access token'),
      'github-token',
    )
    await user.click(
      screen.getByRole('button', { name: 'Connect and continue' }),
    )

    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        productionJenkins: {
          jenkinsUrl: 'https://pitstop.orangehealth.dev',
          jenkinsUsername: 'prod-user',
          jenkinsToken: 'prod-token',
        },
      }),
    )
  })
})

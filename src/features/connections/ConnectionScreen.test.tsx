import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionScreen } from './ConnectionScreen'

describe('ConnectionScreen', () => {
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
    await user.type(screen.getAllByLabelText('API token')[0], 'jira-secret')
    await user.type(screen.getByLabelText('Username'), 'release-manager')
    await user.type(
      screen.getAllByLabelText('API token')[1],
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
      jiraProject: 'OH',
    })
  })

  it('shows provider connection errors', async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn().mockRejectedValue(new Error('GitHub denied access.'))
    render(<ConnectionScreen onConnect={onConnect} />)

    await user.type(screen.getByLabelText('Email'), 'rm@orange.test')
    await user.type(screen.getAllByLabelText('API token')[0], 'jira-secret')
    await user.type(screen.getByLabelText('Username'), 'release-manager')
    await user.type(
      screen.getAllByLabelText('API token')[1],
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
})

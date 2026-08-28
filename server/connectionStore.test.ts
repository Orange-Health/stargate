import { describe, expect, it } from 'vitest'
import { mergeConnectionUpdate } from './connectionStore.js'

describe('mergeConnectionUpdate', () => {
  it('requires tokens on first connect', () => {
    expect(() =>
      mergeConnectionUpdate(undefined, {
        jiraSite: 'https://orange-health.atlassian.net',
        jiraEmail: 'rm@orange.test',
        jiraToken: '',
        githubToken: 'gh',
        jenkinsUrl: 'https://jenkins.stage.orangehealth.dev',
        jenkinsUsername: 'rm',
        jenkinsToken: 'jk',
      }),
    ).toThrow(/tokens are required/)
  })

  it('keeps stored tokens when the update leaves them blank', () => {
    const merged = mergeConnectionUpdate(
      {
        jiraSite: 'https://orange-health.atlassian.net',
        jiraEmail: 'rm@orange.test',
        jiraToken: 'old-jira',
        githubOrg: 'Orange-Health',
        githubToken: 'old-github',
        jenkinsUrl: 'https://jenkins.stage.orangehealth.dev',
        jenkinsUsername: 'rm',
        jenkinsToken: 'old-jenkins',
      },
      {
        jiraSite: 'https://orange-health.atlassian.net',
        jiraEmail: 'rm@orange.test',
        jiraToken: '',
        githubToken: 'new-github',
        jenkinsUrl: 'https://jenkins.stage.orangehealth.dev',
        jenkinsUsername: 'rm',
        jenkinsToken: '',
      },
    )
    expect(merged.jiraToken).toBe('old-jira')
    expect(merged.githubToken).toBe('new-github')
    expect(merged.jenkinsToken).toBe('old-jenkins')
  })
})

import type { ConnectionConfig, ConnectionStatus } from '../src/shared/types.js'
import {
  DEFAULT_JIRA_PROJECT,
  GITHUB_ORG,
  NOT_CONNECTED_MESSAGE,
} from './constants.js'
import { decryptSecret, encryptSecret } from './crypto/secretBox.js'
import { getPool } from './db/pool.js'
import { getCurrentUser, getStore } from './auth/context.js'

const memoryConnections = new Map<string, ConnectionConfig>()

export type ConnectionDraft = {
  jiraSite: string
  jiraEmail: string
  jiraToken?: string
  githubToken?: string
  jenkinsUrl: string
  jenkinsUsername: string
  jenkinsToken?: string
  productionJenkins?: {
    jenkinsUrl: string
    jenkinsUsername: string
    jenkinsToken?: string
  }
  jiraProject?: string
}

function userKey() {
  return getCurrentUser()?.id ?? 'anon'
}

export function mergeConnectionUpdate(
  existing: ConnectionConfig | undefined,
  incoming: ConnectionDraft,
): ConnectionConfig {
  const jiraToken = incoming.jiraToken || existing?.jiraToken
  const githubToken = incoming.githubToken || existing?.githubToken
  const jenkinsToken = incoming.jenkinsToken || existing?.jenkinsToken
  if (!jiraToken || !githubToken || !jenkinsToken) {
    throw new Error('Jira, GitHub, and Jenkins tokens are required.')
  }
  const productionToken =
    incoming.productionJenkins?.jenkinsToken ||
    existing?.productionJenkins?.jenkinsToken
  const productionUsername =
    incoming.productionJenkins?.jenkinsUsername ||
    existing?.productionJenkins?.jenkinsUsername
  const productionUrl =
    incoming.productionJenkins?.jenkinsUrl ||
    existing?.productionJenkins?.jenkinsUrl
  return {
    jiraSite: incoming.jiraSite.replace(/\/+$/, ''),
    jiraEmail: incoming.jiraEmail,
    jiraToken,
    githubOrg: GITHUB_ORG,
    githubToken,
    jenkinsUrl: incoming.jenkinsUrl.replace(/\/+$/, ''),
    jenkinsUsername: incoming.jenkinsUsername,
    jenkinsToken,
    jiraProject: incoming.jiraProject ?? DEFAULT_JIRA_PROJECT,
    productionJenkins:
      productionUrl && productionUsername && productionToken
        ? {
            jenkinsUrl: productionUrl.replace(/\/+$/, ''),
            jenkinsUsername: productionUsername,
            jenkinsToken: productionToken,
          }
        : undefined,
  }
}

export async function loadConnection(userId: string) {
  const cached = memoryConnections.get(userId)
  if (cached) return cached
  const pool = getPool()
  if (!pool) return undefined
  const result = await pool.query<{
    jira_site: string
    jira_email: string
    jira_token_ciphertext: Buffer
    github_org: string
    github_token_ciphertext: Buffer
    jenkins_url: string
    jenkins_username: string
    jenkins_token_ciphertext: Buffer
    production_jenkins_ciphertext: Buffer | null
    jira_project: string
  }>(
    `SELECT jira_site, jira_email, jira_token_ciphertext, github_org,
            github_token_ciphertext, jenkins_url, jenkins_username,
            jenkins_token_ciphertext, production_jenkins_ciphertext, jira_project
     FROM user_connections WHERE user_id = $1`,
    [userId],
  )
  const row = result.rows[0]
  if (!row) return undefined
  const production = row.production_jenkins_ciphertext
    ? (JSON.parse(decryptSecret(row.production_jenkins_ciphertext)) as {
        jenkinsUrl: string
        jenkinsUsername: string
        jenkinsToken: string
      })
    : undefined
  const config: ConnectionConfig = {
    jiraSite: row.jira_site,
    jiraEmail: row.jira_email,
    jiraToken: decryptSecret(row.jira_token_ciphertext),
    githubOrg: row.github_org,
    githubToken: decryptSecret(row.github_token_ciphertext),
    jenkinsUrl: row.jenkins_url,
    jenkinsUsername: row.jenkins_username,
    jenkinsToken: decryptSecret(row.jenkins_token_ciphertext),
    jiraProject: row.jira_project,
    productionJenkins: production,
  }
  memoryConnections.set(userId, config)
  return config
}

export async function setConnection(config: ConnectionConfig) {
  const user = getCurrentUser()
  const key = user?.id ?? 'anon'
  memoryConnections.set(key, config)
  const store = getStore()
  if (store) store.connection = config
  const pool = getPool()
  if (!pool || !user) return
  await pool.query(
    `INSERT INTO user_connections (
       user_id, jira_site, jira_email, jira_token_ciphertext, github_org,
       github_token_ciphertext, jenkins_url, jenkins_username,
       jenkins_token_ciphertext, production_jenkins_ciphertext, jira_project,
       validated_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET
       jira_site = EXCLUDED.jira_site,
       jira_email = EXCLUDED.jira_email,
       jira_token_ciphertext = EXCLUDED.jira_token_ciphertext,
       github_org = EXCLUDED.github_org,
       github_token_ciphertext = EXCLUDED.github_token_ciphertext,
       jenkins_url = EXCLUDED.jenkins_url,
       jenkins_username = EXCLUDED.jenkins_username,
       jenkins_token_ciphertext = EXCLUDED.jenkins_token_ciphertext,
       production_jenkins_ciphertext = EXCLUDED.production_jenkins_ciphertext,
       jira_project = EXCLUDED.jira_project,
       validated_at = now(),
       updated_at = now()`,
    [
      user.id,
      config.jiraSite,
      config.jiraEmail,
      encryptSecret(config.jiraToken),
      config.githubOrg,
      encryptSecret(config.githubToken),
      config.jenkinsUrl,
      config.jenkinsUsername,
      encryptSecret(config.jenkinsToken),
      config.productionJenkins
        ? encryptSecret(JSON.stringify(config.productionJenkins))
        : null,
      config.jiraProject ?? DEFAULT_JIRA_PROJECT,
    ],
  )
}

export function clearConnection() {
  const key = userKey()
  memoryConnections.delete(key)
  const store = getStore()
  if (store) store.connection = undefined
  const pool = getPool()
  const user = getCurrentUser()
  if (pool && user) {
    void pool.query('DELETE FROM user_connections WHERE user_id = $1', [
      user.id,
    ])
  }
}

export function getConnection(): ConnectionConfig | undefined {
  return getStore()?.connection ?? memoryConnections.get(userKey())
}

export function requireConnection(): ConnectionConfig {
  const connection = getConnection()
  if (!connection) {
    throw new Error(NOT_CONNECTED_MESSAGE)
  }
  return connection
}

export function connectionStatus(
  extras?: Partial<ConnectionStatus>,
): ConnectionStatus {
  const connection = getConnection()
  if (!connection) return { connected: false, ...extras }
  return {
    connected: true,
    githubOrg: connection.githubOrg,
    projectKey: connection.jiraProject ?? DEFAULT_JIRA_PROJECT,
    productionEnabled: Boolean(connection.productionJenkins),
    jiraSite: connection.jiraSite,
    jiraEmail: connection.jiraEmail,
    jenkinsUrl: connection.jenkinsUrl,
    jenkinsUsername: connection.jenkinsUsername,
    productionJenkinsUrl: connection.productionJenkins?.jenkinsUrl,
    productionJenkinsUsername: connection.productionJenkins?.jenkinsUsername,
    ...extras,
  }
}

import * as client from 'openid-client'
import { OIDC_COOKIE_NAME, RELEASE_DASHBOARD_ROLE } from '../constants.js'
import { clearCookie, requestCookies, setCookie } from '../http/cookies.js'
import type { Request, Response } from 'express'

const OIDC_COOKIE_TTL_MS = 10 * 60 * 1000

type OidcState = {
  verifier: string
  state: string
}

let discovered: client.Configuration | undefined

function issuerUrl() {
  const issuer = process.env.KEYCLOAK_ISSUER
  if (!issuer) {
    throw new Error('KEYCLOAK_ISSUER is required for Keycloak login.')
  }
  return new URL(issuer)
}

function redirectUri() {
  return (
    process.env.KEYCLOAK_REDIRECT_URI ??
    'http://127.0.0.1:8787/api/auth/callback'
  )
}

async function oidcConfig() {
  if (discovered) return discovered
  const clientId = process.env.KEYCLOAK_CLIENT_ID
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('KEYCLOAK_CLIENT_ID and KEYCLOAK_CLIENT_SECRET are required.')
  }
  discovered = await client.discovery(issuerUrl(), clientId, clientSecret)
  return discovered
}

function encodeState(value: OidcState) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeState(value: string): OidcState | undefined {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as OidcState
  } catch {
    return undefined
  }
}

export async function startLogin(response: Response) {
  const config = await oidcConfig()
  const verifier = client.randomPKCECodeVerifier()
  const challenge = await client.calculatePKCECodeChallenge(verifier)
  const state = client.randomState()
  setCookie(response, OIDC_COOKIE_NAME, encodeState({ verifier, state }), {
    maxAgeMs: OIDC_COOKIE_TTL_MS,
  })
  const redirectTo = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: 'openid email profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return redirectTo.href
}

export async function finishLogin(request: Request) {
  const pending = decodeState(requestCookies(request)[OIDC_COOKIE_NAME] ?? '')
  if (!pending) {
    throw new Error('Login session expired. Try signing in again.')
  }
  const config = await oidcConfig()
  const currentUrl = new URL(
    request.originalUrl,
    `${request.protocol}://${request.get('host')}`,
  )
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: pending.verifier,
    expectedState: pending.state,
  })
  const claims = tokens.claims()
  if (!claims?.sub) {
    throw new Error('Keycloak did not return a user identity.')
  }
  const roles = readRoles(tokens)
  if (roles.length > 0 && !roles.includes(RELEASE_DASHBOARD_ROLE)) {
    throw new Error('Your account is not allowed to use Release Desk.')
  }
  return {
    keycloakSub: claims.sub,
    email: String(claims.email ?? `${claims.sub}@orangehealth`),
    displayName:
      typeof claims.name === 'string'
        ? claims.name
        : typeof claims.preferred_username === 'string'
          ? claims.preferred_username
          : undefined,
  }
}

export function clearOidcCookie(response: Response) {
  clearCookie(response, OIDC_COOKIE_NAME)
}

function readRoles(tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers) {
  const access = tokens.access_token
  if (!access) return []
  const parts = access.split('.')
  if (parts.length < 2) return []
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as {
      realm_access?: { roles?: string[] }
      resource_access?: Record<string, { roles?: string[] }>
    }
    const clientId = process.env.KEYCLOAK_CLIENT_ID
    return [
      ...(payload.realm_access?.roles ?? []),
      ...(clientId ? (payload.resource_access?.[clientId]?.roles ?? []) : []),
    ]
  } catch {
    return []
  }
}

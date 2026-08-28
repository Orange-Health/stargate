import type { Request, Response } from 'express'
import { isAuthDisabled } from '../constants.js'
import { getCurrentUser } from './context.js'
import { finishLogin, startLogin, clearOidcCookie } from './oidc.js'
import { createSession, destroySession, readSession } from './sessions.js'
import { ensureLocalDevUser, upsertUser } from './users.js'

export async function handleAuthMe(request: Request, response: Response) {
  if (isAuthDisabled()) {
    const user = await ensureLocalDevUser()
    response.json({
      authenticated: true,
      email: user.email,
      displayName: user.displayName,
      authDisabled: true,
    })
    return
  }
  const user = getCurrentUser() ?? (await readSession(request))
  if (!user) {
    response.status(401).json({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Sign in to use Release Desk.',
      },
    })
    return
  }
  response.json({
    authenticated: true,
    email: user.email,
    displayName: user.displayName,
    authDisabled: false,
  })
}

export async function handleAuthLogin(
  _request: Request,
  response: Response,
) {
  if (isAuthDisabled()) {
    response.redirect('/')
    return
  }
  const location = await startLogin(response)
  response.redirect(location)
}

export async function handleAuthCallback(
  request: Request,
  response: Response,
) {
  if (isAuthDisabled()) {
    response.redirect('/')
    return
  }
  const identity = await finishLogin(request)
  const user = await upsertUser(identity)
  clearOidcCookie(response)
  await createSession(response, user)
  response.redirect('/')
}

export async function handleAuthLogout(
  request: Request,
  response: Response,
) {
  await destroySession(request, response)
  response.status(204).end()
}

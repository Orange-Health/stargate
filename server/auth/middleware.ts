import type { NextFunction, Request, Response } from 'express'
import { isAuthDisabled } from '../constants.js'
import { loadConnection } from '../connectionStore.js'
import { runWithStore, type AppUser } from './context.js'
import { readSession } from './sessions.js'
import { ensureLocalDevUser } from './users.js'

const PUBLIC_PATHS = new Set(['/api/health'])

function isPublicPath(path: string) {
  return PUBLIC_PATHS.has(path) || path.startsWith('/api/auth/')
}

export async function authMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  if (!request.path.startsWith('/api') || isPublicPath(request.path)) {
    next()
    return
  }
  try {
    const user = await resolveUser(request)
    if (!user) {
      response.status(401).json({
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Sign in to use Release Desk.',
        },
      })
      return
    }
    const store = {
      user,
      connection: await loadConnection(user.id),
    }
    runWithStore(store, () => next())
  } catch (error) {
    next(error)
  }
}

async function resolveUser(request: Request): Promise<AppUser | undefined> {
  if (isAuthDisabled()) return ensureLocalDevUser()
  return readSession(request)
}

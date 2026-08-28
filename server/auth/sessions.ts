import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { SESSION_COOKIE_NAME } from '../constants.js'
import { getPool } from '../db/pool.js'
import { clearCookie, requestCookies, setCookie } from '../http/cookies.js'
import type { AppUser } from './context.js'
import type { Request, Response } from 'express'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const memorySessions = new Map<string, { user: AppUser; expire: number }>()

type SessionPayload = {
  user: AppUser
}

function signingKey() {
  return process.env.SESSION_SECRET ?? process.env.CONNECTION_ENCRYPTION_KEY ?? 'dev-session'
}

function sign(value: string) {
  return createHmac('sha256', signingKey()).update(value).digest('base64url')
}

function signedValue(sid: string) {
  return `${sid}.${sign(sid)}`
}

function verifySigned(value: string) {
  const separator = value.lastIndexOf('.')
  if (separator < 1) return undefined
  const sid = value.slice(0, separator)
  const digest = value.slice(separator + 1)
  const expected = sign(sid)
  const left = Buffer.from(digest)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return undefined
  }
  return sid
}

export async function createSession(response: Response, user: AppUser) {
  const sid = randomBytes(24).toString('base64url')
  const expire = new Date(Date.now() + SESSION_TTL_MS)
  const payload: SessionPayload = { user }
  const pool = getPool()
  if (pool) {
    await pool.query(
      `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2, $3)`,
      [sid, payload, expire],
    )
  } else {
    memorySessions.set(sid, { user, expire: expire.getTime() })
  }
  setCookie(response, SESSION_COOKIE_NAME, signedValue(sid), {
    maxAgeMs: SESSION_TTL_MS,
  })
}

export async function readSession(request: Request): Promise<AppUser | undefined> {
  const value = requestCookies(request)[SESSION_COOKIE_NAME]
  if (!value) return undefined
  const sid = verifySigned(value)
  if (!sid) return undefined
  const pool = getPool()
  if (pool) {
    const result = await pool.query<{ sess: SessionPayload }>(
      `SELECT sess FROM sessions WHERE sid = $1 AND expire > now()`,
      [sid],
    )
    return result.rows[0]?.sess.user
  }
  const current = memorySessions.get(sid)
  if (!current || current.expire < Date.now()) {
    memorySessions.delete(sid)
    return undefined
  }
  return current.user
}

export async function destroySession(request: Request, response: Response) {
  const value = requestCookies(request)[SESSION_COOKIE_NAME]
  const sid = value ? verifySigned(value) : undefined
  if (sid) {
    const pool = getPool()
    if (pool) {
      await pool.query('DELETE FROM sessions WHERE sid = $1', [sid])
    } else {
      memorySessions.delete(sid)
    }
  }
  clearCookie(response, SESSION_COOKIE_NAME)
}

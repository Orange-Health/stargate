import type { Request, Response } from 'express'
import { isProduction } from '../constants.js'

export function readCookies(header: string | undefined) {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    try {
      cookies[key] = decodeURIComponent(value)
    } catch {
      cookies[key] = value
    }
  }
  return cookies
}

export function requestCookies(request: Request) {
  return readCookies(request.headers.cookie)
}

export function setCookie(
  response: Response,
  name: string,
  value: string,
  options: { maxAgeMs: number; httpOnly?: boolean },
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(options.maxAgeMs / 1000)}`,
  ]
  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (isProduction()) parts.push('Secure')
  response.append('Set-Cookie', parts.join('; '))
}

export function clearCookie(response: Response, name: string) {
  const parts = [`${name}=`, 'Path=/', 'SameSite=Lax', 'Max-Age=0']
  if (isProduction()) parts.push('Secure')
  response.append('Set-Cookie', parts.join('; '))
}

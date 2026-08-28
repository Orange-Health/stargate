import {
  LOCAL_DEV_USER_EMAIL,
  LOCAL_DEV_USER_ID,
  LOCAL_DEV_USER_NAME,
  LOCAL_DEV_USER_SUB,
} from '../constants.js'
import { getPool } from '../db/pool.js'
import type { AppUser } from './context.js'

export const localDevUser: AppUser = {
  id: LOCAL_DEV_USER_ID,
  keycloakSub: LOCAL_DEV_USER_SUB,
  email: LOCAL_DEV_USER_EMAIL,
  displayName: LOCAL_DEV_USER_NAME,
}

export async function upsertUser(input: {
  keycloakSub: string
  email: string
  displayName?: string
}): Promise<AppUser> {
  const pool = getPool()
  if (!pool) {
    if (input.keycloakSub === LOCAL_DEV_USER_SUB) return localDevUser
    return {
      id: LOCAL_DEV_USER_ID,
      keycloakSub: input.keycloakSub,
      email: input.email,
      displayName: input.displayName,
    }
  }
  const result = await pool.query<{
    id: string
    keycloak_sub: string
    email: string
    display_name: string | null
  }>(
    `INSERT INTO users (keycloak_sub, email, display_name, last_login_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (keycloak_sub) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       last_login_at = now()
     RETURNING id, keycloak_sub, email, display_name`,
    [input.keycloakSub, input.email, input.displayName ?? null],
  )
  const row = result.rows[0]
  return {
    id: row.id,
    keycloakSub: row.keycloak_sub,
    email: row.email,
    displayName: row.display_name ?? undefined,
  }
}

export async function ensureLocalDevUser() {
  return upsertUser({
    keycloakSub: LOCAL_DEV_USER_SUB,
    email: LOCAL_DEV_USER_EMAIL,
    displayName: LOCAL_DEV_USER_NAME,
  })
}

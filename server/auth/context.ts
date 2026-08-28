import { AsyncLocalStorage } from 'node:async_hooks'
import type { ConnectionConfig } from '../../src/shared/types.js'

export type AppUser = {
  id: string
  keycloakSub: string
  email: string
  displayName?: string
}

type RequestStore = {
  user: AppUser
  connection?: ConnectionConfig
}

const storage = new AsyncLocalStorage<RequestStore>()

export function runWithStore<T>(store: RequestStore, fn: () => T) {
  return storage.run(store, fn)
}

export function getStore() {
  return storage.getStore()
}

export function getCurrentUser() {
  return storage.getStore()?.user
}

export function requireUser() {
  const user = getCurrentUser()
  if (!user) {
    throw new Error('Authentication is required.')
  }
  return user
}

export function progressScopeKey(progressId: string) {
  return `${getCurrentUser()?.id ?? 'anon'}:${progressId}`
}

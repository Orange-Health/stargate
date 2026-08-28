import type { DashboardProgress } from '../../src/shared/types.js'
import { progressScopeKey } from '../auth/context.js'

const progress = new Map<string, DashboardProgress>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function setDashboardProgress(
  progressId: string,
  update: DashboardProgress,
) {
  const key = progressScopeKey(progressId)
  progress.set(key, update)
  const currentTimer = expiryTimers.get(key)
  if (currentTimer) clearTimeout(currentTimer)
  const timer = setTimeout(() => {
    progress.delete(key)
    expiryTimers.delete(key)
  }, 60_000)
  timer.unref()
  expiryTimers.set(key, timer)
}

export function getDashboardProgress(progressId: string) {
  return progress.get(progressScopeKey(progressId))
}

export function clearDashboardProgress(progressId: string) {
  const key = progressScopeKey(progressId)
  progress.delete(key)
  const timer = expiryTimers.get(key)
  if (timer) clearTimeout(timer)
  expiryTimers.delete(key)
}

import type { DashboardProgress } from '../../src/shared/types.js'

const progress = new Map<string, DashboardProgress>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function setDashboardProgress(
  progressId: string,
  update: DashboardProgress,
) {
  progress.set(progressId, update)
  const currentTimer = expiryTimers.get(progressId)
  if (currentTimer) clearTimeout(currentTimer)
  const timer = setTimeout(() => {
    progress.delete(progressId)
    expiryTimers.delete(progressId)
  }, 60_000)
  timer.unref()
  expiryTimers.set(progressId, timer)
}

export function getDashboardProgress(progressId: string) {
  return progress.get(progressId)
}

export function clearDashboardProgress(progressId: string) {
  progress.delete(progressId)
  const timer = expiryTimers.get(progressId)
  if (timer) clearTimeout(timer)
  expiryTimers.delete(progressId)
}

/** Default prior until local EMA has samples. */
export const EXPECTED_SYNC_MS_PER_SERVICE = 6_000

/** Hold just under 100% until the sync actually completes. */
export const TIME_BASED_PROGRESS_CAP = 95

export const SYNC_MS_PER_SERVICE_STORAGE_KEY = 'release-day-sync-ms-per-service'
export const SYNC_MS_PER_SERVICE_EMA_ALPHA = 0.3
export const SYNC_MS_PER_SERVICE_MIN = 500
export const SYNC_MS_PER_SERVICE_MAX = 60_000

/**
 * Wall-clock ETA for the sync given a prior and live completion throughput.
 *
 * Before any completions: prior × N.
 * After: blend prior with observed ms/service so parallelism/cache hits adapt.
 */
export function estimateSyncTotalMs(input: {
  serviceCount: number
  completedCount: number
  elapsedMs: number
  priorMsPerService: number
}): number {
  const { serviceCount, completedCount, elapsedMs } = input
  if (serviceCount <= 0) return 0
  const prior = clampSyncMsPerService(input.priorMsPerService)
  if (completedCount <= 0 || elapsedMs <= 0) {
    return prior * serviceCount
  }
  const observed = elapsedMs / completedCount
  const blendDenom = Math.max(2, serviceCount * 0.35)
  const blend = Math.min(1, completedCount / blendDenom)
  const estimatedMsPerService = (1 - blend) * prior + blend * observed
  const adaptiveTotal = estimatedMsPerService * serviceCount
  const seedTotal = prior * serviceCount
  // Faster than prior → shrink ETA. Slower → allow the bar to reach the
  // cap once wall-clock exceeds the seed instead of stretching forever.
  return Math.max(1, Math.min(adaptiveTotal, Math.max(seedTotal, elapsedMs)))
}

export function clampSyncMsPerService(ms: number): number {
  if (!Number.isFinite(ms)) return EXPECTED_SYNC_MS_PER_SERVICE
  return Math.min(
    SYNC_MS_PER_SERVICE_MAX,
    Math.max(SYNC_MS_PER_SERVICE_MIN, ms),
  )
}

/** Pure EMA update used by storage helpers and tests. */
export function blendSyncMsPerServicePrior(
  priorMs: number,
  sampleMs: number,
  alpha = SYNC_MS_PER_SERVICE_EMA_ALPHA,
): number {
  const prior = clampSyncMsPerService(priorMs)
  const sample = clampSyncMsPerService(sampleMs)
  return clampSyncMsPerService(alpha * sample + (1 - alpha) * prior)
}

export function readSyncMsPerServicePrior(
  storage: Pick<Storage, 'getItem'> | null | undefined = globalThis.localStorage,
): number {
  try {
    const raw = storage?.getItem(SYNC_MS_PER_SERVICE_STORAGE_KEY)
    if (!raw) return EXPECTED_SYNC_MS_PER_SERVICE
    return clampSyncMsPerService(Number(raw))
  } catch {
    return EXPECTED_SYNC_MS_PER_SERVICE
  }
}

export function updateSyncMsPerServicePrior(
  sampleMs: number,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined = globalThis.localStorage,
): number {
  const next = blendSyncMsPerServicePrior(
    readSyncMsPerServicePrior(storage),
    sampleMs,
  )
  try {
    storage?.setItem(SYNC_MS_PER_SERVICE_STORAGE_KEY, String(next))
  } catch {
    // Ignore quota / private-mode failures; in-memory next still returned.
  }
  return next
}

/**
 * Expected overall progress from elapsed time + adaptive ETA.
 */
export function timeBasedSyncPercent(
  elapsedMs: number,
  serviceCount: number,
  options?: {
    completedCount?: number
    priorMsPerService?: number
    cap?: number
  },
): number {
  if (serviceCount <= 0 || elapsedMs <= 0) return 0
  const cap = options?.cap ?? TIME_BASED_PROGRESS_CAP
  const estimatedTotalMs = estimateSyncTotalMs({
    serviceCount,
    completedCount: options?.completedCount ?? 0,
    elapsedMs,
    priorMsPerService:
      options?.priorMsPerService ?? EXPECTED_SYNC_MS_PER_SERVICE,
  })
  if (estimatedTotalMs <= 0) return 0
  return Math.min(cap, Math.round((elapsedMs / estimatedTotalMs) * cap))
}

/**
 * Pace the bar with an adaptive ETA. Jump ahead on completed services;
 * snap to 100% when sync finishes; hold near the end if late.
 */
export function displaySyncPercent(input: {
  syncInProgress: boolean
  completedCount: number
  serviceCount: number
  elapsedMs: number
  priorMsPerService?: number
  /** Only used as a completion signal (100), not for mid-sync pacing. */
  serverPercent?: number
}): number {
  const { serviceCount, completedCount } = input
  if (serviceCount <= 0) return 0

  const completedPercent = Math.round((completedCount / serviceCount) * 100)
  if (!input.syncInProgress) return completedPercent

  const finishedEarly =
    input.serverPercent === 100 || completedCount >= serviceCount
  if (finishedEarly) return 100

  const timed = timeBasedSyncPercent(input.elapsedMs, serviceCount, {
    completedCount,
    priorMsPerService: input.priorMsPerService,
  })
  return Math.min(
    TIME_BASED_PROGRESS_CAP,
    Math.max(timed, Math.min(TIME_BASED_PROGRESS_CAP, completedPercent)),
  )
}

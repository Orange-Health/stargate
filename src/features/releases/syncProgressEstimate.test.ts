import { describe, expect, it, beforeEach } from 'vitest'
import {
  blendSyncMsPerServicePrior,
  clampSyncMsPerService,
  displaySyncPercent,
  estimateSyncTotalMs,
  EXPECTED_SYNC_MS_PER_SERVICE,
  readSyncMsPerServicePrior,
  SYNC_MS_PER_SERVICE_MAX,
  SYNC_MS_PER_SERVICE_MIN,
  SYNC_MS_PER_SERVICE_STORAGE_KEY,
  timeBasedSyncPercent,
  TIME_BASED_PROGRESS_CAP,
  updateSyncMsPerServicePrior,
} from './syncProgressEstimate'

describe('estimateSyncTotalMs', () => {
  it('seeds from prior × service count before any completions', () => {
    expect(
      estimateSyncTotalMs({
        serviceCount: 5,
        completedCount: 0,
        elapsedMs: 3_000,
        priorMsPerService: 6_000,
      }),
    ).toBe(30_000)
  })

  it('pulls ETA down when observed throughput is faster than the prior', () => {
    const seeded = estimateSyncTotalMs({
      serviceCount: 10,
      completedCount: 0,
      elapsedMs: 4_000,
      priorMsPerService: 6_000,
    })
    const adapted = estimateSyncTotalMs({
      serviceCount: 10,
      completedCount: 4,
      elapsedMs: 4_000,
      priorMsPerService: 6_000,
    })
    expect(seeded).toBe(60_000)
    // observed = 1000ms/service; blend trusts observation enough to beat prior
    expect(adapted).toBeLessThan(seeded)
    expect(adapted).toBeGreaterThanOrEqual(4_000)
  })

  it('stretches ETA when observed throughput is slower than the prior', () => {
    const adapted = estimateSyncTotalMs({
      serviceCount: 5,
      completedCount: 2,
      elapsedMs: 40_000,
      priorMsPerService: 6_000,
    })
    expect(adapted).toBeGreaterThan(5 * 6_000)
  })
})

describe('timeBasedSyncPercent', () => {
  it('follows the prior seed until services complete', () => {
    expect(timeBasedSyncPercent(0, 5, { priorMsPerService: 6_000 })).toBe(0)
    expect(
      timeBasedSyncPercent(6_000, 5, {
        completedCount: 0,
        priorMsPerService: 6_000,
      }),
    ).toBe(19)
    expect(
      timeBasedSyncPercent(30_000, 5, {
        completedCount: 0,
        priorMsPerService: 6_000,
      }),
    ).toBe(TIME_BASED_PROGRESS_CAP)
  })

  it('advances faster than the prior when completions arrive early', () => {
    const withPriorOnly = timeBasedSyncPercent(4_000, 10, {
      completedCount: 0,
      priorMsPerService: 6_000,
    })
    const withThroughput = timeBasedSyncPercent(4_000, 10, {
      completedCount: 4,
      priorMsPerService: 6_000,
    })
    expect(withThroughput).toBeGreaterThan(withPriorOnly)
  })

  it('caps below 100 so late syncs wait at the end', () => {
    expect(
      timeBasedSyncPercent(120_000, 3, {
        completedCount: 1,
        priorMsPerService: 6_000,
      }),
    ).toBe(TIME_BASED_PROGRESS_CAP)
  })
})

describe('displaySyncPercent', () => {
  it('ignores fast intermediate server percents and follows the adaptive ETA', () => {
    expect(
      displaySyncPercent({
        syncInProgress: true,
        serverPercent: 70,
        completedCount: 0,
        elapsedMs: 6_000,
        serviceCount: 5,
        priorMsPerService: 6_000,
      }),
    ).toBe(19)
  })

  it('jumps ahead when services finish earlier than the time budget', () => {
    expect(
      displaySyncPercent({
        syncInProgress: true,
        serverPercent: 40,
        completedCount: 2,
        elapsedMs: 4_000,
        serviceCount: 5,
        priorMsPerService: 6_000,
      }),
    ).toBe(40)
  })

  it('snaps to 100 when sync finishes early', () => {
    expect(
      displaySyncPercent({
        syncInProgress: true,
        serverPercent: 100,
        completedCount: 5,
        elapsedMs: 8_000,
        serviceCount: 5,
        priorMsPerService: 6_000,
      }),
    ).toBe(100)
  })

  it('holds under 100 while still in progress after the ETA', () => {
    expect(
      displaySyncPercent({
        syncInProgress: true,
        completedCount: 3,
        elapsedMs: 60_000,
        serviceCount: 5,
        priorMsPerService: 6_000,
      }),
    ).toBe(TIME_BASED_PROGRESS_CAP)
  })

  it('uses completed percent when sync is not in progress', () => {
    expect(
      displaySyncPercent({
        syncInProgress: false,
        completedCount: 2,
        elapsedMs: 20_000,
        serviceCount: 8,
      }),
    ).toBe(25)
  })
})

describe('EMA prior helpers', () => {
  const memory = new Map<string, string>()
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value)
    },
  }

  beforeEach(() => {
    memory.clear()
  })

  it('clamps samples into a sane band', () => {
    expect(clampSyncMsPerService(10)).toBe(SYNC_MS_PER_SERVICE_MIN)
    expect(clampSyncMsPerService(120_000)).toBe(SYNC_MS_PER_SERVICE_MAX)
    expect(clampSyncMsPerService(Number.NaN)).toBe(EXPECTED_SYNC_MS_PER_SERVICE)
  })

  it('blends prior and sample with alpha 0.3', () => {
    expect(blendSyncMsPerServicePrior(6_000, 3_000)).toBe(
      clampSyncMsPerService(0.3 * 3_000 + 0.7 * 6_000),
    )
  })

  it('reads the default prior when storage is empty', () => {
    expect(readSyncMsPerServicePrior(storage)).toBe(EXPECTED_SYNC_MS_PER_SERVICE)
  })

  it('persists EMA updates', () => {
    const next = updateSyncMsPerServicePrior(3_000, storage)
    expect(next).toBe(blendSyncMsPerServicePrior(EXPECTED_SYNC_MS_PER_SERVICE, 3_000))
    expect(storage.getItem(SYNC_MS_PER_SERVICE_STORAGE_KEY)).toBe(String(next))
    expect(readSyncMsPerServicePrior(storage)).toBe(next)
  })
})

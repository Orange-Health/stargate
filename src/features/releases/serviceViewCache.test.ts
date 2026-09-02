import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SERVICE_VIEW_CACHE_MS,
  clearServiceViewCache,
  peekServiceViewCache,
  readServiceViewCache,
  writeServiceViewCache,
} from './serviceViewCache'

describe('serviceViewCache', () => {
  afterEach(() => {
    vi.useRealTimers()
    clearServiceViewCache()
  })

  it('returns cached values for one minute and expires afterward', () => {
    vi.useFakeTimers()
    writeServiceViewCache('releases:repo:staging', { tag: 'v-qa-1' })

    expect(readServiceViewCache('releases:repo:staging')).toEqual({
      tag: 'v-qa-1',
    })

    vi.advanceTimersByTime(SERVICE_VIEW_CACHE_MS - 1)
    expect(readServiceViewCache('releases:repo:staging')).toEqual({
      tag: 'v-qa-1',
    })

    vi.advanceTimersByTime(1)
    expect(readServiceViewCache('releases:repo:staging')).toBeUndefined()
    expect(peekServiceViewCache('releases:repo:staging')).toEqual({
      tag: 'v-qa-1',
    })
  })

  it('clears entries by prefix', () => {
    writeServiceViewCache('releases:a:staging', 1)
    writeServiceViewCache('branches:a:release', 2)
    clearServiceViewCache('releases:a:')
    expect(readServiceViewCache('releases:a:staging')).toBeUndefined()
    expect(readServiceViewCache('branches:a:release')).toBe(2)
  })
})

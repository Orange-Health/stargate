import { describe, expect, it } from 'vitest'
import {
  USE_RELEASE_BRANCH_STORAGE_KEY,
  backMergeBranches,
  backMergeRoutes,
  isBackMergePullRoute,
  isPromotionPullRoute,
  parseUseReleaseBranch,
  promotionBranches,
  promotionRouteLabel,
  promotionRoutes,
  readUseReleaseBranch,
  writeUseReleaseBranch,
} from './branchModel.js'

describe('branchModel', () => {
  it('defaults to using the release branch', () => {
    const storage = { getItem: () => null }
    expect(readUseReleaseBranch(storage)).toBe(true)
    expect(parseUseReleaseBranch(undefined)).toBe(true)
    expect(parseUseReleaseBranch('false')).toBe(false)
    expect(parseUseReleaseBranch(false)).toBe(false)
  })

  it('persists the localStorage preference', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    writeUseReleaseBranch(false, storage)
    expect(values.get(USE_RELEASE_BRANCH_STORAGE_KEY)).toBe('false')
    expect(readUseReleaseBranch(storage)).toBe(false)
    writeUseReleaseBranch(true, storage)
    expect(readUseReleaseBranch(storage)).toBe(true)
  })

  it('returns one hop when the release branch is skipped', () => {
    expect(promotionRoutes(false)).toEqual(['dev-to-default'])
    expect(backMergeRoutes(false)).toEqual(['default-to-dev'])
    expect(promotionBranches('dev-to-default', 'main')).toEqual({
      fromBranch: 'dev',
      toBranch: 'main',
    })
    expect(backMergeBranches('default-to-dev', 'master')).toEqual({
      fromBranch: 'master',
      toBranch: 'dev',
    })
    expect(promotionRouteLabel('dev-to-default')).toBe('Dev → Default')
  })

  it('accepts both promotion and back-merge pull families', () => {
    expect(isPromotionPullRoute('dev', 'release', 'main')).toBe(true)
    expect(isPromotionPullRoute('release', 'main', 'main')).toBe(true)
    expect(isPromotionPullRoute('dev', 'main', 'main')).toBe(true)
    expect(isPromotionPullRoute('feature', 'dev', 'main')).toBe(false)
    expect(isBackMergePullRoute('main', 'release', 'main')).toBe(true)
    expect(isBackMergePullRoute('release', 'dev', 'main')).toBe(true)
    expect(isBackMergePullRoute('main', 'dev', 'main')).toBe(true)
    expect(isBackMergePullRoute('dev', 'main', 'main')).toBe(false)
  })
})

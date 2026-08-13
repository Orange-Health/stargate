import type { BackMergeRoute, PromotionRoute } from './types.js'

export const USE_RELEASE_BRANCH_STORAGE_KEY = 'release-desk-use-release-branch'

export function readUseReleaseBranch(
  storage: Pick<Storage, 'getItem'> | null | undefined = globalThis.localStorage,
): boolean {
  try {
    return storage?.getItem(USE_RELEASE_BRANCH_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

export function writeUseReleaseBranch(
  value: boolean,
  storage:
    | Pick<Storage, 'getItem' | 'setItem'>
    | null
    | undefined = globalThis.localStorage,
) {
  try {
    storage?.setItem(USE_RELEASE_BRANCH_STORAGE_KEY, value ? 'true' : 'false')
  } catch {
    // Preference still applies in memory when browser storage is unavailable.
  }
}

export function parseUseReleaseBranch(value: unknown): boolean {
  if (Array.isArray(value)) return parseUseReleaseBranch(value[0])
  return value !== false && value !== 'false'
}

export function promotionRoutes(useReleaseBranch: boolean): PromotionRoute[] {
  return useReleaseBranch
    ? ['dev-to-release', 'release-to-default']
    : ['dev-to-default']
}

export function backMergeRoutes(useReleaseBranch: boolean): BackMergeRoute[] {
  return useReleaseBranch
    ? ['default-to-release', 'release-to-dev']
    : ['default-to-dev']
}

export function promotionBranches(
  route: PromotionRoute,
  defaultBranch: string,
) {
  if (route === 'dev-to-release') {
    return { fromBranch: 'dev', toBranch: 'release' }
  }
  if (route === 'dev-to-default') {
    return { fromBranch: 'dev', toBranch: defaultBranch }
  }
  return { fromBranch: 'release', toBranch: defaultBranch }
}

export function backMergeBranches(
  route: BackMergeRoute,
  defaultBranch: string,
) {
  if (route === 'default-to-release') {
    return { fromBranch: defaultBranch, toBranch: 'release' }
  }
  if (route === 'default-to-dev') {
    return { fromBranch: defaultBranch, toBranch: 'dev' }
  }
  return { fromBranch: 'release', toBranch: 'dev' }
}

export function promotionRouteLabel(route: PromotionRoute) {
  if (route === 'dev-to-release') return 'Dev → Release'
  if (route === 'dev-to-default') return 'Dev → Default'
  return 'Release → Default'
}

export function isPromotionPullRoute(
  head: string,
  base: string,
  defaultBranch: string,
) {
  return (
    (head === 'dev' && base === 'release') ||
    (head === 'release' && base === defaultBranch) ||
    (head === 'dev' && base === defaultBranch)
  )
}

export function isBackMergePullRoute(
  head: string,
  base: string,
  defaultBranch: string,
) {
  return (
    (head === defaultBranch && base === 'release') ||
    (head === 'release' && base === 'dev') ||
    (head === defaultBranch && base === 'dev')
  )
}

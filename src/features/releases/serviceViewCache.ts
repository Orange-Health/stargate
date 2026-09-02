export const SERVICE_VIEW_CACHE_MS = 60_000

type CacheEntry<T> = {
  cachedAt: number
  value: T
}

const store = new Map<string, CacheEntry<unknown>>()

export function readServiceViewCache<T>(key: string): T | undefined {
  const entry = store.get(key) as CacheEntry<T> | undefined
  if (!entry) return undefined
  if (Date.now() - entry.cachedAt >= SERVICE_VIEW_CACHE_MS) return undefined
  return entry.value
}

export function peekServiceViewCache<T>(key: string): T | undefined {
  return (store.get(key) as CacheEntry<T> | undefined)?.value
}

export function writeServiceViewCache<T>(key: string, value: T) {
  store.set(key, { cachedAt: Date.now(), value })
}

export function clearServiceViewCache(prefix?: string) {
  if (!prefix) {
    store.clear()
    return
  }
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key)
  }
}

export function releaseDataCacheKey(
  repository: string,
  includeAllVReleases: boolean,
) {
  return `releases:${repository}:${includeAllVReleases ? 'all' : 'staging'}`
}

export function branchStateCacheKey(
  repository: string,
  useReleaseBranch: boolean,
) {
  return `branches:${repository}:${useReleaseBranch ? 'release' : 'direct'}`
}

export function pullRequestCacheKey(
  repository: string,
  state: string,
  base: string,
  author: string,
  page: number,
) {
  return `prs:${repository}:${state}:${base}:${author}:${page}`
}

export function pullRequestAuthorsCacheKey(repository: string) {
  return `pr-authors:${repository}`
}

export function eitriBuildsCacheKey(repository: string) {
  return `eitri:${repository}`
}

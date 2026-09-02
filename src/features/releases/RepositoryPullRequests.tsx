import { useEffect, useRef, useState } from 'react'
import { api } from '../../shared/api'
import { Skeleton } from '../../shared/Skeleton'
import type {
  RepositoryPullRequest,
  RepositoryPullRequestList,
} from '../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { readUseReleaseBranch } from '../../shared/branchModel'
import {
  pullRequestAuthorsCacheKey,
  pullRequestCacheKey,
  readServiceViewCache,
  writeServiceViewCache,
} from './serviceViewCache'

type Props = {
  repository: string
}

function relativeDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Recently updated'
    : `Updated ${date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}`
}

export function RepositoryPullRequests({ repository }: Props) {
  const useReleaseBranch = readUseReleaseBranch()
  const [stateFilter, setStateFilter] = useState<'open' | 'closed' | 'all'>(
    'open',
  )
  const [baseFilter, setBaseFilter] = useState('')
  const [authorFilter, setAuthorFilter] = useState('')
  const [authors, setAuthors] = useState<string[]>(
    () => readServiceViewCache(pullRequestAuthorsCacheKey(repository)) ?? [],
  )
  const [authorsLoading, setAuthorsLoading] = useState(
    () => !readServiceViewCache(pullRequestAuthorsCacheKey(repository)),
  )
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<RepositoryPullRequestList | undefined>(
    () =>
      readServiceViewCache(
        pullRequestCacheKey(repository, 'open', '', '', 1),
      ),
  )
  const [loading, setLoading] = useState(
    () =>
      !readServiceViewCache(
        pullRequestCacheKey(repository, 'open', '', '', 1),
      ),
  )
  const [error, setError] = useState('')
  const [pendingMerge, setPendingMerge] = useState<RepositoryPullRequest>()
  const [merging, setMerging] = useState<number>()
  const [reload, setReload] = useState(0)
  const previousReload = useRef(reload)
  const filtersRepository = useRef(repository)
  if (filtersRepository.current !== repository) {
    filtersRepository.current = repository
    if (page !== 1) setPage(1)
    if (baseFilter) setBaseFilter('')
    if (authorFilter) setAuthorFilter('')
    const cached = readServiceViewCache<RepositoryPullRequestList>(
      pullRequestCacheKey(repository, stateFilter, '', '', 1),
    )
    setResult(cached)
    setLoading(!cached)
    setError('')
    const cachedAuthors = readServiceViewCache<string[]>(
      pullRequestAuthorsCacheKey(repository),
    )
    setAuthors(cachedAuthors ?? [])
    setAuthorsLoading(!cachedAuthors)
  }

  useEffect(() => {
    if (!useReleaseBranch && baseFilter === 'release') setBaseFilter('')
  }, [baseFilter, useReleaseBranch])

  useEffect(() => {
    const cacheKey = pullRequestAuthorsCacheKey(repository)
    const cached = readServiceViewCache<string[]>(cacheKey)
    if (cached) {
      setAuthors(cached)
      setAuthorsLoading(false)
      return
    }

    let active = true
    setAuthorsLoading(true)
    api
      .repositoryPullRequestAuthors(repository)
      .then((next) => {
        if (!active) return
        writeServiceViewCache(cacheKey, next)
        setAuthors(next)
      })
      .catch(() => {
        if (active) setAuthors([])
      })
      .finally(() => {
        if (active) setAuthorsLoading(false)
      })
    return () => {
      active = false
    }
  }, [repository])

  useEffect(() => {
    const force = reload !== previousReload.current
    previousReload.current = reload
    const cacheKey = pullRequestCacheKey(
      repository,
      stateFilter,
      baseFilter,
      authorFilter,
      page,
    )
    if (!force) {
      const cached = readServiceViewCache<RepositoryPullRequestList>(cacheKey)
      if (cached) {
        setResult(cached)
        setLoading(false)
        setError('')
        return
      }
    }

    let active = true
    setResult((current) =>
      current?.repository === repository ? current : undefined,
    )
    setLoading(true)
    setError('')
    api
      .repositoryPullRequests(repository, {
        state: stateFilter,
        base: baseFilter || undefined,
        author: authorFilter || undefined,
        page,
      })
      .then((next) => {
        if (!active) return
        writeServiceViewCache(cacheKey, next)
        setResult(next)
      })
      .catch((reason) => {
        if (!active) return
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not load pull requests.',
        )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [authorFilter, baseFilter, page, reload, repository, stateFilter])

  async function mergePullRequest(pull: RepositoryPullRequest) {
    setPendingMerge(undefined)
    setMerging(pull.number)
    setError('')
    try {
      const merged = await api.mergeRepositoryPullRequest({
        repository,
        pullNumber: pull.number,
      })
      if (!merged.merged) throw new Error(merged.message)
      setReload((current) => current + 1)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not merge this PR.',
      )
    } finally {
      setMerging(undefined)
    }
  }

  const branchOptions = [
    'dev',
    ...(useReleaseBranch ? ['release'] : []),
    ...(result?.defaultBranch &&
    !['dev', 'release'].includes(result.defaultBranch)
      ? [result.defaultBranch]
      : []),
  ]

  return (
    <div className="repository-pr-panel">
      <div className="repository-pr-toolbar">
        <label>
          State
          <select
            value={stateFilter}
            onChange={(event) => {
              setStateFilter(event.target.value as 'open' | 'closed' | 'all')
              setPage(1)
            }}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Base branch
          <select
            value={baseFilter}
            onChange={(event) => {
              setBaseFilter(event.target.value)
              setPage(1)
            }}
          >
            <option value="">Any branch</option>
            {branchOptions.map((branch) => (
              <option value={branch} key={branch}>
                {branch}
              </option>
            ))}
          </select>
        </label>
        <label>
          Author
          <select
            value={authorFilter}
            onChange={(event) => {
              setAuthorFilter(event.target.value)
              setPage(1)
            }}
            aria-label="Author"
            disabled={authorsLoading}
          >
            <option value="">
              {authorsLoading ? 'Loading authors…' : 'All authors'}
            </option>
            {authors.map((author) => (
              <option value={author} key={author}>
                {author}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary-button"
          type="button"
          onClick={() => setReload((current) => current + 1)}
          disabled={loading}
        >
          {loading ? 'Loading…' : '↻ Refresh PRs'}
        </button>
      </div>

      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}

      {loading && !result ? (
        <div
          className="repository-pr-list skeleton-list"
          role="status"
          aria-label="Loading pull requests"
        >
          {Array.from({ length: 4 }, (_, index) => (
            <article className="repository-pr-row skeleton-pr-row" key={index}>
              <div className="repository-pr-main">
                <Skeleton className="skeleton-pr-title" />
                <div className="skeleton-pr-branches">
                  <Skeleton className="skeleton-branch-name" />
                  <Skeleton className="skeleton-branch-arrow" />
                  <Skeleton className="skeleton-branch-name" />
                </div>
                <Skeleton className="skeleton-pr-meta" />
              </div>
              <Skeleton className="skeleton-action" />
            </article>
          ))}
        </div>
      ) : result?.items.length ? (
        <div className="repository-pr-list">
          {result.items.map((pull) => (
            <article className="repository-pr-row" key={pull.number}>
              <div className="repository-pr-main">
                <div className="repository-pr-title">
                  <a href={pull.url} target="_blank" rel="noreferrer">
                    #{pull.number} {pull.title}
                  </a>
                  <span
                    className={`status-pill ${
                      pull.merged
                        ? 'merged'
                        : pull.state === 'open'
                          ? 'ready'
                          : 'closed'
                    }`}
                  >
                    {pull.merged ? 'Merged' : pull.draft ? 'Draft' : pull.state}
                  </span>
                </div>
                <p className="branch-line">
                  <code>{pull.headBranch}</code>
                  <span>→</span>
                  <code>{pull.baseBranch}</code>
                </p>
                <small>
                  {pull.author} · {relativeDate(pull.updatedAt)}
                </small>
              </div>
              {pull.state === 'open' && !pull.draft && !pull.merged && (
                <button
                  className="merge-feature-button"
                  type="button"
                  onClick={() => setPendingMerge(pull)}
                  disabled={merging !== undefined}
                >
                  {merging === pull.number ? 'Merging…' : 'Merge'}
                </button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="repositories-message">
          No pull requests match these filters.
        </div>
      )}

      <div className="repository-pr-pagination">
        <button
          className="secondary-button"
          type="button"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={page === 1 || loading}
        >
          Previous
        </button>
        <span>Page {page}</span>
        <button
          className="secondary-button"
          type="button"
          onClick={() => setPage((current) => current + 1)}
          disabled={!result?.hasMore || loading}
        >
          Next
        </button>
      </div>

      {pendingMerge && (
        <ConfirmDialog
          title={`Merge PR #${pendingMerge.number}?`}
          message={`Merge “${pendingMerge.title}” from ${pendingMerge.headBranch} into ${pendingMerge.baseBranch}?\n\nGitHub branch protection and required checks still apply.`}
          confirmLabel="Merge PR"
          onCancel={() => setPendingMerge(undefined)}
          onConfirm={() => void mergePullRequest(pendingMerge)}
        />
      )}
    </div>
  )
}

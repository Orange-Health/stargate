import { useEffect, useMemo, useState } from 'react'
import { api } from '../../shared/api'
import type { CreatedStagingRelease } from '../../shared/types'
import { DialogBackdrop } from './DialogBackdrop'

type Props = {
  repositories: string[]
  releaseDate: string
  releaseName: string
  onClose: () => void
}

type ServiceResult =
  | { repository: string; status: 'pending' }
  | { repository: string; status: 'success'; release: CreatedStagingRelease }
  | { repository: string; status: 'error'; message: string }

const QA_SOURCE_BRANCH = 'dev'
const MAX_CONCURRENCY = 4

function localDate() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function tagPreview(date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return 'Select a valid date'
  return `v-qa-${match[1].slice(-2)}.${match[2]}${match[3]}.N`
}

function serviceName(repository: string) {
  return repository.split('/').at(-1) ?? repository
}

function githubTagUrl(repository: string, tag: string) {
  return `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`
}

async function mapConcurrent(
  repositories: string[],
  task: (repository: string) => Promise<void>,
) {
  let cursor = 0
  async function worker() {
    while (cursor < repositories.length) {
      const repository = repositories[cursor++]
      await task(repository)
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENCY, repositories.length) },
      () => worker(),
    ),
  )
}

export function BulkQaReleaseDialog({
  repositories,
  releaseDate,
  releaseName,
  onClose,
}: Props) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)
    ? releaseDate
    : localDate()
  const [creating, setCreating] = useState(false)
  const [started, setStarted] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(repositories),
  )
  const [existingTags, setExistingTags] = useState<Record<string, string[]>>({})
  const [tagsLoading, setTagsLoading] = useState(repositories.length > 0)
  const [results, setResults] = useState<ServiceResult[]>(() =>
    repositories.map((repository) => ({ repository, status: 'pending' })),
  )

  const repositoryKey = repositories.join(',')

  useEffect(() => {
    const repos = repositoryKey ? repositoryKey.split(',') : []
    if (repos.length === 0) return
    let active = true
    setTagsLoading(true)
    api
      .listStagingTags({
        repositories: repos,
        environment: 'qa',
        date,
      })
      .then((items) => {
        if (!active) return
        const next: Record<string, string[]> = {}
        for (const item of items) next[item.repository] = item.tags
        setExistingTags(next)
      })
      .catch(() => {
        if (!active) return
        setExistingTags({})
      })
      .finally(() => {
        if (active) setTagsLoading(false)
      })
    return () => {
      active = false
    }
  }, [date, repositoryKey])

  const selectedRepositories = useMemo(
    () => repositories.filter((repository) => selected.has(repository)),
    [repositories, selected],
  )
  const successCount = results.filter(
    (result) => result.status === 'success',
  ).length
  const errorCount = results.filter((result) => result.status === 'error').length
  const finished = started && !creating
  const allSelected = selectedRepositories.length === repositories.length
  const someSelected =
    selectedRepositories.length > 0 && !allSelected

  function toggleRepository(repository: string) {
    if (creating) return
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(repository)) next.delete(repository)
      else next.add(repository)
      return next
    })
  }

  function toggleAll(checked: boolean) {
    if (creating) return
    setSelected(checked ? new Set(repositories) : new Set())
  }

  async function createSelected() {
    if (creating || selectedRepositories.length === 0) return
    setCreating(true)
    setStarted(true)
    setResults(
      selectedRepositories.map((repository) => ({
        repository,
        status: 'pending',
      })),
    )

    await mapConcurrent(selectedRepositories, async (repository) => {
      try {
        const release = await api.createStagingRelease({
          repository,
          environment: 'qa',
          date,
          sourceBranch: QA_SOURCE_BRANCH,
        })
        setResults((current) =>
          current.map((result) =>
            result.repository === repository
              ? { repository, status: 'success', release }
              : result,
          ),
        )
        window.dispatchEvent(
          new CustomEvent('staging-release-created', {
            detail: { repository, release },
          }),
        )
      } catch (reason) {
        setResults((current) =>
          current.map((result) =>
            result.repository === repository
              ? {
                  repository,
                  status: 'error',
                  message:
                    reason instanceof Error
                      ? reason.message
                      : 'Could not create the QA tag.',
                }
              : result,
          ),
        )
      }
    })

    setCreating(false)
  }

  const visibleRepositories = started ? selectedRepositories : repositories

  return (
    <DialogBackdrop onMouseDown={onClose}>
      <section
        className="release-dialog bulk-qa-release-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-qa-release-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="dialog-close"
          type="button"
          onClick={onClose}
          aria-label="Close"
          disabled={creating}
        >
          ×
        </button>

        <p className="eyebrow">QA tags · {releaseName}</p>
        <h2 id="bulk-qa-release-title">
          {finished
            ? `Created ${successCount}/${selectedRepositories.length} QA tags`
            : 'Create QA tags'}
        </h2>
        <p className="dialog-copy">
          {finished
            ? errorCount > 0
              ? `${errorCount} service(s) failed. Review the list below and retry those services individually if needed.`
              : 'GitHub pre-release tags were created from dev for the selected services.'
            : `Create a QA pre-release tag from ${QA_SOURCE_BRANCH} for the services you keep selected. Existing tags for this release day are shown below.`}
        </p>

        <div className="tag-preview">
          <span>Tag pattern</span>
          <code>{tagPreview(date)}</code>
          <small>
            Date {date} · source branch {QA_SOURCE_BRANCH} · N is set per
            repository after checking existing tags.
          </small>
        </div>

        {!started && repositories.length > 0 && (
          <label className="bulk-qa-select-all">
            <input
              type="checkbox"
              checked={allSelected}
              aria-label="Select all services"
              ref={(input) => {
                if (input) input.indeterminate = someSelected
              }}
              onChange={(event) => toggleAll(event.target.checked)}
              disabled={creating}
            />
            {selectedRepositories.length} of {repositories.length} selected
          </label>
        )}

        <ul className="bulk-qa-service-list" aria-label="Services">
          {visibleRepositories.map((repository) => {
            const result = results.find(
              (item) => item.repository === repository,
            ) ?? { repository, status: 'pending' as const }
            const tags = existingTags[repository] ?? []
            const latestTag = tags.at(-1)
            const checked = selected.has(repository)
            const tagStatus = tagsLoading ? (
              <small>Loading tags…</small>
            ) : latestTag ? (
              <a
                href={githubTagUrl(repository, latestTag)}
                target="_blank"
                rel="noreferrer"
              >
                {latestTag}
              </a>
            ) : (
              <small>No tags yet</small>
            )
            return (
              <li
                key={repository}
                className={`bulk-qa-${result.status}${
                  !started && !checked ? ' bulk-qa-unselected' : ''
                }`}
              >
                {!started ? (
                  <label className="bulk-qa-service-select">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRepository(repository)}
                      disabled={creating}
                      aria-label={`Include ${serviceName(repository)}`}
                    />
                    <strong>{serviceName(repository)}</strong>
                    {tagStatus}
                  </label>
                ) : (
                  <>
                    <strong>{serviceName(repository)}</strong>
                    {result.status === 'pending' && (
                      <span>{creating ? 'Creating…' : 'Queued'}</span>
                    )}
                    {result.status === 'success' && (
                      <a
                        href={result.release.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {result.release.tag}
                      </a>
                    )}
                    {result.status === 'error' && (
                      <span title={result.message}>{result.message}</span>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>

        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={onClose}
            disabled={creating}
          >
            {finished ? 'Close' : 'Cancel'}
          </button>
          {!finished && (
            <button
              className="primary-button"
              type="button"
              onClick={() => void createSelected()}
              disabled={creating || selectedRepositories.length === 0}
            >
              {creating
                ? 'Creating QA tags…'
                : selectedRepositories.length > 0
                  ? `Create QA tags (${selectedRepositories.length})`
                  : 'Select services to create tags'}
            </button>
          )}
        </div>
      </section>
    </DialogBackdrop>
  )
}

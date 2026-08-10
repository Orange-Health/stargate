import { useState } from 'react'
import { api } from '../../shared/api'
import type { CreatedStagingRelease } from '../../shared/types'

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
  const [results, setResults] = useState<ServiceResult[]>(() =>
    repositories.map((repository) => ({ repository, status: 'pending' })),
  )

  const successCount = results.filter(
    (result) => result.status === 'success',
  ).length
  const errorCount = results.filter((result) => result.status === 'error').length
  const finished = started && !creating

  async function createAll() {
    if (creating || repositories.length === 0) return
    setCreating(true)
    setStarted(true)
    setResults(
      repositories.map((repository) => ({ repository, status: 'pending' })),
    )

    await mapConcurrent(repositories, async (repository) => {
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
            detail: { repository },
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

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
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
            ? `Created ${successCount}/${repositories.length} QA tags`
            : 'Create QA tags for all services'}
        </h2>
        <p className="dialog-copy">
          {finished
            ? errorCount > 0
              ? `${errorCount} service(s) failed. Review the list below and retry those services individually if needed.`
              : 'GitHub pre-release tags were created from dev for every service in this release.'
            : `Create a QA pre-release tag from ${QA_SOURCE_BRANCH} for each of the ${repositories.length} services in this release.`}
        </p>

        <div className="tag-preview">
          <span>Tag pattern</span>
          <code>{tagPreview(date)}</code>
          <small>
            Date {date} · source branch {QA_SOURCE_BRANCH} · N is set per
            repository after checking existing tags.
          </small>
        </div>

        <ul className="bulk-qa-service-list" aria-label="Services">
          {results.map((result) => (
            <li key={result.repository} className={`bulk-qa-${result.status}`}>
              <div>
                <strong>{serviceName(result.repository)}</strong>
                <small>{result.repository}</small>
              </div>
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
            </li>
          ))}
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
              onClick={() => void createAll()}
              disabled={creating || repositories.length === 0}
            >
              {creating
                ? 'Creating QA tags…'
                : `Create QA tags (${repositories.length})`}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

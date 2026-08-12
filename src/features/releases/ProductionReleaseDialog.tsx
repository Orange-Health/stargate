import { useState, type FormEvent } from 'react'
import { api } from '../../shared/api'
import type {
  CreatedProductionRelease,
  ProductionReleaseMode,
} from '../../shared/types'
import {
  nextPatchProductionTagPreview,
  releaseDayProductionTagPreview,
} from './productionTags'

type Props = {
  readonly repository: string
  readonly latestProductionTag?: string
  readonly onClose: () => void
}

function localDate() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function patchStatusCopy(latestTag: string | undefined) {
  if (latestTag) return `Patches the latest production tag (${latestTag}).`
  return 'No production tag found yet. Use Release day to create the first tag.'
}

export function ProductionReleaseDialog({
  repository,
  latestProductionTag,
  onClose,
}: Props) {
  const [mode, setMode] = useState<ProductionReleaseMode>('patch')
  const [date, setDate] = useState(localDate)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<CreatedProductionRelease>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    setError('')
    try {
      const result = await api.createProductionRelease({
        repository,
        mode,
        ...(mode === 'release-day' ? { date } : {}),
      })
      setCreated(result)
      window.dispatchEvent(
        new CustomEvent('production-release-created', {
          detail: { repository, release: result },
        }),
      )
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not create the production release.',
      )
    } finally {
      setCreating(false)
    }
  }

  if (created) {
    return (
      <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
        <section
          className="release-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="production-release-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            className="dialog-close"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
          <div className="release-created">
            <span className="created-icon" aria-hidden="true">
              ✓
            </span>
            <p className="eyebrow">Production release created</p>
            <h2 id="production-release-title">{created.tag}</h2>
            <p>
              GitHub created this production tag from the default branch{' '}
              <code>{created.sourceBranch}</code>.
            </p>
            <a
              className="primary-button release-link"
              href={created.url}
              target="_blank"
              rel="noreferrer"
            >
              Open GitHub release <span aria-hidden="true">↗</span>
            </a>
            <button className="text-button done-button" type="button" onClick={onClose}>
              Done
            </button>
          </div>
        </section>
      </div>
    )
  }

  const tagPreview =
    mode === 'release-day'
      ? releaseDayProductionTagPreview(repository, date)
      : nextPatchProductionTagPreview(repository, latestProductionTag)
  const submitDisabled =
    creating || (mode === 'patch' && !latestProductionTag)

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="release-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="production-release-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="dialog-close"
          type="button"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
        <p className="eyebrow">Production</p>
        <h2 id="production-release-title">Create production release</h2>
        <p className="dialog-copy">
          A production release tag will be created from the latest commit on the
          repository&apos;s default <code>main/master</code> branch.
        </p>
        <form onSubmit={submit}>
          <label>
            Repository
            <input value={repository} disabled />
          </label>
          <label className="deployment-checkbox">
            <input
              type="checkbox"
              checked={mode === 'release-day'}
              onChange={(event) =>
                setMode(event.target.checked ? 'release-day' : 'patch')
              }
            />
            Release day
          </label>
          {mode === 'release-day' ? (
            <label>
              Release date
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </label>
          ) : (
            <p className="dialog-copy">{patchStatusCopy(latestProductionTag)}</p>
          )}
          <div className="tag-preview">
            <span>Tag {mode === 'release-day' ? 'pattern' : 'preview'}</span>
            <code>{tagPreview}</code>
            <small>
              {mode === 'release-day'
                ? 'N is automatically incremented after checking existing tags.'
                : 'Increments the patch on the latest production tag.'}
            </small>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          <div className="dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={submitDisabled}
            >
              {creating ? 'Creating release…' : 'Create production release'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

import { useState, type FormEvent } from 'react'
import { api } from '../../shared/api'
import { usesFrontendProductionTag } from '../../shared/productionRepositories'
import type { CreatedProductionRelease } from '../../shared/types'

type Props = {
  repository: string
  onClose: () => void
}

function localDate() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function tagPreview(repository: string, date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return 'Select a valid date'
  const prefix = usesFrontendProductionTag(repository) ? 'v-prod-' : 'v'
  return `${prefix}${match[1].slice(-2)}.${match[2]}${match[3]}.N`
}

export function ProductionReleaseDialog({ repository, onClose }: Props) {
  const [date, setDate] = useState(localDate)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<CreatedProductionRelease>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    setError('')
    try {
      const result = await api.createProductionRelease({ repository, date })
      setCreated(result)
      window.dispatchEvent(
        new CustomEvent('production-release-created', {
          detail: { repository },
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
        {created ? (
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
            <button className="text-button done-button" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <p className="eyebrow">Production</p>
            <h2 id="production-release-title">Create production release</h2>
            <p className="dialog-copy">
              A production release tag will be created from the latest commit
              on the repository&apos;s default <code>main/master</code> branch.
            </p>
            <form onSubmit={submit}>
              <label>
                Repository
                <input value={repository} disabled />
              </label>
              <label>
                Release date
                <input
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  required
                />
              </label>
              <div className="tag-preview">
                <span>Tag pattern</span>
                <code>{tagPreview(repository, date)}</code>
                <small>
                  N is automatically incremented after checking existing tags.
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
                  disabled={creating}
                >
                  {creating ? 'Creating release…' : 'Create production release'}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  )
}

import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../../shared/api'
import type {
  CreatedStagingRelease,
  StagingEnvironment,
} from '../../shared/types'

type Props = {
  repository: string
  releaseDate: string
  allowBranchSelection?: boolean
  onClose: () => void
}

const environments: Array<{
  value: StagingEnvironment
  label: string
}> = [
  { value: 'qa', label: 'QA' },
  { value: 's1', label: 'S1' },
  { value: 's2', label: 'S2' },
  { value: 's3', label: 'S3' },
  { value: 's4', label: 'S4' },
  { value: 's5', label: 'S5' },
  { value: 's6', label: 'S6' },
]

function localDate() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function tagPreview(environment: StagingEnvironment, date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return 'Select a valid date'
  return `v-${environment}-${match[1].slice(-2)}.${match[2]}${match[3]}.N`
}

export function StagingReleaseDialog({
  repository,
  releaseDate,
  allowBranchSelection = false,
  onClose,
}: Props) {
  const [environment, setEnvironment] = useState<StagingEnvironment>('qa')
  const [sourceBranch, setSourceBranch] = useState('dev')
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<CreatedStagingRelease>()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)
    ? releaseDate
    : localDate()

  useEffect(() => {
    if (!allowBranchSelection) return
    let active = true
    setBranchesLoading(true)
    api
      .repositoryBranches(repository)
      .then((items) => {
        if (active) setBranches(items)
      })
      .catch(() => {
        if (active) setBranches([])
      })
      .finally(() => {
        if (active) setBranchesLoading(false)
      })
    return () => {
      active = false
    }
  }, [allowBranchSelection, repository])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    setError('')
    try {
      const result = await api.createStagingRelease({
        repository,
        environment,
        date,
        sourceBranch,
      })
      setCreated(result)
      window.dispatchEvent(
        new CustomEvent('staging-release-created', {
          detail: { repository },
        }),
      )
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not create the staging release.',
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
        aria-labelledby="staging-release-title"
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
            <p className="eyebrow">Pre-release created</p>
            <h2 id="staging-release-title">{created.tag}</h2>
            <p>
              GitHub created this tag from <code>{created.sourceBranch}</code>.
              The matching workflow can now build the staging image.
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
            <p className="eyebrow">Staging only</p>
            <h2 id="staging-release-title">Create GitHub release</h2>
            <p className="dialog-copy">
              A pre-release tag will be created from the latest commit on{' '}
              <code>{sourceBranch}</code>.
            </p>

            <form onSubmit={submit}>
              <label>
                Repository
                <input value={repository} disabled />
              </label>
              <label>
                Environment
                <select
                  value={environment}
                  onChange={(event) =>
                    setEnvironment(event.target.value as StagingEnvironment)
                  }
                >
                  {environments.map((item) => (
                    <option value={item.value} key={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {allowBranchSelection && (
                <label>
                  Source branch
                  <input
                    type="search"
                    list="staging-source-branches"
                    value={sourceBranch}
                    onChange={(event) => setSourceBranch(event.target.value)}
                    placeholder={
                      branchesLoading ? 'Loading branches…' : 'Search branches'
                    }
                    autoComplete="off"
                    required
                  />
                  <datalist id="staging-source-branches">
                    {branches.map((branch) => (
                      <option value={branch} key={branch} />
                    ))}
                  </datalist>
                </label>
              )}
              <div className="tag-preview">
                <span>Tag pattern</span>
                <code>{tagPreview(environment, date)}</code>
                <small>
                  N is automatically set after checking existing tags.
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
                  {creating ? 'Creating release…' : 'Create pre-release'}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  )
}

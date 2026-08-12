import { DialogBackdrop } from './DialogBackdrop'
import type { ReleaseDeveloper } from './releaseDevelopers'

type Props = {
  repository: string
  developers: ReleaseDeveloper[]
  loading?: boolean
  onClose: () => void
  eyebrow?: string
  title?: string
  emptyMessage?: string
}

export function ReleaseDevelopersDialog({
  repository,
  developers,
  loading = false,
  onClose,
  eyebrow = 'Release contributors',
  title,
  emptyMessage = "No developers were found on this service's release PRs.",
}: Props) {
  const dialogTitle =
    title ?? `${repository.split('/').at(-1)} Developers`

  return (
    <DialogBackdrop onMouseDown={onClose}>
      <section
        className="release-dialog release-developers-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-developers-title"
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
        <p className="eyebrow">{eyebrow}</p>
        <h2 id="release-developers-title">{dialogTitle}</h2>
        {loading ? (
          <div className="operation-loading">
            <span className="spinner" /> Loading developers…
          </div>
        ) : developers.length > 0 ? (
          <div className="release-developer-list">
            {developers.map((developer) => (
              <article key={developer.login}>
                <img src={developer.avatarUrl} alt="" />
                <div>
                  <strong>{developer.login}</strong>
                  <small>
                    {developer.roles.join(', ')} ·{' '}
                    {developer.pullRequests.length}{' '}
                    {developer.pullRequests.length === 1 ? 'PR' : 'PRs'}
                  </small>
                </div>
                <span>
                  {developer.pullRequests.map((pullNumber) => (
                    <a
                      href={`https://github.com/${repository}/pull/${pullNumber}`}
                      target="_blank"
                      rel="noreferrer"
                      key={pullNumber}
                    >
                      #{pullNumber}
                    </a>
                  ))}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <div className="operation-empty">{emptyMessage}</div>
        )}
      </section>
    </DialogBackdrop>
  )
}

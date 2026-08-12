import { useState } from 'react'
import type { JiraVersion } from '../../shared/types'
import { DialogBackdrop } from './DialogBackdrop'

type Props = {
  issueKey: string
  releaseName: string
  otherReleases: JiraVersion[]
  busy?: boolean
  onConfirm: (targetVersionId?: string) => void
  onCancel: () => void
}

export function RemoveTicketDialog({
  issueKey,
  releaseName,
  otherReleases,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const [targetVersionId, setTargetVersionId] = useState('')
  const moving = Boolean(targetVersionId)

  return (
    <DialogBackdrop onMouseDown={onCancel}>
      <section
        className="release-dialog confirm-dialog remove-ticket-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-ticket-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="remove-ticket-dialog-title">Remove {issueKey} from release?</h2>
        <p className="dialog-copy">
          This clears the ticket’s fix version from{' '}
          <strong>{releaseName}</strong>
          {moving
            ? ' and assigns it to the selected release.'
            : '. It will no longer appear in this release dashboard.'}
        </p>
        {otherReleases.length > 0 && (
          <label className="remove-ticket-target">
            <span>Move to another release (optional)</span>
            <select
              value={targetVersionId}
              onChange={(event) => setTargetVersionId(event.target.value)}
              disabled={busy}
              aria-label="Move to another release"
            >
              <option value="">Don’t move — just remove</option>
              {otherReleases.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => onConfirm(targetVersionId || undefined)}
            disabled={busy}
          >
            {busy
              ? 'Working…'
              : moving
                ? 'Remove and move'
                : 'Remove from release'}
          </button>
        </div>
      </section>
    </DialogBackdrop>
  )
}

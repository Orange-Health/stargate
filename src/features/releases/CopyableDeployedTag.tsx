import { useEffect, useState } from 'react'

type Props = {
  tag: string
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
      <rect
        x="5.5"
        y="5.5"
        width="8"
        height="8"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function CopyableDeployedTag({ tag }: Props) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 1_500)
    return () => window.clearTimeout(timeout)
  }, [copied])

  return (
    <div className={`copyable-deployed-tag${copied ? ' copied' : ''}`}>
      <span className="copyable-deployed-tag-label">Current</span>
      <code className="copyable-deployed-tag-value">{tag}</code>
      <button
        type="button"
        className="copyable-deployed-tag-copy"
        title={copied ? 'Copied' : 'Copy currently deployed tag for rollback'}
        aria-label={`Copy currently deployed tag ${tag}`}
        onClick={() => {
          void copyText(tag).then(() => setCopied(true))
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  )
}

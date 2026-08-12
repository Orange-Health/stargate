export type ReleasePlatform = 'gha' | 'eitri'

export function ReleasePlatformToggle({
  value,
  onChange,
}: {
  value: ReleasePlatform
  onChange: (platform: ReleasePlatform) => void
}) {
  return (
    <div
      className="overview-view-toggle release-platform-toggle"
      role="tablist"
      aria-label="Release platform"
    >
      <button
        type="button"
        role="tab"
        aria-selected={value === 'gha'}
        className={value === 'gha' ? 'active' : ''}
        onClick={() => onChange('gha')}
      >
        GitHub Actions
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'eitri'}
        className={value === 'eitri' ? 'active' : ''}
        onClick={() => onChange('eitri')}
      >
        Jenkins EITRI
      </button>
    </div>
  )
}

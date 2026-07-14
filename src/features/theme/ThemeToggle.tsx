import { useEffect, useState } from 'react'

type Theme = 'dark' | 'light'

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem('release-desk-theme') === 'light'
        ? 'light'
        : 'dark'
    } catch {
      return 'dark'
    }
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('release-desk-theme', theme)
    } catch {
      // The theme still applies when browser storage is unavailable.
    }
  }, [theme])

  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      className={`theme-toggle ${className}`.trim()}
      type="button"
      onClick={() => setTheme(nextTheme)}
      aria-label={`Switch to ${nextTheme} theme`}
      title={`Switch to ${nextTheme} theme`}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☼' : '◐'}</span>
      {nextTheme}
    </button>
  )
}

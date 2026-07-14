import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ThemeToggle } from './ThemeToggle'

afterEach(() => {
  localStorage.removeItem('release-desk-theme')
  delete document.documentElement.dataset.theme
})

describe('ThemeToggle', () => {
  it('switches to light theme and remembers the preference', async () => {
    const user = userEvent.setup()
    render(<ThemeToggle />)

    await user.click(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    )

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('release-desk-theme')).toBe('light')
    expect(
      screen.getByRole('button', { name: 'Switch to dark theme' }),
    ).toBeInTheDocument()
  })
})

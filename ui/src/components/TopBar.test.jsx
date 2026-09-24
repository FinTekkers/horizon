// HZ-21: the top-right avatar shows the real logged-in user's initials
// (Google account name or the hardcoded-login account), replacing the old
// literal "AP".

import { expect, test, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'

import TopBar from './TopBar'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  localStorage.removeItem('horizon_theme')
  delete document.documentElement.dataset.theme
})

const noop = () => {}

const baseProps = {
  view: 'board',
  pendingCount: 0,
  projects: [],
  activeProjectId: null,
  farm: { status: 'running' },
  onRequestSwitch: noop,
  onBoard: noop,
  onTracker: noop,
  onOpenApprovals: noop,
  onOpenAdmin: noop,
  onOpenDefinitions: noop,
}

test('the avatar button shows the logged-in user\'s initials, not a hardcoded value', () => {
  const user = { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace', initials: 'AL', authMethod: 'google' }
  render(<TopBar {...baseProps} user={user} onLogout={noop} />)
  expect(screen.getByRole('button', { name: 'AL' })).toBeTruthy()
})

test('opening the menu shows "Signed in as <name>" for the real user', () => {
  const user = { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace', initials: 'AL', authMethod: 'google' }
  render(<TopBar {...baseProps} user={user} onLogout={noop} />)
  fireEvent.click(screen.getByRole('button', { name: 'AL' }))
  expect(screen.getByText('Ada Lovelace')).toBeTruthy()
})

test('a different user renders their own initials (not a fixed "AP")', () => {
  const user = { id: 'u2', email: 'grace@example.com', name: 'Grace Hopper', initials: 'GH', authMethod: 'password' }
  render(<TopBar {...baseProps} user={user} onLogout={noop} />)
  expect(screen.getByRole('button', { name: 'GH' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'AP' })).toBeNull()
})

test('"Sign out" calls onLogout', () => {
  const user = { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace', initials: 'AL', authMethod: 'google' }
  const onLogout = vi.fn()
  render(<TopBar {...baseProps} user={user} onLogout={onLogout} />)
  fireEvent.click(screen.getByRole('button', { name: 'AL' }))
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(onLogout).toHaveBeenCalledTimes(1)
})

// ---- HZ-25: dark mode toggle ----

const user = { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace', initials: 'AL', authMethod: 'google' }

test('the user menu shows a "Dark mode" switch, off by default', () => {
  render(<TopBar {...baseProps} user={user} onLogout={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'AL' }))
  const toggle = screen.getByRole('switch', { name: 'Dark mode' })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})

test('clicking the switch turns on dark mode, sets the root attribute, and persists it', () => {
  render(<TopBar {...baseProps} user={user} onLogout={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'AL' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Dark mode' }))
  expect(screen.getByRole('switch', { name: 'Dark mode' }).getAttribute('aria-checked')).toBe('true')
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(localStorage.getItem('horizon_theme')).toBe('dark')
})

test('clicking the switch again turns dark mode back off', () => {
  render(<TopBar {...baseProps} user={user} onLogout={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'AL' }))
  const toggle = screen.getByRole('switch', { name: 'Dark mode' })
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(localStorage.getItem('horizon_theme')).toBe('light')
})

test('a previously-saved dark preference reflects in the switch on mount', () => {
  localStorage.setItem('horizon_theme', 'dark')
  render(<TopBar {...baseProps} user={user} onLogout={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'AL' }))
  expect(screen.getByRole('switch', { name: 'Dark mode' }).getAttribute('aria-checked')).toBe('true')
})

test('the switch is a real <button>, not a div — keyboard/AT operable by default', () => {
  render(<TopBar {...baseProps} user={user} onLogout={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'AL' }))
  const toggle = screen.getByRole('switch', { name: 'Dark mode' })
  expect(toggle.tagName).toBe('BUTTON')
})

test('toggling the theme does not close the user menu (unlike every other item)', () => {
  render(<TopBar {...baseProps} user={user} onLogout={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'AL' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Dark mode' }))
  expect(screen.getByRole('switch', { name: 'Dark mode' })).toBeTruthy()
  expect(screen.getByText('Ada Lovelace')).toBeTruthy()
})

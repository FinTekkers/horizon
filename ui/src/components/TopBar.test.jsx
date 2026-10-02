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
  projectFilter: 'all',
  onProjectFilterChange: noop,
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

// ---- HZ-208: a project filter, not a farm switcher ----

const PROJECTS = [
  { id: 1, name: 'Alpha', enabled: true },
  { id: 2, name: 'Beta', enabled: true },
  { id: 3, name: 'Gamma', enabled: false },
]
const USER = { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace', initials: 'AL', authMethod: 'google' }

test('the filter offers exactly All projects and the enabled projects, and never says restart', () => {
  render(<TopBar {...baseProps} projects={PROJECTS} projectFilter="all" onProjectFilterChange={noop} user={USER} onLogout={noop} />)
  fireEvent.click(document.querySelector('.projswitch'))
  expect(screen.getAllByRole('menuitemradio').map((b) => b.textContent.replace('✓', '').trim())).toEqual([
    'All projects',
    'Alpha',
    'Beta',
  ])
  expect(document.body.textContent).not.toMatch(/restart/i)
  expect(document.body.textContent).not.toMatch(/bot farm/i)
})

test('choosing a project only reports the choice', () => {
  const onChange = vi.fn()
  render(<TopBar {...baseProps} projects={PROJECTS} projectFilter="all" onProjectFilterChange={onChange} user={USER} onLogout={noop} />)
  fireEvent.click(document.querySelector('.projswitch'))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Beta' }))
  expect(onChange).toHaveBeenCalledWith(2)
  expect(screen.queryByRole('menu')).toBeNull()
})

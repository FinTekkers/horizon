// HZ-21: the top-right avatar shows the real logged-in user's initials
// (Google account name or the hardcoded-login account), replacing the old
// literal "AP".

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'

import TopBar from './TopBar'

afterEach(() => {
  cleanup()
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

// HZ-21: the top-right avatar shows the real logged-in user's initials
// (Google account name or the hardcoded-login account), replacing the old
// literal "AP".

import { expect, test, vi, afterEach, beforeEach } from 'vitest'
import { useState } from 'react'
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

// ---- HZ-317: narrow a project to some of its repos ----

const FIN = {
  id: 7,
  name: 'Fintekkers',
  enabled: true,
  repos: [
    { repo: 'FinTekkers/ledger-service', prefix: 'LS' },
    { repo: 'FinTekkers/ledger-models', prefix: 'LM' },
    { repo: 'FinTekkers/ledger-client', prefix: 'LC' },
  ],
}
const [LS, LM, LC] = FIN.repos.map((r) => r.repo)
const chip = (name) => screen.getByRole('button', { name })
const pressed = (name) => chip(name).getAttribute('aria-pressed')

// A controlled TopBar, so a chip click is reflected the way App reflects it.
function NarrowableBar({ onRepoFilterChange, initial = null }) {
  const [repos, setRepos] = useState(initial)
  return (
    <TopBar
      {...baseProps}
      projects={[FIN]}
      projectFilter={7}
      repoFilter={repos}
      onRepoFilterChange={(next) => {
        onRepoFilterChange(next)
        setRepos(next)
      }}
      user={USER}
      onLogout={noop}
    />
  )
}

test('a narrowed choice names its repos in the button aria-label', () => {
  render(<TopBar {...baseProps} projects={[FIN]} projectFilter={7} repoFilter={[LS, LM]} user={USER} onLogout={noop} />)
  expect(screen.getByRole('button', { name: 'Project filter: Fintekkers · LS, LM' })).toBeTruthy()
})

test('the repo chips are real buttons with aria-pressed, in a "Repos in <project>" group', () => {
  render(<TopBar {...baseProps} projects={[FIN]} projectFilter={7} repoFilter={[LS]} user={USER} onLogout={noop} />)
  fireEvent.click(document.querySelector('.projswitch'))
  const group = screen.getByRole('group', { name: 'Repos in Fintekkers' })
  const chips = [...group.querySelectorAll('button')]
  expect(chips.map((b) => b.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON'])
  expect(chips.map((b) => b.textContent)).toEqual(['LS · ledger-service', 'LM · ledger-models', 'LC · ledger-client'])
  expect(chips.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
  // The menu role holds only the radio list, never the chips.
  expect(screen.getByRole('menu').contains(group)).toBe(false)
})

test('toggling down to the last repo leaves it pressed; clicking it again changes nothing', () => {
  const onRepos = vi.fn()
  render(<NarrowableBar onRepoFilterChange={onRepos} />)
  fireEvent.click(document.querySelector('.projswitch'))
  expect([pressed('LS · ledger-service'), pressed('LM · ledger-models'), pressed('LC · ledger-client')]).toEqual([
    'true',
    'true',
    'true',
  ])
  fireEvent.click(chip('LM · ledger-models'))
  expect(onRepos).toHaveBeenLastCalledWith([LS, LC])
  fireEvent.click(chip('LC · ledger-client'))
  expect(onRepos).toHaveBeenLastCalledWith([LS])
  expect(onRepos).toHaveBeenCalledTimes(2)

  fireEvent.click(chip('LS · ledger-service'))
  expect(onRepos).toHaveBeenCalledTimes(2)
  expect(pressed('LS · ledger-service')).toBe('true')
  expect(chip('LS · ledger-service').getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('button', { name: 'Project filter: Fintekkers · LS' })).toBeTruthy()
})

test('"Select all" presses every chip and reports null (all repos); the menu stays open', () => {
  const onRepos = vi.fn()
  render(<NarrowableBar onRepoFilterChange={onRepos} initial={[LM]} />)
  fireEvent.click(document.querySelector('.projswitch'))
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
  expect(onRepos).toHaveBeenCalledWith(null)
  expect([pressed('LS · ledger-service'), pressed('LM · ledger-models'), pressed('LC · ledger-client')]).toEqual([
    'true',
    'true',
    'true',
  ])
  expect(screen.getByRole('group', { name: 'Repos in Fintekkers' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Project filter: Fintekkers' })).toBeTruthy()
})

test('re-selecting the last missing repo reports null rather than a full list', () => {
  const onRepos = vi.fn()
  render(<NarrowableBar onRepoFilterChange={onRepos} initial={[LS, LM]} />)
  fireEvent.click(document.querySelector('.projswitch'))
  fireEvent.click(chip('LC · ledger-client'))
  expect(onRepos).toHaveBeenCalledWith(null)
})

test('no chip group for All projects or a single-repo project', () => {
  const single = { id: 8, name: 'Solo', enabled: true, repos: [{ repo: 'Org/solo', prefix: 'SO' }] }
  const { unmount } = render(<TopBar {...baseProps} projects={[FIN, single]} projectFilter="all" user={USER} onLogout={noop} />)
  fireEvent.click(document.querySelector('.projswitch'))
  expect(screen.queryByRole('group')).toBeNull()
  unmount()
  render(<TopBar {...baseProps} projects={[FIN, single]} projectFilter={8} user={USER} onLogout={noop} />)
  fireEvent.click(document.querySelector('.projswitch'))
  expect(screen.queryByRole('group')).toBeNull()
})

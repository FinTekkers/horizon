// HZ-224: on a phone CSS shrinks the project switcher to dot + caret. The
// name is only visually hidden, so the button keeps it as its accessible
// name; the decorative dot, caret and icons are hidden from assistive tech.
// TopBar.test.jsx (desktop behaviour) is deliberately left untouched.

import { expect, test, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

import TopBar from './TopBar'

afterEach(() => {
  cleanup()
})

const noop = () => {}
const user = { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace', initials: 'AL', authMethod: 'google' }

const renderBar = () =>
  render(
    <TopBar
      view="board"
      pendingCount={2}
      projects={[{ id: 1, name: 'Shoreward', repos: [] }]}
      activeProjectId={1}
      farm={{ status: 'running' }}
      user={user}
      onLogout={noop}
      onRequestSwitch={noop}
      onBoard={noop}
      onTracker={noop}
      onOpenApprovals={noop}
      onOpenAdmin={noop}
      onOpenDefinitions={noop}
    />,
  )

test("the project switcher's accessible name is exactly the project name", () => {
  const { container } = renderBar()
  const button = screen.getByRole('button', { name: 'Shoreward' })
  expect(button).toBe(container.querySelector('.projswitch'))
  expect(button.querySelector('.projswitch__name').textContent).toBe('Shoreward')
})

test("the switcher's dot and caret are aria-hidden", () => {
  const { container } = renderBar()
  expect(container.querySelector('.projswitch__dot').getAttribute('aria-hidden')).toBe('true')
  expect(container.querySelector('.projswitch__caret').getAttribute('aria-hidden')).toBe('true')
})

test('the avatar is still named by the initials', () => {
  renderBar()
  expect(screen.getByRole('button', { name: 'AL' })).toBeTruthy()
})

test('every top-bar icon is aria-hidden and no focusable control sits inside aria-hidden', () => {
  const { container } = renderBar()
  const svgs = container.querySelectorAll('svg')
  expect(svgs.length).toBeGreaterThan(0)
  svgs.forEach((svg) => expect(svg.getAttribute('aria-hidden')).toBe('true'))
  container.querySelectorAll('button, a, [tabindex]').forEach((el) => {
    expect(el.closest('[aria-hidden="true"]')).toBeNull()
    expect(el.textContent.trim() || el.getAttribute('aria-label')).toBeTruthy()
  })
})

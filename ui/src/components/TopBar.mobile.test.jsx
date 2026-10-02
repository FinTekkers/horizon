// HZ-224: on a phone CSS shrinks HZ-208's project filter to dot + caret. The
// label is only visually hidden and the button keeps its aria-label name;
// the decorative dot, caret and icons are hidden from assistive tech.
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
      projects={[{ id: 1, name: 'Shoreward', enabled: true, repos: [] }]}
      projectFilter={1}
      onProjectFilterChange={noop}
      user={user}
      onLogout={noop}
      onBoard={noop}
      onTracker={noop}
      onOpenApprovals={noop}
      onOpenAdmin={noop}
      onOpenDefinitions={noop}
    />,
  )

test("the compact project filter keeps HZ-208's accessible name, with the project in it", () => {
  const { container } = renderBar()
  const button = screen.getByRole('button', { name: 'Project filter: Shoreward' })
  expect(button).toBe(container.querySelector('.projswitch'))
  // The label CSS visually hides on a phone is still the project name.
  expect(button.querySelector('.projswitch__label').textContent).toBe('Shoreward')
})

test("the filter's dot and caret are aria-hidden", () => {
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

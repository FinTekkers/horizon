// HZ-825 guardrail 4: the menu's new placement measurement sits next to its
// close paths — Escape still closes it and hands focus back to the toggle,
// and a mousedown outside still closes it. Plus the flip-up rule itself.

import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import StepActionMenu, { menuOpensUp } from './StepActionMenu'
import { GATE_ITEM } from './fixtures/stepControl'

afterEach(cleanup)

function openMenu() {
  render(<StepActionMenu item={GATE_ITEM} onApprove={vi.fn()} onMove={vi.fn()} onAbandon={vi.fn()} />)
  const toggle = screen.getByRole('button', { name: `More actions for ${GATE_ITEM.id}` })
  fireEvent.click(toggle)
  expect(screen.getByRole('menu')).toBeTruthy()
  return toggle
}

test('Escape closes the menu and returns focus to the toggle', () => {
  const toggle = openMenu()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
})

test('a mousedown outside the menu closes it', () => {
  openMenu()
  fireEvent.mouseDown(document.body)
  expect(screen.queryByRole('menu')).toBeNull()
})

test('the menu opens downward with no tab bar to measure against', () => {
  openMenu()
  expect(screen.getByRole('menu').classList.contains('step-menu__list--up')).toBe(false)
})

test('menuOpensUp flips only past the limit, and only when there is more room above', () => {
  // Fits below the tab bar: stays down.
  expect(menuOpensUp({ toggleTop: 100, toggleBottom: 140, menuHeight: 100, limit: 780 })).toBe(false)
  // Exactly reaches the limit: stays down.
  expect(menuOpensUp({ toggleTop: 634, toggleBottom: 674, menuHeight: 100, limit: 780 })).toBe(false)
  // Runs past the limit with room above: flips up.
  expect(menuOpensUp({ toggleTop: 700, toggleBottom: 740, menuHeight: 100, limit: 780 })).toBe(true)
  // Short screen: past the limit, but less room above than below — stays down.
  expect(menuOpensUp({ toggleTop: 20, toggleBottom: 60, menuHeight: 200, limit: 200 })).toBe(false)
})

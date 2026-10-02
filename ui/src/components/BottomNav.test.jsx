// HZ-224: the phone bottom nav — Board, Tracker and Approvals within thumb
// reach. Desktop never mounts it (see App.jsx / useMediaQuery.js).

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'

import BottomNav from './BottomNav'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const props = (over = {}) => ({
  view: 'board',
  pendingCount: 3,
  onBoard: vi.fn(),
  onTracker: vi.fn(),
  onOpenApprovals: vi.fn(),
  ...over,
})

test('renders Board, Tracker and Approvals as named buttons inside a labelled nav', () => {
  render(<BottomNav {...props()} />)
  const nav = screen.getByRole('navigation', { name: 'Primary' })
  const buttons = nav.querySelectorAll('button')
  expect([...buttons].map((b) => b.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON'])
  expect(screen.getByRole('button', { name: 'Board' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Tracker' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Approvals, 3 pending' })).toBeTruthy()
})

test('the active view carries aria-current="page", and only that tab', () => {
  const { rerender } = render(<BottomNav {...props({ view: 'board' })} />)
  expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('button', { name: 'Tracker' }).hasAttribute('aria-current')).toBe(false)
  expect(screen.getByRole('button', { name: /^Approvals/ }).hasAttribute('aria-current')).toBe(false)

  rerender(<BottomNav {...props({ view: 'tracker' })} />)
  expect(screen.getByRole('button', { name: 'Tracker' }).getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('button', { name: 'Board' }).hasAttribute('aria-current')).toBe(false)
})

test('each tab calls the same handler the top bar uses', () => {
  const p = props()
  render(<BottomNav {...p} />)
  fireEvent.click(screen.getByRole('button', { name: 'Board' }))
  fireEvent.click(screen.getByRole('button', { name: 'Tracker' }))
  fireEvent.click(screen.getByRole('button', { name: /^Approvals/ }))
  expect(p.onBoard).toHaveBeenCalledTimes(1)
  expect(p.onTracker).toHaveBeenCalledTimes(1)
  expect(p.onOpenApprovals).toHaveBeenCalledTimes(1)
})

test('the Approvals badge shows the pending count with the desktop badge styling', () => {
  const { container } = render(<BottomNav {...props({ pendingCount: 3 })} />)
  const badge = container.querySelector('.pending-btn__badge')
  expect(badge.textContent).toBe('3')
  expect(badge.classList.contains('pending-btn__badge--hot')).toBe(true)
})

test('every icon is aria-hidden and nothing focusable is hidden from assistive tech', () => {
  const { container } = render(<BottomNav {...props()} />)
  const svgs = container.querySelectorAll('svg')
  expect(svgs.length).toBe(3)
  svgs.forEach((svg) => expect(svg.getAttribute('aria-hidden')).toBe('true'))
  container.querySelectorAll('button, a, [tabindex]').forEach((el) => {
    expect(el.closest('[aria-hidden="true"]')).toBeNull()
  })
})

test('rendering and clicking never fetches — the count comes from App, not a second request', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response('{}')))
  render(<BottomNav {...props()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Board' }))
  fireEvent.click(screen.getByRole('button', { name: 'Tracker' }))
  fireEvent.click(screen.getByRole('button', { name: /^Approvals/ }))
  expect(fetchSpy).not.toHaveBeenCalled()
})

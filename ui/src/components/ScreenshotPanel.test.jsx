// HZ-509: the Accept gate's screenshot panel. One row per listed shot with its
// images; Approve all and a row's Approve send the right selection; nothing
// renders with no shots; and a failed read shows an error, never "no panel".
// HZ-548: the full-size viewer reuses the loaded images, and Stacked is
// remembered per browser. Layout and the native modal run in e2e spec 54.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({
  getScreenshots: vi.fn(),
  getScreenshotImage: vi.fn(),
  approveScreenshots: vi.fn(),
  hasGatePin: vi.fn(() => true),
}))

import { approveScreenshots, getScreenshotImage, getScreenshots, hasGatePin } from '../api'
import * as shotLayout from '../shotLayout'
import ScreenshotPanel from './ScreenshotPanel'

// jsdom has no showModal(); this stand-in opens and closes the way a browser
// does, close firing the close event the viewer listens for.
HTMLDialogElement.prototype.showModal = function showModal() {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close = function close() {
  if (!this.hasAttribute('open')) return
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
}

const COMMIT = 'a'.repeat(40)
const shot = (screen, status, images, approved = false) => ({
  screen,
  status,
  diffRatio: null,
  error: null,
  images,
  approved,
  approvedBy: approved ? 'Owner' : null,
  approvedAt: null,
})
const SHOTS = [
  shot('board', 'changed', ['baseline', 'new', 'diff']),
  shot('gates', 'new', ['new']),
  shot('old', 'removed', ['baseline']),
]
const item = { id: 'HZ-9', repo: 'acme/app' }

beforeEach(() => {
  getScreenshots.mockResolvedValue({ commit: COMMIT, shots: SHOTS })
  getScreenshotImage.mockImplementation(async (id, s, kind) => `blob:${s}/${kind}`)
  URL.revokeObjectURL = vi.fn()
  localStorage.removeItem('horizon.shotLayout')
  shotLayout._reloadForTests()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test('one row per shot; a changed row shows baseline, new and diff', async () => {
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
  await waitFor(() => expect(within(board).getAllByRole('img').map((img) => img.getAttribute('alt'))).toEqual(['Baseline', 'Current', 'Diff']))
  expect(within(screen.getByRole('listitem', { name: 'old' })).getByText('Removed — will be deleted')).toBeTruthy()
  expect(screen.getByText('0 of 3 approved')).toBeTruthy()
})

test("a shot's image opens the viewer on that image; the tabs and Left/Right switch it, Left on Baseline wraps to Diff", async () => {
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  fireEvent.click(await within(board).findByRole('button', { name: 'Current' }))
  const dialog = screen.getByRole('dialog', { name: 'board screenshot' })
  const shown = () => within(dialog).getByRole('img')
  expect(shown().getAttribute('src')).toBe('blob:board/new')
  expect(shown().getAttribute('alt')).toBe('board — Current')
  expect(within(dialog).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Baseline', 'Current', 'Diff'])
  expect(within(dialog).getByRole('tab', { name: 'Current' }).getAttribute('aria-selected')).toBe('true')

  fireEvent.click(within(dialog).getByRole('tab', { name: 'Baseline' }))
  expect(shown().getAttribute('src')).toBe('blob:board/baseline')
  expect(shown().getAttribute('alt')).toBe('board — Baseline')
  fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'Baseline' }), { key: 'ArrowLeft' })
  expect(shown().getAttribute('src')).toBe('blob:board/diff')
  expect(within(dialog).getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'Diff' }), { key: 'ArrowRight' })
  expect(shown().getAttribute('src')).toBe('blob:board/baseline')
})

test('a shot with no baseline offers only Current, and Swipe is disabled', async () => {
  render(<ScreenshotPanel item={item} />)
  const gates = await screen.findByRole('listitem', { name: 'gates' })
  fireEvent.click(await within(gates).findByRole('button', { name: 'Current' }))
  const dialog = screen.getByRole('dialog', { name: 'gates screenshot' })
  expect(within(dialog).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Current'])
  expect(within(dialog).getByRole('button', { name: 'Swipe' }).disabled).toBe(true)
})

test('in swipe mode Left/Right on the slider move the divider, not the tab', async () => {
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  fireEvent.click(await within(board).findByRole('button', { name: 'Diff' }))
  const dialog = screen.getByRole('dialog', { name: 'board screenshot' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Swipe' }))
  const slider = within(dialog).getByRole('slider', { name: 'Baseline share' })
  const baseline = within(dialog).getByRole('img', { name: 'board — Baseline' })
  expect(within(dialog).getByRole('img', { name: 'board — Current' })).toBeTruthy()
  fireEvent.keyDown(slider, { key: 'ArrowLeft' })
  expect(slider.getAttribute('aria-valuenow')).toBe('45')
  expect(baseline.style.clipPath).toBe('inset(0 55% 0 0)')
  fireEvent.keyDown(slider, { key: 'ArrowRight' })
  fireEvent.keyDown(slider, { key: 'ArrowRight' })
  expect(slider.getAttribute('aria-valuenow')).toBe('55')
  expect(within(dialog).getByRole('slider')).toBeTruthy()
  expect(within(dialog).getByRole('tab', { name: 'Diff' }).getAttribute('tabindex')).toBe('0')
})

test('Close returns to the panel and focuses the image that opened the viewer', async () => {
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  const opener = await within(board).findByRole('button', { name: 'Baseline' })
  fireEvent.click(opener)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(opener)
})

test('images load only after Show images; opening the viewer fetches nothing more', async () => {
  hasGatePin.mockReturnValueOnce(false)
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  expect(within(board).queryAllByRole('button', { name: /Baseline|Current|Diff/ })).toHaveLength(0)
  expect(screen.queryByRole('button', { name: 'Stacked' })).toBeNull()
  expect(getScreenshotImage).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Show images' }))
  await within(screen.getByRole('listitem', { name: 'old' })).findByRole('button', { name: 'Baseline' })
  await waitFor(() => expect(getScreenshotImage).toHaveBeenCalledTimes(5))
  fireEvent.click(within(screen.getByRole('listitem', { name: 'board' })).getByRole('button', { name: 'Current' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('tab', { name: 'Diff' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Swipe' }))
  expect(getScreenshotImage).toHaveBeenCalledTimes(5)
})

test('side by side is the default; Stacked is remembered across a reload', async () => {
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  const images = () => board.querySelector('.shots__images')
  const toggle = screen.getByRole('button', { name: 'Stacked' })
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  expect(images().classList.contains('shots__images--stacked')).toBe(false)
  fireEvent.click(toggle)
  expect(images().classList.contains('shots__images--stacked')).toBe(true)
  expect(localStorage.getItem('horizon.shotLayout')).toBe('stacked')

  cleanup()
  shotLayout._reloadForTests()
  render(<ScreenshotPanel item={item} />)
  expect((await screen.findByRole('button', { name: 'Stacked' })).getAttribute('aria-pressed')).toBe('true')
})

test('Approve all sends { all: true } for the publish shown', async () => {
  approveScreenshots.mockResolvedValue({ commit: COMMIT, shots: SHOTS.map((s) => ({ ...s, approved: true })) })
  render(<ScreenshotPanel item={item} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Approve all' }))
  await screen.findByText('3 of 3 approved')
  expect(approveScreenshots).toHaveBeenCalledWith('HZ-9', COMMIT, { all: true })
})

test("a row's Approve sends only that screen", async () => {
  approveScreenshots.mockResolvedValue({ commit: COMMIT, shots: [SHOTS[0], { ...SHOTS[1], approved: true }, SHOTS[2]] })
  render(<ScreenshotPanel item={item} />)
  const gates = await screen.findByRole('listitem', { name: 'gates' })
  fireEvent.click(within(gates).getByRole('button', { name: 'Approve' }))
  await screen.findByText('1 of 3 approved')
  expect(approveScreenshots).toHaveBeenCalledWith('HZ-9', COMMIT, { screens: ['gates'] })
  expect(within(screen.getByRole('listitem', { name: 'gates' })).getByText('✓ Approved')).toBeTruthy()
  expect(within(screen.getByRole('listitem', { name: 'board' })).getByRole('button', { name: 'Approve' })).toBeTruthy()
})

test('no listed shots renders nothing', async () => {
  getScreenshots.mockResolvedValue({ commit: null, shots: [] })
  const { container } = render(<ScreenshotPanel item={item} />)
  await waitFor(() => expect(getScreenshots).toHaveBeenCalled())
  await Promise.resolve()
  expect(container.innerHTML).toBe('')
})

test('a failed read shows "Screenshots unavailable", not an empty panel', async () => {
  getScreenshots.mockRejectedValue(Object.assign(new Error('github_unavailable'), { status: 502 }))
  render(<ScreenshotPanel item={item} />)
  expect((await screen.findByRole('alert')).textContent).toMatch(/Screenshots unavailable/)
  expect(screen.getByRole('region', { name: 'Screenshots' })).toBeTruthy()
})

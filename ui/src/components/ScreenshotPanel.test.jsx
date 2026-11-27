// HZ-509: the Accept gate's screenshot panel. One row per listed shot with its
// images; Approve all and a row's Approve send the right selection; nothing
// renders with no shots; and a failed read shows an error, never "no panel".
// HZ-548: the full-size viewer reuses the loaded images, and Stacked is
// remembered per browser. Layout and the native modal run in e2e spec 54.
// HZ-974: rows start collapsed; expanding one fetches only its images, at most
// 4 requests run at once, and a stale reload drops everything fetched.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react'

vi.mock('../api', () => ({
  getScreenshots: vi.fn(),
  getScreenshotImage: vi.fn(),
  approveScreenshots: vi.fn(),
}))

import { approveScreenshots, getScreenshotImage, getScreenshots } from '../api'
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

const expand = async (name) => fireEvent.click(await screen.findByRole('button', { name: `Expand ${name}` }))

test('one row per shot; a changed row shows baseline, new and diff', async () => {
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
  await expand('board')
  await waitFor(() => expect(within(board).getAllByRole('img').map((img) => img.getAttribute('alt'))).toEqual(['Baseline', 'Current', 'Diff']))
  expect(within(screen.getByRole('listitem', { name: 'old' })).getByText('Removed — will be deleted')).toBeTruthy()
  expect(screen.getByText('0 of 3 approved')).toBeTruthy()
})

test("a shot's image opens the viewer on that image; the tabs and Left/Right switch it, Left on Baseline wraps to Diff", async () => {
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  await expand('board')
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
  await expand('gates')
  fireEvent.click(await within(gates).findByRole('button', { name: 'Current' }))
  const dialog = screen.getByRole('dialog', { name: 'gates screenshot' })
  expect(within(dialog).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Current'])
  expect(within(dialog).getByRole('button', { name: 'Swipe' }).disabled).toBe(true)
})

test('in swipe mode Left/Right on the slider move the divider, not the tab', async () => {
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  await expand('board')
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
  await expand('board')
  const opener = await within(board).findByRole('button', { name: 'Baseline' })
  fireEvent.click(opener)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(opener)
})

test('no image loads until a row is expanded; opening the viewer fetches nothing more', async () => {
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  expect(within(board).queryAllByRole('button', { name: /Baseline|Current|Diff/ })).toHaveLength(0)
  expect(screen.queryByRole('button', { name: 'Stacked' })).toBeNull()
  expect(getScreenshotImage).not.toHaveBeenCalled()

  await expand('board')
  await within(board).findByRole('button', { name: 'Diff' })
  expect(getScreenshotImage).toHaveBeenCalledTimes(3)
  fireEvent.click(within(board).getByRole('button', { name: 'Current' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('tab', { name: 'Diff' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Swipe' }))
  expect(getScreenshotImage).toHaveBeenCalledTimes(3)
})

test('side by side is the default; Stacked is remembered across a reload', async () => {
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  await expand('board')
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
  await expand('board')
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

// ---- HZ-974: collapsed rows, images on demand ----

const STATUSES = ['changed', 'new', 'removed']
const KINDS = { changed: ['baseline', 'new', 'diff'], new: ['new'], removed: ['baseline'] }
const THEMES = ['light', 'dark']
const SHOTS20 = Array.from({ length: 20 }, (_, i) => {
  const status = STATUSES[i % 3]
  return shot(`screen-${i}--${i % 2 ? 'phone' : 'desktop'}--${THEMES[Math.floor(i / 2) % 2]}`, status, KINDS[status])
})
const TOTAL20 = SHOTS20.reduce((sum, s) => sum + s.images.length, 0)

// Every image request stays pending until the test resolves it; tracks the
// requests in flight and the peak.
function deferredImages() {
  const pending = []
  const state = { inFlight: 0, peak: 0, pending }
  getScreenshotImage.mockImplementation(
    (id, s, kind) =>
      new Promise((resolve, reject) => {
        state.inFlight += 1
        state.peak = Math.max(state.peak, state.inFlight)
        const settle = (fn) => (value) => {
          state.inFlight -= 1
          fn(value)
        }
        pending.push({ key: `${s}/${kind}`, resolve: settle(() => resolve(`blob:${s}/${kind}`)), reject: settle(reject) })
      }),
  )
  // Resolves the oldest pending request and lets the panel react.
  state.resolveNext = async () => {
    const next = pending.shift()
    await act(async () => next.resolve())
    return next
  }
  return state
}

const calls = () => getScreenshotImage.mock.calls.map(([, s, kind]) => `${s}/${kind}`)
const flush = () => act(async () => {})

test('20 shots: opening makes no image request; each collapsed row shows name, viewport, theme, status and Approve; expanding one fetches only its images', async () => {
  getScreenshots.mockResolvedValue({ commit: COMMIT, shots: SHOTS20 })
  render(<ScreenshotPanel item={item} />)
  const rows = await screen.findAllByRole('listitem')
  expect(rows).toHaveLength(20)
  await flush()
  expect(getScreenshotImage).not.toHaveBeenCalled()
  expect(screen.queryAllByRole('img')).toHaveLength(0)

  const row3 = screen.getByRole('listitem', { name: 'screen-3--phone--dark' })
  const toggle = within(row3).getByRole('button', { name: 'Expand screen-3--phone--dark' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(within(toggle).getByText('screen-3')).toBeTruthy()
  expect(within(toggle).getByText('phone')).toBeTruthy()
  expect(within(toggle).getByText('dark')).toBeTruthy()
  expect(within(row3).getByText('Changed')).toBeTruthy()
  expect(within(row3).getByRole('button', { name: 'Approve' })).toBeTruthy()
  for (const row of rows) expect(within(row).getByRole('button', { name: 'Approve' })).toBeTruthy()
  expect(within(screen.getByRole('listitem', { name: 'screen-2--desktop--dark' })).getByText('Removed — will be deleted')).toBeTruthy()

  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(toggle.getAttribute('aria-label')).toBe('Collapse screen-3--phone--dark')
  await waitFor(() => expect(within(row3).getAllByRole('img')).toHaveLength(3))
  expect(calls()).toEqual(['screen-3--phone--dark/baseline', 'screen-3--phone--dark/new', 'screen-3--phone--dark/diff'])
})

test('Expand all shows all 20 shots, exactly 4 requests at a time; collapsing and re-opening a row fetches nothing', async () => {
  getScreenshots.mockResolvedValue({ commit: COMMIT, shots: SHOTS20 })
  const images = deferredImages()
  render(<ScreenshotPanel item={item} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Expand all' }))
  // The first request runs alone (one PIN prompt at most), then the pool fills.
  await flush()
  expect(getScreenshotImage).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('status').textContent).toBe(`Loading images · 0 of ${TOTAL20}`)
  await images.resolveNext()
  await flush()
  expect(images.inFlight).toBe(4)
  expect(getScreenshotImage).toHaveBeenCalledTimes(5)
  while (images.pending.length > 0) {
    const before = getScreenshotImage.mock.calls.length
    await images.resolveNext()
    await flush()
    const remaining = TOTAL20 - before
    expect(getScreenshotImage.mock.calls.length).toBe(before + (remaining > 0 ? 1 : 0))
    expect(images.inFlight).toBeLessThanOrEqual(4)
  }
  expect(images.peak).toBe(4)
  expect(getScreenshotImage).toHaveBeenCalledTimes(TOTAL20)
  for (const s of SHOTS20) {
    expect(within(screen.getByRole('listitem', { name: s.screen })).getAllByRole('img')).toHaveLength(s.images.length)
  }
  expect(screen.getByRole('button', { name: 'Expand all' }).disabled).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: 'Collapse screen-0--desktop--light' }))
  expect(within(screen.getByRole('listitem', { name: 'screen-0--desktop--light' })).queryAllByRole('img')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Expand screen-0--desktop--light' }))
  expect(within(screen.getByRole('listitem', { name: 'screen-0--desktop--light' })).getAllByRole('img')).toHaveLength(3)
  await flush()
  expect(getScreenshotImage).toHaveBeenCalledTimes(TOTAL20)
})

test('a row collapsed while its requests run still keeps their images; re-opening fetches nothing', async () => {
  const images = deferredImages()
  render(<ScreenshotPanel item={item} />)
  await expand('board')
  await images.resolveNext()
  await flush()
  expect(images.pending).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Collapse board' }))
  while (images.pending.length > 0) await images.resolveNext()
  const board = screen.getByRole('listitem', { name: 'board' })
  expect(within(board).getByTitle('Images loaded')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Expand board' }))
  expect(within(board).getAllByRole('img').map((img) => img.getAttribute('src'))).toEqual(['blob:board/baseline', 'blob:board/new', 'blob:board/diff'])
  await flush()
  expect(getScreenshotImage).toHaveBeenCalledTimes(3)
})

test('collapsed rows: approving the Removed shot and Approve all send the same requests and fetch no image', async () => {
  approveScreenshots
    .mockResolvedValueOnce({ commit: COMMIT, shots: [SHOTS[0], SHOTS[1], { ...SHOTS[2], approved: true }] })
    .mockResolvedValueOnce({ commit: COMMIT, shots: SHOTS.map((s) => ({ ...s, approved: true })) })
  render(<ScreenshotPanel item={item} />)
  const old = await screen.findByRole('listitem', { name: 'old' })
  expect(within(old).getByRole('button', { name: 'Expand old' }).getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(within(old).getByRole('button', { name: 'Approve' }))
  await screen.findByText('1 of 3 approved')
  fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
  await screen.findByText('3 of 3 approved')
  expect(approveScreenshots.mock.calls).toEqual([
    ['HZ-9', COMMIT, { screens: ['old'] }],
    ['HZ-9', COMMIT, { all: true }],
  ])
  await flush()
  expect(getScreenshotImage).not.toHaveBeenCalled()
})

test('a stale reload re-fetches the listing, revokes the old images and collapses every row', async () => {
  const NEXT = 'b'.repeat(40)
  getScreenshots.mockResolvedValueOnce({ commit: COMMIT, shots: SHOTS }).mockResolvedValueOnce({ commit: NEXT, shots: SHOTS })
  approveScreenshots.mockRejectedValue(new Error('stale_snapshot'))
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  await expand('board')
  await waitFor(() => expect(within(board).getAllByRole('img')).toHaveLength(3))

  fireEvent.click(within(board).getByRole('button', { name: 'Approve' }))
  await screen.findByText(/changed since you opened them/)
  await waitFor(() => expect(getScreenshots).toHaveBeenCalledTimes(2))
  for (const url of ['blob:board/baseline', 'blob:board/new', 'blob:board/diff']) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
  const fresh = screen.getByRole('listitem', { name: 'board' })
  expect(within(fresh).getByRole('button', { name: 'Expand board' }).getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelectorAll('img')).toHaveLength(0)
  expect(screen.queryByRole('button', { name: 'Stacked' })).toBeNull()
})

test('after a stale reload, expanding a row starts only 1 request until it settles', async () => {
  approveScreenshots.mockRejectedValue(new Error('stale_snapshot'))
  const images = deferredImages()
  render(<ScreenshotPanel item={item} />)
  await expand('board')
  await flush()
  expect(getScreenshotImage).toHaveBeenCalledTimes(1)
  while (images.pending.length > 0) await images.resolveNext()
  expect(getScreenshotImage).toHaveBeenCalledTimes(3)

  fireEvent.click(within(screen.getByRole('listitem', { name: 'gates' })).getByRole('button', { name: 'Approve' }))
  await screen.findByText(/changed since you opened them/)
  await waitFor(() => expect(getScreenshots).toHaveBeenCalledTimes(2))
  await expand('board')
  await flush()
  expect(getScreenshotImage).toHaveBeenCalledTimes(4)
  await images.resolveNext()
  await flush()
  expect(getScreenshotImage).toHaveBeenCalledTimes(6)
})

test('Expand all then a stale reload: no queued request is sent, and a late old image is revoked, never shown', async () => {
  getScreenshots.mockResolvedValue({ commit: COMMIT, shots: SHOTS20 })
  approveScreenshots.mockRejectedValue(new Error('stale_snapshot'))
  const images = deferredImages()
  render(<ScreenshotPanel item={item} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Expand all' }))
  await flush()
  await images.resolveNext()
  await flush()
  expect(images.inFlight).toBe(4)
  const sent = getScreenshotImage.mock.calls.length

  fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
  await screen.findByText(/changed since you opened them/)
  await waitFor(() => expect(getScreenshots).toHaveBeenCalledTimes(2))
  const late = await images.resolveNext()
  while (images.pending.length > 0) await images.resolveNext()
  await flush()
  expect(getScreenshotImage).toHaveBeenCalledTimes(sent)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(`blob:${late.key}`)
  expect(document.querySelector(`img[src="blob:${late.key}"]`)).toBeNull()
  expect(document.querySelectorAll('img')).toHaveLength(0)
})

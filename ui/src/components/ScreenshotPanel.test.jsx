// HZ-509: the Accept gate's screenshot panel. One row per listed shot with its
// images; Approve all and a row's Approve send the right selection; nothing
// renders with no shots; and a failed read shows an error, never "no panel".

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({
  getScreenshots: vi.fn(),
  getScreenshotImage: vi.fn(),
  approveScreenshots: vi.fn(),
  hasGatePin: vi.fn(() => true),
}))

import { approveScreenshots, getScreenshotImage, getScreenshots } from '../api'
import ScreenshotPanel from './ScreenshotPanel'

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
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test('one row per shot; a changed row shows baseline, new and diff', async () => {
  render(<ScreenshotPanel item={item} />)
  const board = await screen.findByRole('listitem', { name: 'board' })
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
  await waitFor(() => expect(within(board).getAllByRole('img').map((img) => img.getAttribute('alt'))).toEqual(['Baseline', 'New', 'Diff']))
  expect(within(screen.getByRole('listitem', { name: 'old' })).getByText('Removed — will be deleted')).toBeTruthy()
  expect(screen.getByText('0 of 3 approved')).toBeTruthy()
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

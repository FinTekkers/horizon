// HZ-128 success criterion 9 and guardrail 4: "the UI builds and its suite
// passes with no server running, and mock mode renders a board" / "no runtime
// fetch. The UI must work with no server, per mockApi.js."
//
// The step model moved out of ui/src into domain/ at the repo root. That is a
// build-time relative import, not a runtime one — but "it imports fine under
// vitest" is not the same claim as "it never reaches the network". So this test
// replaces globalThis.fetch with a stub that THROWS, renders a real board
// through the real mockApi, and asserts both that a board rendered and that the
// stub was never called.

import { expect, test, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import * as mockApi from './mockApi'
import { STEPS, PHASES } from '../../../domain/js/lifecycle.js'
import Board from '../components/Board'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

let fetchCalls = 0
let realFetch

beforeEach(() => {
  fetchCalls = 0
  realFetch = globalThis.fetch
  globalThis.fetch = (...args) => {
    fetchCalls++
    throw new Error(`the UI reached the network with no server: fetch(${String(args[0])})`)
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  cleanup()
})

const noop = () => {}

test('the model resolves from domain/ with no server and no fetch', () => {
  expect(STEPS).toHaveLength(16)
  expect(PHASES).toHaveLength(5)
  expect(fetchCalls).toBe(0)
})

test('mockApi serves seeded items without touching the network', () => {
  const items = mockApi.getItems()
  expect(items.length).toBeGreaterThan(0)
  for (const item of items) {
    // Every seeded cursor addresses a real step (or the closed position) — the
    // mock seed and the relocated table have to agree or the board renders
    // `undefined` for a phase.
    expect(item.cursor).toBeLessThanOrEqual(STEPS.length)
  }
  expect(fetchCalls).toBe(0)
})

test('mock mode renders a board — the real mockApi items through the real Board', () => {
  const items = mockApi.getItems()
  const { container, getByText, getAllByText } = render(
    <Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />,
  )

  // A board, not an empty shell: one card per item, and one column header per
  // phase the relocated PHASES drives (getAllByText — a phase name also appears
  // on the cards sitting in that column).
  expect(container.querySelectorAll('.card').length).toBe(items.length)
  for (const phase of PHASES) expect(getAllByText(phase).length).toBeGreaterThan(0)
  expect(getByText(items[0].title)).toBeTruthy()

  expect(fetchCalls).toBe(0)
})

test('the throwing fetch stub is real — it fires if anything does call it', async () => {
  // Positive control. Without this, the three `fetchCalls === 0` assertions
  // above would also pass against a stub that was never installed.
  await expect(async () => globalThis.fetch('/api/items')).rejects.toThrow(/reached the network/)
  expect(fetchCalls).toBe(1)
})

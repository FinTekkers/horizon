// HO-853 metric lines 2, 4 and 5 and guardrails 1 and 2, through the real
// App, serverApi and PIN dialog (fixtures/stepControl): an item at "Approve &
// prioritize this work" with a design shows its design panel on that gate,
// in the gate-review container the golden cases share. "Request changes" opens
// MoveDialog preset to the design target the server lists in item.moves — no
// target listed, no button — and posts one /move to that key with the
// required note. "Approve without design" needs a reason and posts it as
// HO-852's designSkipReason; plain Approve names the canvas run it showed. An
// item with no design draws its gate exactly as before.

import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { GATE_ITEM, PIN, mountApp, stubServer } from './fixtures/stepControl'
import { servedMoves } from './fixtures/servedMoves'
import { STEPS, requiredStepIndex } from '../../../domain/js/lifecycle.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
  window.history.replaceState({}, '', '/')
})

const enterPin = async () => {
  await screen.findByRole('dialog', { name: 'Enter your gate PIN' })
  fireEvent.change(screen.getByLabelText('Gate PIN'), { target: { value: PIN } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

const GATE = requiredStepIndex('Approve & prioritize this work')
const METRIC = requiredStepIndex('Define how we measure success')
const DESIGN_ID = 'design-screens'
const DESIGN_KEY = `${STEPS[METRIC].key}#${DESIGN_ID}`
const CANVAS_1 = 'https://blueprint-studio.internalmeta.com/canvas/hz-953-r1'
const CANVAS_2 = 'https://blueprint-studio.internalmeta.com/canvas/hz-953-r2'
const run = (id) => ({ id, status: 'done', attempt: id, startedAt: '2026-11-17T10:00:00Z', endedAt: '2026-11-17T10:04:00Z', hasArtifact: true })
const round = (n, brief, whatChanged, canvasUrl, runId) => ({ round: n, kind: 'run', brief, whatChanged, overrideReason: null, runId, createdBy: 'Horizon', createdAt: '2026-11-17T10:04:00Z', canvasUrl })
const DESIGN = {
  id: DESIGN_ID,
  label: 'Design the screens',
  kind: 'opening',
  anchor: METRIC,
  persona: null,
  personaBadge: null,
  run: run(12),
  rounds: [round(1, 'Draw the board.', 'New canvas.', CANVAS_1, 11), round(2, 'Bigger filters, please.', 'Filters moved above the table.', CANVAS_2, 12)],
  skip: null,
  pendingRound: null,
}
const DESIGN_TARGET = {
  key: DESIGN_KEY,
  label: 'Design the screens',
  action: 'return',
  isDefault: false,
  redo: 'Runs “Design the screens” again, then comes back here.',
  reapprovals: [],
  stopsRunning: false,
}
const OTHER_TARGET = {
  key: STEPS[METRIC].key,
  label: STEPS[METRIC].label,
  action: 'return',
  isDefault: true,
  redo: `Redoes 3 steps, from “${STEPS[METRIC].label}”.`,
  reapprovals: [],
  stopsRunning: false,
}
const designSpec = (over = {}) => ({
  substepId: DESIGN_ID,
  gateIndex: GATE,
  approved: false,
  canvasUrl: CANVAS_2,
  skipReason: null,
  verdictSkipReason: null,
  approvedBy: null,
  approvedAt: null,
  pendingRunId: 12,
  ...over,
})

function designItem({ targets = [DESIGN_TARGET, OTHER_TARGET], spec = designSpec(), substeps = [DESIGN] } = {}) {
  return {
    ...GATE_ITEM,
    id: 'HZ-953',
    title: 'Design gate item',
    cursor: GATE,
    currentStepKey: STEPS[GATE].key,
    substeps,
    substep_cursor: null,
    substep: null,
    designSpec: spec,
    moves: servedMoves({ approve: null, targets, canAbandon: true }),
  }
}

const panel = () => screen.getByTestId('design-panel')
// The moves the server accepted: the first try is answered 401 and retried,
// unchanged, with the PIN.
const sentMoves = (server) => {
  const all = server.moves()
  for (const call of all) expect(call.body).toEqual(all.at(-1).body)
  return all.filter((c) => c.headers['x-human-key'] === PIN)
}

test('metric 2: the gate shows the design panel in the gate-review container, with the latest round and every round’s own canvas', async () => {
  const server = stubServer()
  await mountApp(server, '/hz-953', [designItem()])
  const p = within(await screen.findByTestId('design-panel'))
  expect(panel().parentElement.classList.contains('step-card__gate-review')).toBe(true)
  expect(p.getByText('Design · Round 2')).toBeTruthy()
  const latest = within(screen.getByTestId('design-latest'))
  expect(latest.getByText('Bigger filters, please.')).toBeTruthy()
  expect(latest.getByText('Filters moved above the table.')).toBeTruthy()
  expect(latest.getByRole('link', { name: 'Open the latest canvas ↗' }).getAttribute('href')).toBe(CANVAS_2)
  const list = within(p.getByRole('list', { name: 'Design rounds' }))
  expect(list.getByRole('link', { name: 'Round 1 canvas ↗' }).getAttribute('href')).toBe(CANVAS_1)
  expect(list.getByRole('link', { name: 'Round 2 canvas ↗' }).getAttribute('href')).toBe(CANVAS_2)
  // The sub-step row names its round and links that round's canvas.
  const row = within(screen.getAllByTestId('substep-row').find((r) => r.dataset.substep === DESIGN_ID))
  expect(row.getByTestId('substep-round').textContent).toBe('Round 2')
  expect(row.getByRole('link', { name: 'Open round 2 canvas ↗' }).getAttribute('href')).toBe(CANVAS_2)
})

test('metric 4: Request changes posts one /move to the served design key, with the required note', async () => {
  const server = stubServer()
  await mountApp(server, '/hz-953', [designItem()])
  fireEvent.click(within(await screen.findByTestId('design-panel')).getByRole('button', { name: 'Request changes' }))
  const dialog = within(screen.getByRole('dialog', { name: /Request design changes/ }))
  expect(dialog.getByText('Design the screens', { selector: '.move-dialog__target' })).toBeTruthy()
  const send = dialog.getByRole('button', { name: 'Request changes' })
  expect(send.disabled).toBe(true)
  fireEvent.change(dialog.getByLabelText('Brief for the next round (required)'), { target: { value: 'Make the empty state friendlier' } })
  expect(send.disabled).toBe(false)
  fireEvent.click(send)
  await enterPin()
  await waitFor(() => expect(screen.queryByRole('dialog', { name: /Request design changes/ })).toBeNull())
  expect(sentMoves(server)).toHaveLength(1)
  expect(sentMoves(server)[0].body).toEqual({ stepKey: DESIGN_KEY, from: STEPS[GATE].key, note: 'Make the empty state friendlier' })
})

test('metric 5: Approve without design needs a reason and sends it as designSkipReason', async () => {
  const server = stubServer()
  await mountApp(server, '/hz-953', [designItem()])
  fireEvent.click(within(await screen.findByTestId('design-panel')).getByRole('button', { name: 'Approve without design' }))
  const dialog = within(screen.getByRole('dialog', { name: /Approve without design/ }))
  const send = dialog.getByRole('button', { name: 'Approve without design' })
  expect(send.disabled).toBe(true)
  fireEvent.change(dialog.getByLabelText('Reason to approve without design'), { target: { value: '  Copy-only change  ' } })
  fireEvent.click(send)
  await enterPin()
  await waitFor(() => expect(sentMoves(server)).toHaveLength(1))
  const body = sentMoves(server)[0].body
  expect(body).toMatchObject({ action: 'approve', from: STEPS[GATE].key, designSkipReason: 'Copy-only change' })
  expect(body).not.toHaveProperty('designRunId')
})

test('plain Approve names the canvas run the panel showed', async () => {
  const server = stubServer()
  await mountApp(server, '/hz-953', [designItem()])
  await screen.findByTestId('design-panel')
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /Approve/ }))
  await enterPin()
  await waitFor(() => expect(sentMoves(server)).toHaveLength(1))
  expect(sentMoves(server)[0].body).toMatchObject({ action: 'approve', designRunId: 12 })
  expect(sentMoves(server)[0].body).not.toHaveProperty('designSkipReason')
})

test('guardrail 2: with no design target in item.moves, Request changes is not offered', async () => {
  const server = stubServer()
  await mountApp(server, '/hz-953', [designItem({ targets: [OTHER_TARGET] })])
  const p = within(await screen.findByTestId('design-panel'))
  expect(p.queryByRole('button', { name: 'Request changes' })).toBeNull()
  expect(p.getByRole('button', { name: 'Approve without design' })).toBeTruthy()
})

test('the agent said no design: plain Approve stays, and the panel offers neither Request changes nor Approve without design', async () => {
  const server = stubServer()
  const skipped = { ...DESIGN, run: null, rounds: [{ round: 1, kind: 'skip', brief: 'backend only', whatChanged: null, overrideReason: null, runId: null, createdBy: 'Horizon', createdAt: '2026-11-17T10:00:00Z', canvasUrl: null }], skip: { reason: 'backend only' } }
  await mountApp(server, '/hz-953', [designItem({ substeps: [skipped], spec: designSpec({ pendingRunId: null, canvasUrl: null, verdictSkipReason: 'backend only' }) })])
  const p = within(await screen.findByTestId('design-panel'))
  expect(p.queryAllByRole('button')).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Design it anyway' })).toBeTruthy()
})

test('guardrail 2: with no design target in item.moves, a skipped design offers no Design it anyway', async () => {
  const server = stubServer()
  const skipped = { ...DESIGN, run: null, rounds: [{ round: 1, kind: 'skip', brief: 'backend only', whatChanged: null, overrideReason: null, runId: null, createdBy: 'Horizon', createdAt: '2026-11-17T10:00:00Z', canvasUrl: null }], skip: { reason: 'backend only' } }
  await mountApp(server, '/hz-953', [designItem({ targets: [OTHER_TARGET], substeps: [skipped], spec: designSpec({ pendingRunId: null, canvasUrl: null, verdictSkipReason: 'backend only' }) })])
  await screen.findByTestId('design-panel')
  const row = within(screen.getAllByTestId('substep-row').find((r) => r.dataset.substep === DESIGN_ID))
  expect(row.getByText('Skipped: backend only')).toBeTruthy()
  expect(row.queryByRole('button', { name: 'Design it anyway' })).toBeNull()
})

test('no canvas yet: plain Approve is hidden, and the panel says how to go on', async () => {
  const server = stubServer()
  await mountApp(server, '/hz-953', [designItem({ spec: designSpec({ pendingRunId: null, canvasUrl: null }) })])
  const p = within(await screen.findByTestId('design-panel'))
  expect(p.getByText('This round has no canvas yet. Request changes, or approve without design.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Approve with comments' })).toBeNull()
  expect(p.getByRole('button', { name: 'Request changes' })).toBeTruthy()
})

test('approved without design: the reason shows on the gate, and no action is offered', async () => {
  const server = stubServer()
  const item = { ...designItem({ spec: designSpec({ approved: true, skipReason: 'Copy-only change', approvedBy: 'Owner', pendingRunId: null }) }), cursor: GATE + 1, currentStepKey: STEPS[GATE + 1].key }
  await mountApp(server, '/hz-953', [item])
  const p = within(await screen.findByTestId('design-panel'))
  expect(p.getByTestId('design-skip-reason').textContent).toBe('Approved without design by Owner: Copy-only change')
  expect(p.queryByRole('button')).toBeNull()
})

test('guardrail 1: an item with no design draws its gate as before — no panel, no new buttons', async () => {
  const server = stubServer()
  const plain = { ...designItem({ substeps: [] }), designSpec: undefined }
  await mountApp(server, '/hz-953', [plain])
  await screen.findByRole('button', { name: 'Approve' })
  expect(screen.queryByTestId('design-panel')).toBeNull()
  expect(document.querySelector('.step-card__gate-review')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Approve without design' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Approve with comments' })).toBeTruthy()
})

// HZ-711 metric 1 and guardrails 1, 3 and 4: clicking an earlier step on the
// item page opens one Move dialog with the server's own summary — the step,
// what is redone, the approvals given again, whether the running step stops —
// and a note box. Confirming goes through HZ-704's PIN dialog and posts
// /items/:id/move naming steps by key only. A refused move keeps the dialog,
// its note and the snapshot's (refreshed) targets.
// Driven through the real App, serverApi and PIN dialog (fixtures/stepControl).

import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GATE_ITEM, PIN, RUNNING_ITEM, mountApp, stubServer } from './fixtures/stepControl'
import { servedMoves } from './fixtures/servedMoves'
import MoveDialog from './MoveDialog'

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

test('clicking an earlier step opens one dialog with the server’s summary; confirming posts the step key and the note', async () => {
  const server = stubServer()
  await mountApp(server, `/${RUNNING_ITEM.id.toLowerCase()}`)

  fireEvent.click(await screen.findByRole('button', { name: /^Review before execution/ }))

  const dialogs = screen.getAllByRole('dialog')
  expect(dialogs).toHaveLength(1)
  const dialog = within(dialogs[0])
  expect(dialogs[0].getAttribute('aria-labelledby')).toBe('move-dialog-title')
  expect(dialog.getByText('Return to an earlier step · HZ-902', { exact: false })).toBeTruthy()
  const summary = dialog.getByTestId('move-summary')
  expect(within(summary).getByText('Review before execution', { selector: '.move-dialog__target' })).toBeTruthy()
  expect(within(summary).getByText('Redoes 2 steps, from “Review before execution” to “Specialist agent implements”.')).toBeTruthy()
  expect(within(dialog.getByRole('list', { name: 'Approvals given again' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'Review before execution',
  ])
  expect(dialog.getByText('The running step stops.')).toBeTruthy()
  const note = dialog.getByLabelText('Note for the step (optional)')
  fireEvent.change(note, { target: { value: 'the plan skips the migration' } })

  fireEvent.click(dialog.getByRole('button', { name: 'Return here' }))
  await enterPin()

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const sent = server.moves().at(-1)
  expect(sent.url).toMatch(/\/api\/items\/HZ-902\/move$/)
  expect(sent.headers['x-human-key']).toBe(PIN)
  // Guardrail 3: the body names steps by key — the target, the step the item
  // was at (the server's stale check) and the note; no position.
  expect(sent.body).toEqual({ stepKey: 'change.review-before-exec', from: 'change.implement', note: 'the plan skips the migration' })
  expect(Object.values(sent.body).some((v) => typeof v === 'number')).toBe(false)
  expect(server.prompt).not.toHaveBeenCalled()
})

test('the current step offers Retry in the same dialog, with nothing to approve again', async () => {
  const server = stubServer()
  await mountApp(server, `/${RUNNING_ITEM.id.toLowerCase()}`)

  fireEvent.click(await screen.findByRole('button', { name: /^Specialist agent implements/ }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('Retry this step · HZ-902', { exact: false })).toBeTruthy()
  expect(dialog.getByText('Runs “Specialist agent implements” again.')).toBeTruthy()
  expect(dialog.getByText('None')).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: 'Retry' }))
  await enterPin()
  await waitFor(() => expect(server.moves().at(-1)?.headers['x-human-key']).toBe(PIN))
  expect(server.moves().at(-1).body).toEqual({ stepKey: 'change.implement', from: 'change.implement', note: '' })
})

test('guardrail 4: a cancelled PIN moves nothing, and the dialog keeps the note', async () => {
  let accepted = 0
  const server = stubServer({
    moveReply: () => {
      accepted += 1
      return server.json(200, { ok: true })
    },
  })
  await mountApp(server, `/${GATE_ITEM.id.toLowerCase()}`)

  fireEvent.click(await screen.findByRole('button', { name: /^Draft implementation plan/ }))
  fireEvent.change(screen.getByLabelText('Note for the step (optional)'), { target: { value: 'keep me' } })
  fireEvent.click(screen.getByRole('button', { name: 'Return here' }))

  const pinDialog = await screen.findByRole('dialog', { name: 'Enter your gate PIN' })
  fireEvent.click(within(pinDialog).getByRole('button', { name: 'Cancel' }))

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe('Gate PIN needed')
  expect(accepted).toBe(0)
  expect(server.moves().every((c) => c.headers['x-human-key'] === undefined)).toBe(true)
  expect(screen.getByLabelText('Note for the step (optional)').value).toBe('keep me')
  expect(screen.queryByRole('dialog', { name: 'Enter your gate PIN' })).toBeNull()
  expect(server.prompt).not.toHaveBeenCalled()
})

for (const [status, error, message] of [
  [409, 'stale_step', 'This item has moved since — check the steps it offers now and try again.'],
  [400, 'invalid_target', 'That step is not offered from here any more.'],
]) {
  test(`guardrail 1: a ${status} ${error} keeps the dialog and its note, and then lists only the refreshed targets`, async () => {
    const server = stubServer({ moveReply: () => server.json(status, { error }) })
    await mountApp(server, `/${GATE_ITEM.id.toLowerCase()}`)

    fireEvent.click(await screen.findByRole('button', { name: 'Return to…' }))
    fireEvent.change(screen.getByLabelText('Note for the step (optional)'), { target: { value: 'try again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Return here' }))
    await enterPin()

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.getByRole('dialog', { name: /Return to an earlier step/ })).toBeTruthy()
    expect(screen.getByLabelText('Note for the step (optional)').value).toBe('try again')

    // The item moved: the stream's newer snapshot offers one target only.
    const moved = {
      ...GATE_ITEM,
      moves: { ...GATE_ITEM.moves, targets: [{ ...GATE_ITEM.moves.targets[2], isDefault: true }] },
    }
    act(() => server.push([moved, RUNNING_ITEM]))
    const radios = within(screen.getByRole('group', { name: 'Return to' })).getAllByRole('radio')
    expect(radios.map((r) => r.value)).toEqual(['change.summarize-reviews'])
    expect(radios[0].checked).toBe(true)
  })
}

// HO-853 metric lines 3 and 4: the design panel's "Request changes" opens this
// dialog preset to the server's design target, and its note is required — a
// blank or whitespace-only note sends nothing, by click or ⌘/Ctrl+Enter. Once
// typed, onConfirm gets the served key and the trimmed note.
const DESIGN_KEY = 'change.metric#design-screens'
const DESIGN_ITEM = {
  ...GATE_ITEM,
  id: 'HZ-953',
  cursor: 3,
  currentStepKey: 'change.approve',
  moves: servedMoves({
    approve: null,
    targets: [
      {
        key: DESIGN_KEY,
        label: 'Design the screens',
        action: 'return',
        isDefault: false,
        redo: 'Runs “Design the screens” again, then comes back here.',
        reapprovals: [],
        stopsRunning: false,
      },
    ],
    canAbandon: true,
  }),
}
const DESIGN_DIALOG = { title: 'Request design changes', noteLabel: 'Brief for the next round (required)', submitLabel: 'Request changes', requireNote: true }

test('HO-853: requireNote keeps Request changes unsent until the note has text, by click or ⌘/Ctrl+Enter', () => {
  const onConfirm = vi.fn()
  render(<MoveDialog item={DESIGN_ITEM} action="return" stepKey={DESIGN_KEY} onConfirm={onConfirm} onCancel={() => {}} {...DESIGN_DIALOG} />)
  const dialog = within(screen.getByRole('dialog', { name: /Request design changes · HZ-953/ }))
  const submit = dialog.getByRole('button', { name: 'Request changes' })
  const note = dialog.getByLabelText('Brief for the next round (required)')
  expect(dialog.queryByRole('group', { name: 'Return to' })).toBeNull()
  expect(submit.disabled).toBe(true)
  fireEvent.click(submit)
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
  fireEvent.change(note, { target: { value: '   \n  ' } })
  expect(submit.disabled).toBe(true)
  fireEvent.click(submit)
  fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
  expect(onConfirm).not.toHaveBeenCalled()

  fireEvent.change(note, { target: { value: '  Make the empty state friendlier  ' } })
  expect(submit.disabled).toBe(false)
  fireEvent.click(submit)
  expect(onConfirm).toHaveBeenCalledTimes(1)
  expect(onConfirm).toHaveBeenCalledWith('return', DESIGN_KEY, 'Make the empty state friendlier')
})

test('HO-853: without the new props the dialog reads and sends exactly as before', () => {
  const onConfirm = vi.fn()
  render(<MoveDialog item={DESIGN_ITEM} action="return" stepKey={DESIGN_KEY} onConfirm={onConfirm} onCancel={() => {}} />)
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('Return to an earlier step · HZ-953', { exact: false })).toBeTruthy()
  expect(dialog.getByLabelText('Note for the step (optional)')).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: 'Return here' }))
  expect(onConfirm).toHaveBeenCalledWith('return', DESIGN_KEY, '')
})

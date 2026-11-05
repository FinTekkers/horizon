// HZ-711 metric 1 and guardrails 1, 3 and 4: clicking an earlier step on the
// item page opens one Move dialog with the server's own summary — the step,
// what is redone, the approvals given again, whether the running step stops —
// and a note box. Confirming goes through HZ-704's PIN dialog and posts
// /items/:id/move naming steps by key only. A refused move keeps the dialog,
// its note and the snapshot's (refreshed) targets.
// Driven through the real App, serverApi and PIN dialog (fixtures/stepControl).

import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { GATE_ITEM, PIN, RUNNING_ITEM, mountApp, stubServer } from './fixtures/stepControl'

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
  // Guardrail 3: the body names steps by key — exactly these keys, no position.
  expect(sent.body).toEqual({ action: 'return', from: 'change.implement', to: 'change.review-before-exec', note: 'the plan skips the migration' })
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
  expect(server.moves().at(-1).body).toEqual({ action: 'retry', from: 'change.implement', to: 'change.implement', note: '' })
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
  [400, 'bad_target_key', 'That step is not offered from here any more.'],
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

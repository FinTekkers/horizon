// HZ-805 metrics 2–5 and guardrails 2 and 3: the step actions are exactly the
// snapshot's moves — one per target on the item page and the board card, the
// target marked isDefault chosen — each press posts /items/:id/move from the
// step the item is at, and a refused move (400, 401, 409) says why and leaves
// the item as it was on screen. Driven through the real App, serverApi and
// PIN dialog (fixtures/stepControl).

import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { GATE_ITEM, GATE_MOVES, PIN, RUNNING_ITEM, RUNNING_MOVES, mountApp, stubServer } from './fixtures/stepControl'

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

// The item page's step action buttons, by their step label.
const stepActionLabels = () => [...document.querySelectorAll('.step-card__select--action')].map((b) => b.firstChild.textContent)

// What the item page shows of where the item is: the selected step, the
// awaiting step card and the status chip.
const shownState = () => ({
  selected: document.querySelector('.step-card__select[aria-current="true"]')?.id ?? null,
  awaiting: [...document.querySelectorAll('.step-card--awaiting .step-card__select')].map((b) => b.firstChild.textContent),
  status: document.querySelector('.tracker__status')?.textContent ?? null,
})

test('metric 2: the item page shows one step action per served target, plus the gate when Approve is offered, and no other', async () => {
  const server = stubServer()
  await mountApp(server, '/hz-901')
  await screen.findByRole('button', { name: /^Draft implementation plan/ })

  expect(stepActionLabels().sort()).toEqual([...GATE_MOVES.targets.map((t) => t.label), GATE_MOVES.approve.label].sort())
  expect(stepActionLabels()).toHaveLength(GATE_MOVES.targets.length + 1)
})

test('metric 2: an item with no Approve offered shows only its two served targets', async () => {
  const server = stubServer()
  await mountApp(server, '/hz-902')
  await screen.findByRole('button', { name: /^Specialist agent implements/ })
  expect(stepActionLabels().sort()).toEqual(RUNNING_MOVES.targets.map((t) => t.label).sort())
  expect(stepActionLabels()).toHaveLength(2)
  // approveKey is null: nothing to approve, anywhere on the page.
  expect(screen.queryAllByRole('button', { name: /^Approve( with comments)?$/ })).toEqual([])
})

test('metrics 2 and 3: the board card lists the served targets in order, with the non-first default chosen', async () => {
  const server = stubServer()
  await mountApp(server, '/')
  fireEvent.click(await screen.findByRole('button', { name: `More actions for ${GATE_ITEM.id}` }))

  expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Return to…', 'Abandon'])
  fireEvent.click(screen.getByRole('menuitem', { name: 'Return to…' }))

  const radios = within(screen.getByRole('group', { name: 'Return to' })).getAllByRole('radio')
  expect(radios.map((r) => r.closest('label').querySelector('span').textContent)).toEqual(GATE_MOVES.targets.map((t) => t.label))
  expect(radios.map((r) => r.value)).toEqual(GATE_ITEM.moves.targets.map((t) => t.stepKey))
  // The fixture's default is the second target, not the first.
  expect(GATE_ITEM.moves.targets.findIndex((t) => t.isDefault)).toBe(1)
  expect(screen.getByRole('radio', { name: /^Draft implementation plan/ }).checked).toBe(true)
  expect(screen.getByRole('radio', { name: /^Approve the high-level design/ }).checked).toBe(false)
  expect(radios.filter((r) => r.checked)).toHaveLength(1)
})

// Guardrail 3: no request names a step by number.
const noNumbers = (calls) => {
  for (const call of calls) expect(Object.values(call.body).some((v) => typeof v === 'number'), JSON.stringify(call.body)).toBe(false)
}

test('metric 4 and guardrails 2 and 3: every return posts { stepKey, from, note }, Approve { action, from, note }, each through the PIN dialog', async () => {
  const server = stubServer()
  await mountApp(server, '/hz-901')

  for (const target of GATE_MOVES.targets) {
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${target.label}`) }))
    fireEvent.change(screen.getByLabelText('Note for the step (optional)'), { target: { value: `redo from ${target.label}` } })
    fireEvent.click(screen.getByRole('button', { name: 'Return here' }))
    await enterPin()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const sent = server.moves().at(-1)
    expect(sent.url).toMatch(/\/api\/items\/HZ-901\/move$/)
    expect(sent.headers['x-human-key']).toBe(PIN)
    expect(sent.body).toEqual({ stepKey: target.key, from: 'change.review-before-exec', note: `redo from ${target.label}` })
  }

  fireEvent.click(screen.getByRole('button', { name: 'Approve with comments' }))
  fireEvent.change(screen.getByPlaceholderText(/Decision notes/), { target: { value: 'ship it' } })
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }))
  await enterPin()
  await waitFor(() => expect(server.moves().at(-1).headers['x-human-key']).toBe(PIN))
  expect(server.moves().at(-1).url).toMatch(/\/api\/items\/HZ-901\/move$/)
  expect(server.moves().at(-1).body).toEqual({ action: 'approve', from: 'change.review-before-exec', note: 'ship it' })

  // Guardrail 3: step ids name keys, never positions.
  const ids = [...document.querySelectorAll('.step-card__select')].map((b) => b.id)
  expect(ids.length).toBeGreaterThan(10)
  for (const id of ids) expect(id).toMatch(/^step-HZ-901-[a-z]+\.[a-z][a-z-]*$/)
  noNumbers(server.moves())
})

test('metric 4 and guardrail 3: Retry posts { stepKey, from, note } for the running step', async () => {
  const running = stubServer()
  await mountApp(running, '/hz-902')
  fireEvent.click(await screen.findByRole('button', { name: /^Specialist agent implements/ }))
  fireEvent.change(screen.getByLabelText('Note for the step (optional)'), { target: { value: 'flaky test' } })
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }))
  await enterPin()
  await waitFor(() => expect(running.moves().at(-1)?.headers['x-human-key']).toBe(PIN))
  expect(running.moves().at(-1).url).toMatch(/\/api\/items\/HZ-902\/move$/)
  expect(running.moves().at(-1).body).toEqual({ stepKey: 'change.implement', from: 'change.implement', note: 'flaky test' })
  noNumbers(running.moves())
})

for (const [status, error, message] of [
  [400, 'invalid_target', 'That step is not offered from here any more.'],
  [401, 'login_required', 'You are signed out — sign in again. Nothing was sent.'],
  [409, 'stale_step', 'This item has moved since — check the steps it offers now and try again.'],
]) {
  test(`metric 5: a ${status} ${error} on a return says why, sends nothing more and leaves the item as it was`, async () => {
    const server = stubServer({ moveReply: () => server.json(status, { error }) })
    if (error === 'login_required') {
      // Signed out: the server refuses before it asks for any PIN.
      const inner = globalThis.fetch
      vi.stubGlobal('fetch', async (url, init) => {
        const res = await inner(url, init)
        return /\/move$/.test(String(url)) ? server.json(401, { error }) : res
      })
    }
    await mountApp(server, '/hz-901')
    fireEvent.click(await screen.findByRole('button', { name: 'Return to…' }))
    const before = shownState()
    expect(before.awaiting).toEqual(['Review before execution'])
    expect(before.status).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Note for the step (optional)'), { target: { value: 'try again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Return here' }))
    if (error !== 'login_required') await enterPin()

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(shownState()).toEqual(before)
    // One request reached the server's answer; no silent retry.
    expect(server.moves().filter((c) => error === 'login_required' || c.headers['x-human-key'] === PIN)).toHaveLength(1)
    if (error === 'login_required') {
      // Guardrail 2: a signed-out 401 is not a PIN request.
      expect(screen.queryByRole('dialog', { name: 'Enter your gate PIN' })).toBeNull()
    }
  })
}

test('metric 5: an Approve refused with 409 stale_step says why, leaves the item as it was and stays on the page', async () => {
  const server = stubServer({ moveReply: (body) => server.json(body.action === 'approve' ? 409 : 200, body.action === 'approve' ? { error: 'stale_step' } : { ok: true }) })
  await mountApp(server, '/hz-901')
  await screen.findByRole('button', { name: /^Draft implementation plan/ })
  const before = shownState()

  fireEvent.click(within(document.querySelector('.tracker__actions')).getByRole('button', { name: 'Approve' }))
  const confirm = await screen.findByRole('alertdialog', { name: 'Approve this gate?' })
  fireEvent.click(within(confirm).getByRole('button', { name: 'Approve' }))
  await enterPin()

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('HZ-901: This item has moved since — check the steps it offers now and try again.')
  expect(shownState()).toEqual(before)
  expect(window.location.pathname).toBe('/hz-901')
  expect(server.moves().filter((c) => c.headers['x-human-key'] === PIN)).toHaveLength(1)

  fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByRole('alert')).toBeNull()
})

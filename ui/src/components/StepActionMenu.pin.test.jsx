// HZ-711 metric 4 and guardrail 4: Approve on the item page, a board card and
// the Approvals drawer asks for the PIN through HZ-704's one PIN dialog —
// never window.prompt — and the approve is a move from the gate's key.
// Driven through the real App, serverApi and PIN dialog.

import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { GATE_ITEM, PIN, mountApp, stubServer } from './fixtures/stepControl'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
  window.history.replaceState({}, '', '/')
})

const SURFACES = {
  'item page': ['/hz-901', () => document.querySelector('.tracker__actions')],
  'board card': ['/', () => screen.queryByText(GATE_ITEM.title, { selector: '.card__title' })?.closest('.card')],
  'Approvals drawer': ['/?approvals', () => screen.queryByText(GATE_ITEM.title, { selector: '.approval__title' })?.closest('.approval')],
}

for (const [name, [path, scopeOf]] of Object.entries(SURFACES)) {
  test(`Approve on the ${name} asks for the PIN in the one PIN dialog, then approves by step key`, async () => {
    const server = stubServer()
    await mountApp(server, path)
    const scope = await vi.waitFor(() => scopeOf() ?? Promise.reject(new Error('not shown')))

    fireEvent.click(within(scope).getByRole('button', { name: 'Approve' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Approve this gate?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve' }))

    const pinDialogs = await screen.findAllByRole('dialog', { name: 'Enter your gate PIN' })
    expect(pinDialogs).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Gate PIN'), { target: { value: PIN } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(server.moves().at(-1)?.headers['x-human-key']).toBe(PIN))
    expect(server.moves().at(-1).url).toMatch(/\/api\/items\/HZ-901\/move$/)
    expect(server.moves().at(-1).body).toEqual({ action: 'approve', from: 'change.review-before-exec' })
    expect(server.prompt).not.toHaveBeenCalled()
  })
}

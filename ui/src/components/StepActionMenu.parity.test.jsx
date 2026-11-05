// HZ-711 metric 2 and guardrails 1 and 3: from one mocked item snapshot, the
// item page, a board card and the Approvals drawer offer the same actions —
// labels exactly Approve, Return to…, Retry and Abandon — for a waiting gate
// and for a running step, and Return to… lists only the snapshot's targets,
// in its order, with its default chosen. The snapshot (fixtures/stepControl)
// offers a gate as a target and leaves out an earlier agent step, which no
// rule in the UI would do. Driven through the real App.

import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { GATE_ITEM, RUNNING_ITEM, mountApp, stubServer } from './fixtures/stepControl'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
  window.history.replaceState({}, '', '/')
})

// Each surface's scope for one item, once the App shows it.
const SURFACES = {
  'item page': { path: (item) => `/${item.id.toLowerCase()}`, scope: () => document.querySelector('.tracker__actions') },
  'board card': { path: () => '/', scope: (item) => screen.getByText(item.title, { selector: '.card__title' }).closest('.card') },
  'Approvals drawer': {
    path: () => '/?approvals',
    scope: (item) => screen.queryByText(item.title, { selector: '.approval__title' })?.closest('.approval') ?? null,
  },
}

// What one surface offers: its actions in order, and Return to…'s choices.
async function offered(surface, item) {
  const scope = await vi.waitFor(() => {
    const el = surface.scope(item)
    if (!el) throw new Error('not shown')
    return el
  })
  const actions = []
  if (within(scope).queryByRole('button', { name: 'Approve' })) actions.push('Approve')
  const toggle = within(scope).queryByRole('button', { name: `More actions for ${item.id}` })
  let choices = null
  if (toggle) {
    fireEvent.click(toggle)
    const menu = within(scope).getByRole('menu')
    actions.push(...within(menu).getAllByRole('menuitem').map((el) => el.textContent))
    const back = within(menu).queryByRole('menuitem', { name: 'Return to…' })
    if (back) {
      fireEvent.click(back)
      const radios = within(screen.getByRole('group', { name: 'Return to' })).getAllByRole('radio')
      choices = radios.map((r) => ({ key: r.value, checked: r.checked }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    }
  }
  return { actions, choices }
}

const expectedChoices = (item) =>
  item.moves.targets.filter((t) => t.action === 'return').map((t) => ({ key: t.key, checked: t.isDefault }))

for (const [name, surface] of Object.entries(SURFACES)) {
  test(`waiting gate on the ${name}: Approve, Return to… and Abandon — the snapshot's targets only`, async () => {
    const server = stubServer()
    await mountApp(server, surface.path(GATE_ITEM))
    const { actions, choices } = await offered(surface, GATE_ITEM)
    expect(actions).toEqual(['Approve', 'Return to…', 'Abandon'])
    expect(choices).toEqual(expectedChoices(GATE_ITEM))
    expect(choices.map((c) => c.key)).not.toContain('change.arch-review')
    // Guardrail 3: steps are never shown by number.
    expect(document.body.textContent).not.toMatch(/\bStep \d/)
  })
}

for (const name of ['item page', 'board card']) {
  test(`running step on the ${name}: Return to…, Retry and Abandon, and no Approve`, async () => {
    const server = stubServer()
    const surface = SURFACES[name]
    await mountApp(server, surface.path(RUNNING_ITEM))
    const { actions, choices } = await offered(surface, RUNNING_ITEM)
    expect(actions).toEqual(['Return to…', 'Retry', 'Abandon'])
    expect(choices).toEqual(expectedChoices(RUNNING_ITEM))
  })
}

test('the Approvals drawer lists only waiting gates, so a running step is not in it', async () => {
  const server = stubServer()
  await mountApp(server, '/?approvals')
  await screen.findByText(GATE_ITEM.title, { selector: '.approval__title' })
  expect(screen.queryByText(RUNNING_ITEM.title, { selector: '.approval__title' })).toBeNull()
})

for (const [name, surface] of Object.entries(SURFACES)) {
  test(`with canAbandon false the ${name} offers no Abandon`, async () => {
    const server = stubServer()
    const kept = { ...GATE_ITEM, moves: { ...GATE_ITEM.moves, canAbandon: false } }
    await mountApp(server, surface.path(kept), [kept, RUNNING_ITEM])
    const { actions } = await offered(surface, kept)
    expect(actions).toEqual(['Approve', 'Return to…'])
  })
}

test('an item whose snapshot offers nothing shows no menu on the item page', async () => {
  const server = stubServer()
  const none = { ...GATE_ITEM, moves: { approve: null, targets: [], canAbandon: false, amend: null } }
  await mountApp(server, '/hz-901', [none, RUNNING_ITEM])
  await screen.findByText(none.title)
  expect(within(document.querySelector('.tracker__actions')).queryByRole('button', { name: /More actions|^Approve$/ })).toBeNull()
})

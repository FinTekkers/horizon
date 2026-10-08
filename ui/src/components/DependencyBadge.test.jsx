// HZ-95: dependency direction rendering. The component reads item.blockedBy
// / item.dependents straight from the API payload — no client-side
// derivation — so these tests exercise the four shapes a payload can take:
// a blocker, dependents, both, and neither.

import { expect, test, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import DependencyBadge from './DependencyBadge'
import { vi } from 'vitest'
import { fireEvent, waitFor, act } from '@testing-library/react'

afterEach(() => {
  cleanup()
})

const neither = { id: 'X-1', blockedBy: [], dependents: [] }
const blockedOnly = { id: 'X-2', blockedBy: [{ id: 'X-B', title: 'The blocker item', abandoned: false }], dependents: [] }
const dependentsOnly = {
  id: 'X-3',
  blockedBy: [],
  dependents: [{ id: 'X-D', title: 'The waiting item', abandoned: false }],
}
const both = {
  id: 'X-4',
  blockedBy: [{ id: 'X-B', title: 'The blocker item', abandoned: false }],
  dependents: [{ id: 'X-D', title: 'The waiting item', abandoned: false }],
}

test('an item with neither direction renders nothing at all, compact form', () => {
  const { container } = render(<DependencyBadge item={neither} compact />)
  expect(container.firstChild).toBeNull()
})

test('an item with neither direction renders nothing at all, full form', () => {
  const { container } = render(<DependencyBadge item={neither} />)
  expect(container.firstChild).toBeNull()
})

test('a blocker renders "Blocked by" with the blocker named, compact form — never bare "Blocked"', () => {
  const { container, queryByText } = render(<DependencyBadge item={blockedOnly} compact />)
  expect(container.querySelector('.dep-pill--blocked').textContent).toBe('Blocked by X-B')
  expect(queryByText('Blocks 1')).toBeNull()
})

test('dependents render "Blocks N" with no blocked text at all, compact form', () => {
  const { getByText, queryByText } = render(<DependencyBadge item={dependentsOnly} compact />)
  expect(getByText('Blocks 1')).toBeTruthy()
  expect(queryByText(/Blocked/)).toBeNull()
})

test('an item with both directions renders both pills, compact form', () => {
  const { container, getByText } = render(<DependencyBadge item={both} compact />)
  expect(container.querySelector('.dep-pill--blocked').textContent).toBe('Blocked by X-B')
  expect(getByText('Blocks 1')).toBeTruthy()
})

test('the two compact pills resolve to different CSS classes — blocked is visually distinct from blocks', () => {
  const { container } = render(<DependencyBadge item={both} compact />)
  const blocked = container.querySelector('.dep-pill--blocked')
  const dependents = container.querySelector('.dep-pill--dependents')
  expect(blocked).toBeTruthy()
  expect(dependents).toBeTruthy()
  expect(blocked.className).not.toBe(dependents.className)
})

// HZ-335: the card names every blocker as a link — no "+N more" summary.
test('every blocker is named as its own link, compact form, full title list still in the tooltip', () => {
  const item = {
    id: 'X-5',
    blockedBy: [
      { id: 'X-B1', title: 'First blocker', abandoned: false },
      { id: 'X-B2', title: 'Second blocker', abandoned: false },
    ],
    dependents: [],
  }
  const { container } = render(<DependencyBadge item={item} compact />)
  const pill = container.querySelector('.dep-pill--blocked')
  expect(pill.textContent).toBe('Blocked by X-B1, X-B2')
  const links = [...pill.querySelectorAll('a')]
  expect(links.map((a) => a.textContent)).toEqual(['X-B1', 'X-B2'])
  expect(links[0].getAttribute('href').endsWith('/x-b1')).toBe(true)
  expect(links[1].getAttribute('href').endsWith('/x-b2')).toBe(true)
  expect(pill.title).toContain('First blocker')
  expect(pill.title).toContain('Second blocker')
})

test('an abandoned blocker is flagged, not dropped, compact form', () => {
  const item = { id: 'X-6', blockedBy: [{ id: 'X-B', title: 'Dead end', abandoned: true }], dependents: [] }
  const { container } = render(<DependencyBadge item={item} compact />)
  expect(container.querySelector('.dep-pill--blocked').textContent).toBe('Blocked by X-B (abandoned)')
})

test('full form: a blocker section names the blocker under a "Blocked by" label', () => {
  const { getByText } = render(<DependencyBadge item={blockedOnly} />)
  expect(getByText('Blocked by')).toBeTruthy()
  expect(getByText('The blocker item')).toBeTruthy()
})

test('full form: a dependents section names the dependent under a "Blocks" label', () => {
  const { getByText } = render(<DependencyBadge item={dependentsOnly} />)
  expect(getByText('Blocks')).toBeTruthy()
  expect(getByText('The waiting item')).toBeTruthy()
})

test('full form: the Blocks section renders nothing when there are no dependents, even if blocked by something', () => {
  const { queryByText } = render(<DependencyBadge item={blockedOnly} />)
  expect(queryByText('Blocks')).toBeNull()
})

test('full form: the Blocked by section renders nothing when there is no blocker, even with dependents', () => {
  const { queryByText } = render(<DependencyBadge item={dependentsOnly} />)
  expect(queryByText('Blocked by')).toBeNull()
})

test('full form: an abandoned dependent is flagged inline, not dropped from the list', () => {
  const item = { id: 'X-7', blockedBy: [], dependents: [{ id: 'X-D', title: 'Stalled dependent', abandoned: true }] }
  const { getByText } = render(<DependencyBadge item={item} />)
  expect(getByText(/Stalled dependent/)).toBeTruthy()
  expect(getByText(/abandoned/)).toBeTruthy()
})

// HZ-95 follow-up: the id is what makes a dependency actionable. It was in the
// payload all along but rendered only as a React key, so the UI named blockers
// by prose title alone — unusable for navigating to the blocker.

test('the detail view names the blocker by id, not title alone', () => {
  const { getByText } = render(<DependencyBadge item={blockedOnly} />)
  expect(getByText('X-B')).toBeTruthy()
  expect(getByText('The blocker item')).toBeTruthy()
})

test('the blocker id links to that item', () => {
  const { getByText } = render(<DependencyBadge item={blockedOnly} />)
  const link = getByText('X-B').closest('a')
  expect(link).toBeTruthy()
  expect(link.getAttribute('href').endsWith('/x-b')).toBe(true)
})

test('the dependent id links to that item too, so both directions navigate', () => {
  const { getByText } = render(<DependencyBadge item={dependentsOnly} />)
  const link = getByText('X-D').closest('a')
  expect(link).toBeTruthy()
  expect(link.getAttribute('href').endsWith('/x-d')).toBe(true)
})

test('the compact pill leads with the id and keeps every id in its tooltip', () => {
  const item = {
    id: 'X-8',
    blockedBy: [
      { id: 'X-B1', title: 'First blocker', abandoned: false },
      { id: 'X-B2', title: 'Second blocker', abandoned: true },
    ],
    dependents: [],
  }
  const { container } = render(<DependencyBadge item={item} compact />)
  const pill = container.querySelector('.dep-pill--blocked')
  expect(pill.textContent).toContain('X-B1')
  expect(pill.title).toContain('X-B1')
  expect(pill.title).toContain('X-B2')
  expect(pill.title).toContain('(abandoned)')
})

// ---- HZ-310: the X beside each "Blocked by" entry, full form only ----

const twoBlockers = {
  id: 'X-5',
  blockedBy: [
    { id: 'X-B1', title: 'First blocker', abandoned: false },
    { id: 'X-B2', title: 'Second blocker', abandoned: false },
  ],
  dependents: [{ id: 'X-D', title: 'The waiting item', abandoned: false }],
}

const removeButtons = (utils) => utils.queryAllByRole('button', { name: /^Remove dependency on / })

test('two blockers plus onRemove show exactly two remove controls', () => {
  const utils = render(<DependencyBadge item={twoBlockers} onRemove={vi.fn()} />)
  expect(removeButtons(utils)).toHaveLength(2)
  expect(utils.getByRole('button', { name: 'Remove dependency on X-B1' })).toBeTruthy()
  expect(utils.getByRole('button', { name: 'Remove dependency on X-B2' })).toBeTruthy()
})


test('the compact form renders no remove control even when onRemove is passed', () => {
  const utils = render(<DependencyBadge item={twoBlockers} compact onRemove={vi.fn()} />)
  expect(removeButtons(utils)).toHaveLength(0)
})

test('the full form without onRemove renders no remove control', () => {
  const utils = render(<DependencyBadge item={twoBlockers} />)
  expect(removeButtons(utils)).toHaveLength(0)
})

test('one click calls onRemove once for that edge; the other blocker stays listed', () => {
  const onRemove = vi.fn().mockResolvedValue({ ok: true })
  const utils = render(<DependencyBadge item={twoBlockers} onRemove={onRemove} />)
  fireEvent.click(utils.getByRole('button', { name: 'Remove dependency on X-B1' }))
  expect(onRemove).toHaveBeenCalledTimes(1)
  expect(onRemove).toHaveBeenCalledWith('X-5', 'X-B1')
  expect(utils.getByText('X-B2')).toBeTruthy()
  expect(utils.getByRole('button', { name: 'Remove dependency on X-B2' }).disabled).toBe(false)
})

test('after onRemove resolves the X stays disabled until the edge leaves, then the edge is gone', async () => {
  const onRemove = vi.fn().mockResolvedValue({ ok: true })
  const utils = render(<DependencyBadge item={twoBlockers} onRemove={onRemove} />)
  const x = () => utils.getByRole('button', { name: 'Remove dependency on X-B1' })
  fireEvent.click(x())
  await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1))
  await act(async () => {})
  expect(x().disabled).toBe(true)
  fireEvent.click(x())
  expect(onRemove).toHaveBeenCalledTimes(1)

  // The SSE snapshot arrives without the edge.
  utils.rerender(<DependencyBadge item={{ ...twoBlockers, blockedBy: [twoBlockers.blockedBy[1]] }} onRemove={onRemove} />)
  expect(utils.queryByText('X-B1')).toBeNull()
  expect(utils.queryByRole('button', { name: 'Remove dependency on X-B1' })).toBeNull()
  expect(utils.getByText('X-B2')).toBeTruthy()
})

test('a rejected remove keeps the edge listed and shows the error', async () => {
  const onRemove = vi.fn().mockRejectedValue(new Error('not_found'))
  const utils = render(<DependencyBadge item={twoBlockers} onRemove={onRemove} />)
  fireEvent.click(utils.getByRole('button', { name: 'Remove dependency on X-B1' }))
  const alert = await utils.findByRole('alert')
  expect(alert.textContent).toMatch(/not_found/)
  expect(utils.getByText('X-B1')).toBeTruthy()
  expect(utils.getByRole('button', { name: 'Remove dependency on X-B1' }).disabled).toBe(false)
})

// ---- HZ-354: an X beside each "Blocks" entry too ----

test('each Blocks entry has an X; clicking it removes that dependent\'s link to this item through the same onRemove', () => {
  const onRemove = vi.fn().mockResolvedValue({ ok: true })
  const item = {
    id: 'X-3',
    blockedBy: [],
    dependents: [
      { id: 'X-D', title: 'The waiting item', abandoned: false },
      { id: 'X-E', title: 'Another waiting item', abandoned: false },
    ],
  }
  const utils = render(<DependencyBadge item={item} onRemove={onRemove} />)
  const blocks = utils.container.querySelector('.dep-detail__section--dependents')
  expect(blocks.querySelectorAll('button')).toHaveLength(2)
  fireEvent.click(utils.getByRole('button', { name: "Remove X-D's dependency on X-3" }))
  expect(onRemove).toHaveBeenCalledTimes(1)
  expect(onRemove).toHaveBeenCalledWith('X-D', 'X-3')
  expect(utils.getByRole('button', { name: "Remove X-E's dependency on X-3" }).disabled).toBe(false)
})

test('a rejected Blocks remove keeps the dependent listed and shows the error inline', async () => {
  // e.g. project_not_active when the dependent's project is disabled.
  const onRemove = vi.fn().mockRejectedValue(new Error('project_not_active'))
  const utils = render(<DependencyBadge item={dependentsOnly} onRemove={onRemove} />)
  fireEvent.click(utils.getByRole('button', { name: "Remove X-D's dependency on X-3" }))
  const alert = await utils.findByRole('alert')
  expect(alert.textContent).toBe("Couldn't remove: project_not_active")
  expect(utils.getByText('X-D')).toBeTruthy()
  expect(utils.getByRole('button', { name: "Remove X-D's dependency on X-3" }).disabled).toBe(false)
})

test('the Blocks list renders no remove control without onRemove', () => {
  const utils = render(<DependencyBadge item={dependentsOnly} />)
  expect(utils.container.querySelector('.dep-detail__section--dependents button')).toBeNull()
})

test('a kept link to an abandoned blocker still reads "Blocked by <id> (abandoned)" with its X', () => {
  const onRemove = vi.fn().mockResolvedValue({ ok: true })
  const item = { id: 'X-6', blockedBy: [{ id: 'X-GONE', title: 'Abandoned blocker', abandoned: true }], dependents: [] }
  const full = render(<DependencyBadge item={item} onRemove={onRemove} />)
  const section = full.container.querySelector('.dep-detail__section--blocked')
  expect(section.textContent).toContain('Blocked by')
  expect(section.textContent).toContain('X-GONE')
  expect(section.textContent).toContain('abandoned')
  fireEvent.click(full.getByRole('button', { name: 'Remove dependency on X-GONE' }))
  expect(onRemove).toHaveBeenCalledWith('X-6', 'X-GONE')
  cleanup()
  const compact = render(<DependencyBadge item={item} compact />)
  expect(compact.container.querySelector('.dep-pill--blocked').textContent).toBe('Blocked by X-GONE (abandoned)')
})

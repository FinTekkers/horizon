// HZ-95: dependency direction rendering. The component reads item.blockedBy
// / item.dependents straight from the API payload — no client-side
// derivation — so these tests exercise the four shapes a payload can take:
// a blocker, dependents, both, and neither.

import { expect, test, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import DependencyBadge from './DependencyBadge'

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
  const { getByText, queryByText } = render(<DependencyBadge item={blockedOnly} compact />)
  expect(getByText(/Blocked by The blocker item/)).toBeTruthy()
  expect(queryByText('Blocks 1')).toBeNull()
})

test('dependents render "Blocks N" with no blocked text at all, compact form', () => {
  const { getByText, queryByText } = render(<DependencyBadge item={dependentsOnly} compact />)
  expect(getByText('Blocks 1')).toBeTruthy()
  expect(queryByText(/Blocked/)).toBeNull()
})

test('an item with both directions renders both pills, compact form', () => {
  const { getByText } = render(<DependencyBadge item={both} compact />)
  expect(getByText(/Blocked by The blocker item/)).toBeTruthy()
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

test('a second blocker is summarized as "+N more", full title list still available via title attribute', () => {
  const item = {
    id: 'X-5',
    blockedBy: [
      { id: 'X-B1', title: 'First blocker', abandoned: false },
      { id: 'X-B2', title: 'Second blocker', abandoned: false },
    ],
    dependents: [],
  }
  const { getByText } = render(<DependencyBadge item={item} compact />)
  expect(getByText(/Blocked by First blocker \+1 more/)).toBeTruthy()
})

test('an abandoned blocker is flagged, not dropped, compact form', () => {
  const item = { id: 'X-6', blockedBy: [{ id: 'X-B', title: 'Dead end', abandoned: true }], dependents: [] }
  const { getByText } = render(<DependencyBadge item={item} compact />)
  expect(getByText(/Blocked by Dead end \(abandoned\)/)).toBeTruthy()
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

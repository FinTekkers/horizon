// HO-853 metric line 2 and guardrail 3: the design panel shows the latest
// round's brief and what changed, and every listed round opens its own canvas.
// A canvas link that is not https (a `javascript:` one, say) is drawn as plain
// text, never as a link. One round is not listed twice.

import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import DesignPanel from './DesignPanel'

afterEach(() => cleanup())

const ITEM = { id: 'HZ-953' }
const SPEC = { substepId: 'design-screens', gateIndex: 3, approved: false, canvasUrl: null, skipReason: null, verdictSkipReason: null, approvedBy: null, pendingRunId: 12 }
const round = (n, canvasUrl, extra = {}) => ({ round: n, kind: 'run', brief: `Brief ${n}`, whatChanged: `Changed ${n}`, runId: 10 + n, canvasUrl, ...extra })
const URLS = ['https://blueprint-studio.internalmeta.com/canvas/r1', 'https://blueprint-studio.internalmeta.com/canvas/r2', 'https://blueprint-studio.internalmeta.com/canvas/r3']

test('two or more rounds: the latest round’s brief and what changed, and each listed round links its own canvas', () => {
  const sub = { id: 'design-screens', rounds: URLS.map((u, i) => round(i + 1, u)) }
  const view = render(<DesignPanel item={ITEM} spec={SPEC} sub={sub} />)
  const latest = within(view.getByTestId('design-latest'))
  expect(latest.getByText('Brief 3')).toBeTruthy()
  expect(latest.getByText('Changed 3')).toBeTruthy()
  expect(latest.getByRole('link', { name: 'Open the latest canvas ↗' }).getAttribute('href')).toBe(URLS[2])
  const links = within(view.getByRole('list', { name: 'Design rounds' })).getAllByRole('link')
  expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])).toEqual(
    URLS.map((u, i) => [`Round ${i + 1} canvas ↗`, u, '_blank', 'noopener noreferrer']),
  )
})

test('a round whose canvas link is not https shows as text, with no link', () => {
  const sub = { id: 'design-screens', rounds: [round(1, 'javascript:alert(1)'), round(2, 'http://blueprint-studio.internalmeta.com/canvas/r2')] }
  const view = render(<DesignPanel item={ITEM} spec={SPEC} sub={sub} />)
  expect(view.queryAllByRole('link')).toHaveLength(0)
  const list = within(view.getByRole('list', { name: 'Design rounds' }))
  expect(list.getByText('Round 1 · no canvas')).toBeTruthy()
  expect(list.getByText('Round 2 · no canvas')).toBeTruthy()
})

test('one round: shown once, as the latest, with no round list', () => {
  const view = render(<DesignPanel item={ITEM} spec={SPEC} sub={{ id: 'design-screens', rounds: [round(1, URLS[0])] }} />)
  expect(view.queryByRole('list', { name: 'Design rounds' })).toBeNull()
  expect(view.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([URLS[0]])
})

test('the actions call their handlers, are disabled while busy, and are absent without one', () => {
  const onRequestChanges = vi.fn()
  const onApproveWithoutDesign = vi.fn()
  const sub = { id: 'design-screens', rounds: [round(1, URLS[0])] }
  const view = render(<DesignPanel item={ITEM} spec={SPEC} sub={sub} onRequestChanges={onRequestChanges} onApproveWithoutDesign={onApproveWithoutDesign} />)
  fireEvent.click(view.getByRole('button', { name: 'Request changes' }))
  fireEvent.click(view.getByRole('button', { name: 'Approve without design' }))
  expect(onRequestChanges).toHaveBeenCalledTimes(1)
  expect(onApproveWithoutDesign).toHaveBeenCalledTimes(1)
  view.rerender(<DesignPanel item={ITEM} spec={SPEC} sub={sub} busy onRequestChanges={onRequestChanges} onApproveWithoutDesign={onApproveWithoutDesign} />)
  expect(view.getByRole('button', { name: 'Request changes' }).disabled).toBe(true)
  view.rerender(<DesignPanel item={ITEM} spec={SPEC} sub={sub} />)
  expect(view.queryAllByRole('button')).toHaveLength(0)
})

test('the agent said no design: the panel says why and offers no Approve without design', () => {
  const sub = { id: 'design-screens', rounds: [{ round: 1, kind: 'skip', brief: 'backend only', whatChanged: null, runId: null, canvasUrl: null }], skip: { reason: 'backend only' } }
  const view = render(<DesignPanel item={ITEM} spec={{ ...SPEC, pendingRunId: null, verdictSkipReason: 'backend only' }} sub={sub} />)
  expect(view.getByText(/The agent said no design is needed: backend only/)).toBeTruthy()
  expect(within(view.getByTestId('design-latest')).getByText('Skipped')).toBeTruthy()
  expect(within(view.getByTestId('design-latest')).queryByText('What changed')).toBeNull()
})

// HZ-544: the Pending approvals entry of an item with Autopilot off says why
// it is waiting and, from the server's autopilotWouldHave (an evaluation at
// the item's CURRENT gate only), what Autopilot would have done. Only in a
// project whose Autopilot is on.

import { afterEach, expect, test } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import ApprovalsDrawer from './ApprovalsDrawer'
import { ACCEPT_GATE_INDEX } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const noop = () => {}

function entry(extra = {}) {
  const { container } = render(
    <ApprovalsDrawer
      items={[
        {
          id: 'LM-364',
          title: 'Adjusted cost basis',
          priority: 'Medium',
          cursor: ACCEPT_GATE_INDEX,
          issue: 364,
          pr: 12,
          pr_url: 'https://example.test/pr/12',
          paused: false,
          rejected: false,
          activeRun: null,
          gateAction: null,
          autopilotOff: true,
          projectAutopilot: 'on',
          autopilotWouldHave: null,
          ...extra,
        },
      ]}
      onClose={noop}
      onOpenItem={noop}
      onApprove={noop}
      onReject={noop}
    />,
  )
  return container.querySelector('.approval')
}

test('the entry carries the chip, the gate note, why it waits and what Autopilot would have done', () => {
  const approval = entry({ autopilotWouldHave: { decision: 'approve', reason: 'checks passed and the PR is mergeable' } })
  expect(approval.querySelector('.approval__meta .autopilot-off-chip')?.textContent).toBe('Autopilot off')
  expect(approval.querySelector('.approval__gate-label').textContent).toBe('Accept the code · Autopilot is off for this item')
  const note = approval.querySelector('.autopilot-off-note')
  expect(note.textContent).toContain(
    'Waiting for you because Autopilot is off for this item. Autopilot would have accepted: checks passed and the PR is mergeable.',
  )
  const link = note.querySelector('a')
  expect(link.textContent).toBe('Open the PR diff')
  expect(link.getAttribute('href')).toBe('https://example.test/pr/12')
})

test('with no evaluation at the current gate there is no "would have" line', () => {
  // The server sends null when its only item-off evaluation is from another gate.
  const note = entry({ autopilotWouldHave: null }).querySelector('.autopilot-off-note')
  expect(note.textContent).toContain('Waiting for you because Autopilot is off for this item.')
  expect(note.textContent).not.toContain('would have')
})

for (const mode of ['shadow', 'off']) {
  test(`in an Autopilot-${mode} project the entry shows no chip, no note and no gate suffix`, () => {
    const approval = entry({ projectAutopilot: mode, autopilotWouldHave: { decision: 'approve', reason: 'x' } })
    expect(approval.querySelector('.autopilot-off-chip')).toBeNull()
    expect(approval.querySelector('.autopilot-off-note')).toBeNull()
    expect(approval.querySelector('.approval__gate-label').textContent).toBe('Accept the code')
  })
}

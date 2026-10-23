// HZ-544: a card whose item has Autopilot off (its `autopilot-off` label)
// shows the dark "Autopilot off" chip and says so on its gate label — only in
// a project whose Autopilot is on. The gate itself stays amber "Awaiting you".

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import { ACCEPT_GATE_INDEX } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const noop = () => {}

function renderCard(item) {
  const { container } = render(
    <Board
      items={[
        {
          id: 'LM-364',
          title: 'Adjusted cost basis',
          priority: 'Medium',
          cursor: ACCEPT_GATE_INDEX,
          issue: 364,
          repo: 'FinTekkers/ledger-models',
          pr: 12,
          pr_url: 'https://example.test/pr/12',
          paused: false,
          rejected: false,
          activeRun: null,
          gateAction: null,
          events: [],
          ...item,
        },
      ]}
      onOpen={noop}
      onApprove={noop}
      onReject={noop}
      onTogglePause={noop}
      onNewItem={noop}
    />,
  )
  return container.querySelector('.card')
}

test('in an Autopilot-on project the card shows the chip and the gate label says why it waits', () => {
  const card = renderCard({ autopilotOff: true, projectAutopilot: 'on' })
  expect(card.querySelector('.autopilot-off-chip')?.textContent).toBe('Autopilot off')
  expect(card.querySelector('.card__gate-label').textContent).toBe('Accept the code · Autopilot is off for this item')
  expect(card.querySelector('.card__gate-actions')).not.toBeNull()
})

test('an unlabelled item in an Autopilot-on project shows neither', () => {
  const card = renderCard({ autopilotOff: false, projectAutopilot: 'on' })
  expect(card.querySelector('.autopilot-off-chip')).toBeNull()
  expect(card.querySelector('.card__gate-label').textContent).toBe('Accept the code')
})

for (const mode of ['shadow', 'off']) {
  test(`a labelled item in an Autopilot-${mode} project shows no chip and no gate note`, () => {
    const card = renderCard({ autopilotOff: true, projectAutopilot: mode })
    expect(card.querySelector('.autopilot-off-chip')).toBeNull()
    expect(card.querySelector('.card__gate-label').textContent).toBe('Accept the code')
  })
}

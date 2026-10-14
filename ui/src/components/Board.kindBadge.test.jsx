// HZ-454: a default-kind (change) card shows no kind badge — moved here from
// e2e/tests/37-create-task.spec.js, which keeps the Task journey through the
// real server. That the server stores `kind: change` by default is
// server/test/item-kind.test.mjs's job.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import { firstStepIndex } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const noop = () => {}

function renderCard(item) {
  const { container } = render(
    <Board
      items={[
        {
          id: 'HZ-7',
          title: 'E2E change',
          priority: 'Medium',
          cursor: firstStepIndex('change'),
          issue: null,
          pr: null,
          paused: false,
          rejected: false,
          activeRun: null,
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

test('a card with the default kind shows no badge', () => {
  const card = renderCard({ kind: 'change' })
  expect(card.querySelector('.card__title').textContent).toContain('E2E change')
  expect(card.querySelector('.kind-badge')).toBeNull()
})

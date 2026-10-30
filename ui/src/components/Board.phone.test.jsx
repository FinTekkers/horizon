// HZ-586: at 700px and up the board renders all five lifecycle columns, with
// no tabs. The phone layout (one column, tab row) is covered by e2e spec 58.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import { MOBILE_QUERY } from '../useMediaQuery'
import { PHASES } from '../../../domain/js/lifecycle.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const noop = () => {}
const item = (id, cursor) => ({ id, title: `Work item ${id}`, priority: 'Medium', cursor, issue: null, pr: null, paused: true })
const items = [item('HZ-1', 0), item('HZ-2', 0), item('HZ-3', 4)]

function stubPhone(matches) {
  vi.stubGlobal('matchMedia', (query) => ({
    matches: matches && query === MOBILE_QUERY,
    media: query,
    addEventListener: noop,
    removeEventListener: noop,
  }))
}

const renderBoard = () =>
  render(<Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />)

test('at 700px and up all five columns show with no tabs or tab panel', () => {
  stubPhone(false)
  const { queryByRole, container } = renderBoard()
  expect(queryByRole('tablist')).toBeNull()
  expect(container.querySelectorAll('.col')).toHaveLength(PHASES.length)
  expect(container.querySelector('.col[role], .col[id]')).toBeNull()
  expect(container.querySelector('.board__cols').className).toBe('board__cols')
})

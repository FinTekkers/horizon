// HZ-586: below 700px the board renders one lifecycle column at a time,
// picked from a tab row; at 700px and up it renders all five, with no tabs.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

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

test('on a phone, one column shows and its tabs switch columns', () => {
  stubPhone(true)
  const { getByRole, getAllByRole, container, queryByText } = renderBoard()
  const tabs = getAllByRole('tab')
  expect(getByRole('tablist', { name: 'Board columns' })).toBeTruthy()
  expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual([
    `${PHASES[0]}, 2 items`,
    `${PHASES[1]}, 1 item`,
    `${PHASES[2]}, 0 items`,
    `${PHASES[3]}, 0 items`,
    `${PHASES[4]}, 0 items`,
  ])
  expect(container.querySelectorAll('.col')).toHaveLength(1)
  expect(container.querySelector('.col__name').textContent).toBe('Plan')
  expect(getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('board-tab-0')

  fireEvent.click(tabs[1])
  expect(container.querySelector('.col__name').textContent).toBe('Technical Plan')
  expect(queryByText('Work item HZ-1')).toBeNull()
  expect(queryByText('Work item HZ-3')).toBeTruthy()
  expect(tabs[1].getAttribute('aria-selected')).toBe('true')
  expect(tabs[0].getAttribute('aria-selected')).toBe('false')

  // An empty column still renders, at full width.
  fireEvent.keyDown(tabs[1], { key: 'ArrowRight' })
  expect(container.querySelectorAll('.col')).toHaveLength(1)
  expect(container.querySelector('.col__name').textContent).toBe(PHASES[2])
  expect(container.querySelector('.col__count').textContent).toBe('0')
  expect(tabs[2].getAttribute('tabindex')).toBe('0')
  expect(tabs[1].getAttribute('tabindex')).toBe('-1')
})

test('at 700px and up all five columns show with no tabs or tab panel', () => {
  stubPhone(false)
  const { queryByRole, container } = renderBoard()
  expect(queryByRole('tablist')).toBeNull()
  expect(container.querySelectorAll('.col')).toHaveLength(PHASES.length)
  expect(container.querySelector('.col[role], .col[id]')).toBeNull()
  expect(container.querySelector('.board__cols').className).toBe('board__cols')
})

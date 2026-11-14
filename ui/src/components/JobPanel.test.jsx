// HZ-407: the Execute card's live job — every approved command with its
// status, elapsed against the budget, the log tail and the Full log link;
// Stop run only while running, Resume only once stopped.

import { afterEach, expect, test, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react'

vi.mock('../api', () => ({
  jobLogUrl: (id) => `/horizon/api/items/${id}/job/log?format=text`,
}))

import JobPanel from './JobPanel'
import { EXECUTE_STEP_INDEX } from '../../../domain/js/lifecycle.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const item = { id: 'TK-7', kind: 'task', cursor: EXECUTE_STEP_INDEX, paused: false }
const job = (status, statuses, extra = {}) => ({
  status,
  elapsedS: 42,
  budgetS: 1200,
  startedAt: '2026-10-11T10:00:00+00:00',
  updatedAt: '2026-10-11T10:00:42+00:00',
  commands: statuses.map((s, i) => ({ command: `scripts/step-${i + 1}.sh`, status: s, exit_code: s === 'done' ? 0 : null })),
  logTail: ['$ scripts/step-2.sh', '✓ 12 passed'],
  ...extra,
})

test('lists every command with its status, elapsed against the budget, the log tail and the full-log link', () => {
  render(<JobPanel item={{ ...item, paused: true }} job={job('stopped', ['done', 'stopped', 'pending', 'pending'])} onStop={vi.fn()} onResume={vi.fn()} />)
  const rows = screen.getAllByRole('listitem')
  expect(rows.map((r) => r.textContent)).toEqual([
    'donescripts/step-1.sh',
    'stoppedscripts/step-2.sh',
    'pendingscripts/step-3.sh',
    'pendingscripts/step-4.sh',
  ])
  expect(screen.getByTestId('job-elapsed').textContent).toBe('0:42 of 20:00 budget')
  expect(screen.getByTestId('job-log').textContent).toBe('$ scripts/step-2.sh\n✓ 12 passed')
  expect(screen.getByRole('link', { name: /Full log/ }).getAttribute('href')).toBe('/horizon/api/items/TK-7/job/log?format=text')
})

test('a running command shows running, and a new frame shows the new line and status without remounting', () => {
  const { rerender } = render(<JobPanel item={item} job={job('running', ['done', 'running', 'pending'])} onStop={vi.fn()} onResume={vi.fn()} />)
  expect(within(screen.getAllByRole('listitem')[1]).getByText('running')).toBeTruthy()
  rerender(
    <JobPanel
      item={item}
      job={job('running', ['done', 'done', 'running'], { logTail: ['$ scripts/step-3.sh', 'a brand new line'] })}
      onStop={vi.fn()}
      onResume={vi.fn()}
    />,
  )
  expect(screen.getByText(/a brand new line/)).toBeTruthy()
  expect(within(screen.getAllByRole('listitem')[1]).getByText('done')).toBeTruthy()
  expect(within(screen.getAllByRole('listitem')[2]).getByText('running')).toBeTruthy()
})

test('while running, elapsed moves on between frames from the last update', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-11T10:00:42Z'))
  render(<JobPanel item={item} job={job('running', ['running'])} onStop={vi.fn()} onResume={vi.fn()} />)
  expect(screen.getByTestId('job-elapsed').textContent).toBe('0:42 of 20:00 budget')
  act(() => vi.advanceTimersByTime(3000))
  expect(screen.getByTestId('job-elapsed').textContent).toBe('0:45 of 20:00 budget')
})

test('Stop run shows only while running, and sends the item id', () => {
  const onStop = vi.fn(() => Promise.resolve({ ok: true }))
  const { rerender } = render(<JobPanel item={item} job={job('running', ['done', 'running', 'pending'])} onStop={onStop} onResume={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Stop run' }))
  expect(onStop).toHaveBeenCalledWith('TK-7')
  for (const status of ['stopped', 'budget_exceeded', 'finished']) {
    rerender(<JobPanel item={{ ...item, paused: true }} job={job(status, ['done', 'stopped', 'pending'])} onStop={onStop} onResume={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull()
  }
})

test('Resume shows only once stopped, on the paused item still at Execute', async () => {
  const onResume = vi.fn(() => Promise.reject(new Error('plan_changed')))
  const stopped = job('stopped', ['done', 'stopped', 'pending'])
  const { rerender } = render(<JobPanel item={{ ...item, paused: true }} job={stopped} onStop={vi.fn()} onResume={onResume} />)
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
  expect(onResume).toHaveBeenCalledWith('TK-7')
  expect((await screen.findByRole('alert')).textContent).toMatch(/approve it again/)

  rerender(<JobPanel item={{ ...item, paused: true }} job={job('budget_exceeded', ['done', 'stopped', 'pending'])} onStop={vi.fn()} onResume={onResume} />)
  expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
  rerender(<JobPanel item={{ ...item, paused: false }} job={stopped} onStop={vi.fn()} onResume={onResume} />)
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  rerender(<JobPanel item={{ ...item, paused: true, cursor: EXECUTE_STEP_INDEX + 1 }} job={stopped} onStop={vi.fn()} onResume={onResume} />)
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  rerender(<JobPanel item={{ ...item, paused: true }} job={job('running', ['done', 'running', 'pending'])} onStop={vi.fn()} onResume={onResume} />)
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
})

test('log lines render as text, never as HTML', () => {
  const { container } = render(
    <JobPanel item={item} job={job('running', ['running'], { logTail: ['<img src=x onerror=alert(1)>'] })} onStop={vi.fn()} onResume={vi.fn()} />,
  )
  expect(screen.getByTestId('job-log').textContent).toBe('<img src=x onerror=alert(1)>')
  expect(container.querySelector('img')).toBeNull()
})

// HO-843: Patch, on the first command that did not pass, only while no job
// runs at Execute on an approved plan; its errors are keyed by code, and a
// literal secret is named by shape only.
test('Patch is offered on the first command that did not pass, and never while the job runs', () => {
  const approved = { ...item, paused: true, approvedPlanHash: 'h'.repeat(64) }
  const { rerender } = render(<JobPanel item={approved} job={job('stopped', ['done', 'stopped', 'pending'])} onPatch={vi.fn()} />)
  expect(screen.getAllByRole('button', { name: 'Patch' })).toHaveLength(1)
  expect(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: 'Patch' })).toBeTruthy()
  rerender(<JobPanel item={approved} job={job('running', ['done', 'running', 'pending'])} onPatch={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Patch' })).toBeNull()
  rerender(<JobPanel item={{ ...approved, approvedPlanHash: null }} job={job('stopped', ['done', 'stopped', 'pending'])} onPatch={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Patch' })).toBeNull()
})

test('Patch sends the edited command with its 0-based index; a literal secret is refused by shape name', async () => {
  const onPatch = vi.fn(() => Promise.reject(Object.assign(new Error('literal_secret'), { shapes: ['github-token'] })))
  render(<JobPanel item={{ ...item, paused: true, approvedPlanHash: 'h'.repeat(64) }} job={job('stopped', ['done', 'stopped', 'pending'])} onPatch={onPatch} />)
  fireEvent.click(screen.getByRole('button', { name: 'Patch' }))
  const input = screen.getByLabelText('New command 2')
  expect(input.value).toBe('scripts/step-2.sh')
  fireEvent.change(input, { target: { value: 'scripts/step-2.sh --fast' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Patch command' }))
  })
  expect(onPatch).toHaveBeenCalledWith('TK-7', { index: 1, command: 'scripts/step-2.sh --fast' })
  expect(screen.getByRole('alert').textContent).toBe('That looks like a literal secret (github-token) — name secrets only as references like $GITHUB_TOKEN.')
})

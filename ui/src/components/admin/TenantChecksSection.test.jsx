// HZ-750: a tenant member opts the test and e2e slots into a fix round's
// targeted run. The box is disabled while its slot has no command, and the
// ticked slots go out in the save payload as `targeted`.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import * as api from '../../api'
import TenantChecksSection from './TenantChecksSection'

vi.mock('../../api', () => ({
  getTenantChecks: vi.fn(),
  saveTenantChecks: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const PROJECT = { id: 9, repos: [{ repo: 'tenant/app' }] }
const TARGETED = 'On a fix round, re-run only the failed tests first'

test('the box is disabled with no command, and targeted rides in the save payload', async () => {
  api.getTenantChecks.mockResolvedValueOnce({ repo: 'tenant/app', checks: { install: 'npm ci', test: 'npm test', e2e: null }, targeted: [] })
  api.saveTenantChecks.mockResolvedValueOnce({ ok: true, repo: 'tenant/app', checks: {}, targeted: ['test'] })
  render(<TenantChecksSection project={PROJECT} />)

  const e2eBox = await screen.findByLabelText(`End-to-end tests: ${TARGETED} (tenant/app)`)
  expect(e2eBox.disabled).toBe(true)
  expect(screen.queryByLabelText(`Install: ${TARGETED} (tenant/app)`)).toBeNull()
  const testBox = screen.getByLabelText(`Test: ${TARGETED} (tenant/app)`)
  expect(testBox.disabled).toBe(false)
  fireEvent.click(testBox)
  fireEvent.click(screen.getByRole('button', { name: 'Save check commands' }))

  await screen.findByText('Saved. The next run uses these commands.')
  expect(api.saveTenantChecks).toHaveBeenCalledWith(9, 'tenant/app', {
    install: 'npm ci',
    test: 'npm test',
    e2e: '',
    targeted: ['test'],
  })
  expect(screen.getByLabelText(`Test: ${TARGETED} (tenant/app)`).checked).toBe(true)
})

test('a stored opt-in loads ticked', async () => {
  api.getTenantChecks.mockResolvedValueOnce({
    repo: 'tenant/app',
    checks: { install: null, test: null, e2e: 'npx playwright test' },
    targeted: ['e2e'],
  })
  render(<TenantChecksSection project={PROJECT} />)

  expect((await screen.findByLabelText(`End-to-end tests: ${TARGETED} (tenant/app)`)).checked).toBe(true)
  expect(screen.getByLabelText(`Test: ${TARGETED} (tenant/app)`).disabled).toBe(true)
})

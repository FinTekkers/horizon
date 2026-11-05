// HZ-764 guardrail: Needs attention's Fix webhook goes through HZ-704's one
// in-page PIN dialog, as it does on the repository page. Driven through the
// real serverApi and a stubbed fetch: the fix route answers 401 until the PIN
// is sent, then the re-read hook is ok and the row goes away.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PinDialogProvider } from '../PinDialog'
import AdminPage from '../AdminPage'

const PIN = '418273'
const REPO = 'FinTekkers/ui-service'
const PROJECTS = [{ id: 1, name: 'Fintekkers', enabled: true, repos: [{ repo: REPO, prefix: 'US' }] }]
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

let fixed
let fetchSpy

beforeEach(() => {
  fixed = false
  fetchSpy = vi.fn(async (url, init = {}) => {
    if (url.endsWith('/admin/deploy-targets')) return json(200, { targets: [] })
    if (url.endsWith('/admin/check-flakes')) return json(200, { repos: [] })
    if (url.endsWith('/projects/1/repos/webhooks')) {
      return json(200, { webhooks: [{ repo: REPO, status: fixed ? 'ok' : 'missing', lastResponseCode: null, reason: null }] })
    }
    if (url.endsWith('/projects/1/repos/webhook/fix') && init.method === 'POST') {
      if (init.headers['x-human-key'] !== PIN) return json(401, { error: 'human_gate_key_required' })
      expect(JSON.parse(init.body)).toEqual({ repo: REPO })
      fixed = true
      return json(200, { ok: true })
    }
    return json(404, { error: 'not_found' })
  })
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('Fix webhook opens the PIN dialog; the PIN fixes the webhook and the row goes away', async () => {
  render(
    <PinDialogProvider>
      <AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} route={{ section: 'attention' }} onNavigate={() => {}} />
    </PinDialogProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Fix webhook' }))
  fireEvent.click(screen.getByRole('button', { name: 'Fix' }))

  const dialog = await screen.findByRole('dialog', { name: 'Enter your gate PIN' })
  expect(fixed).toBe(false)
  fireEvent.change(screen.getByLabelText('Gate PIN'), { target: { value: PIN } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  await waitFor(() => expect(screen.queryByRole('button', { name: 'Fix webhook' })).toBeNull())
  expect(dialog.isConnected).toBe(false)
  expect(fixed).toBe(true)
  expect(await screen.findByText('Nothing needs attention.')).toBeTruthy()
  const fixCalls = fetchSpy.mock.calls.filter(([url]) => url.endsWith('/repos/webhook/fix'))
  expect(fixCalls).toHaveLength(2)
})

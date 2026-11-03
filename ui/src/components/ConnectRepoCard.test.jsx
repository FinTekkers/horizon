// HZ-703: the "Connect your repository" card, wired to the real
// serverApi.connectTenantRepo with fetch stubbed, so each case sees the exact
// request the card sends and renders the server's own answer. A small harness
// keeps the result the way App does.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'

import ConnectRepoCard from './ConnectRepoCard'
import { API_BASE, connectTenantRepo } from '../api/serverApi'

const TOKEN = 'github_pat_11ABCDEFG0secretSECRETsecret42'
const PROJECT = { id: 7, name: 'Acme', enabled: true, repos: [] }
const SUCCESS = {
  ok: true,
  repo: 'Acme/site',
  prefix: 'ACME',
  defaultBranch: 'main',
  githubTokenRef: '$HZ_TENANT_7',
  runUser: 'acme',
  webhook: { status: 'ok', lastResponseCode: null, reason: null },
}

let consoleSpies
beforeEach(() => {
  localStorage.setItem('horizon_gate_pin', '123456')
  consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((level) => vi.spyOn(console, level))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})

function stubFetch(status, body) {
  const fetch = vi.fn(async () => ({ ok: status < 300, status, json: async () => body }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function Harness() {
  const [result, setResult] = useState(null)
  return (
    <ConnectRepoCard
      project={PROJECT}
      result={result}
      onConnect={connectTenantRepo}
      onConnected={setResult}
      settingsHref="/admin/checks"
      onOpenSettings={() => {}}
      onDone={() => setResult(null)}
    />
  )
}

function submit(repo = 'Acme/site', token = TOKEN) {
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: repo } })
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }))
}

const consoleText = () => consoleSpies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n')

test('metric 1: submitting owner/name and a token POSTs exactly both, then shows repo connected, webhook created and run user ready', async () => {
  const fetch = stubFetch(200, SUCCESS)
  render(<Harness />)
  expect(screen.getByRole('heading', { name: 'Connect your repository' })).toBeTruthy()
  submit()

  expect(await screen.findByRole('heading', { name: 'Repository connected' })).toBeTruthy()
  expect(fetch).toHaveBeenCalledTimes(1)
  const [url, opts] = fetch.mock.calls[0]
  expect(url).toBe(`${API_BASE}/tenant/projects/7/repos`)
  expect(opts.method).toBe('POST')
  expect(opts.headers['x-human-key']).toBe('123456')
  expect(JSON.parse(opts.body)).toEqual({ repo: 'Acme/site', token: TOKEN })

  const rows = screen.getAllByRole('listitem').map((li) => li.textContent)
  expect(rows).toEqual([
    'Repository connectedAcme/site, default branch main.',
    'Webhook createdGitHub tells Horizon about new issues and pull requests.',
    'Run user readyYour agents work in their own isolated space on the server.',
  ])
  // HZ-741 metric 5: the note names the connected repo.
  expect(screen.getByText('Horizon uses this token only for Acme/site.')).toBeTruthy()
  expect(document.body.textContent).not.toContain('$HZ_TENANT_7')
  expect(screen.getByRole('link', { name: 'Set your check commands' }).getAttribute('href')).toBe('/admin/checks')
  expect(screen.getByRole('button', { name: 'File your first item' })).toBeTruthy()
})

test('metric 1: a webhook GitHub did not create is shown as not created, never as created', async () => {
  stubFetch(200, { ...SUCCESS, webhook: { status: 'error', lastResponseCode: null, reason: null } })
  render(<Harness />)
  submit()
  expect(await screen.findByText('Webhook not created')).toBeTruthy()
  expect(screen.queryByText('Webhook created')).toBeNull()
  expect(screen.getByText('Repository connected', { selector: 'strong' })).toBeTruthy()
  expect(screen.getByText('Run user ready')).toBeTruthy()
})

test.each([
  [
    'token_too_broad',
    400,
    {
      error: 'token_too_broad',
      message: "A classic token's repo scope reaches every repository you can. Create a fine-grained token limited to Acme/site only.",
    },
    "A classic token's repo scope reaches every repository you can. Create a fine-grained token limited to Acme/site only.",
  ],
  [
    'token_missing_permission',
    400,
    { error: 'token_missing_permission', message: 'This token lacks Issues: write on Acme/site.', permission: 'issues:write' },
    'This token lacks Issues: write on Acme/site.',
  ],
  ['a shared owner project (404)', 404, { error: 'not_a_tenant_project' }, "This project's repository is set by the Horizon owner, not here."],
])('metric 2: %s shows its refusal and empties the token field', async (_name, status, body, text) => {
  stubFetch(status, body)
  render(<Harness />)
  submit()
  const alert = await screen.findByRole('alert')
  expect(alert.querySelector('strong').textContent).toBe(text)
  expect(alert.textContent).toContain('Nothing was saved.')
  expect(screen.getByLabelText('Token').value).toBe('')
  expect(screen.getByLabelText('Repository').value).toBe('Acme/site')
  expect(screen.getByRole('button', { name: 'Connect repository' }).disabled).toBe(false)
})

test('metric 3: after a successful save the token is in no DOM, console output or browser storage', async () => {
  stubFetch(200, SUCCESS)
  render(<Harness />)
  submit()
  await screen.findByRole('heading', { name: 'Repository connected' })

  expect(document.body.innerHTML).not.toContain(TOKEN)
  expect(consoleText()).not.toContain(TOKEN)
  const stored = [localStorage, sessionStorage].flatMap((s) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`)).join('\n')
  expect(stored).not.toContain(TOKEN)
  expect(document.cookie).not.toContain(TOKEN)
  expect(window.location.href).not.toContain(TOKEN)
})

test('guardrail 3: a request that never gets an answer empties the token field and says so, without logging the token', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }),
  )
  render(<Harness />)
  submit()
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toMatch(/Horizon could not be reached/)
  expect(screen.getByLabelText('Token').value).toBe('')
  expect(document.body.innerHTML).not.toContain(TOKEN)
  expect(consoleText()).not.toContain(TOKEN)
})

test('the token field is empty while the request is in flight, and one click sends one request', async () => {
  let answer
  const fetch = vi.fn(() => new Promise((resolve) => (answer = resolve)))
  vi.stubGlobal('fetch', fetch)
  render(<Harness />)
  submit()
  expect(screen.getByLabelText('Token').value).toBe('')
  const button = screen.getByRole('button', { name: 'Connecting…' })
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  answer({ ok: true, status: 200, json: async () => SUCCESS })
  expect(await screen.findByRole('heading', { name: 'Repository connected' })).toBeTruthy()
})

test('guardrail 4: a refusal message with markup renders as plain text', async () => {
  stubFetch(400, { error: 'token_rejected', message: '<b>x</b>' })
  render(<Harness />)
  submit()
  const alert = await screen.findByRole('alert')
  expect(alert.querySelector('strong').textContent).toBe('<b>x</b>')
  expect(alert.querySelector('b')).toBeNull()
})

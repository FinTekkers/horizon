// HZ-661: the "Set up your first project" screen. Wired to the real
// serverApi.createProject with fetch stubbed, so the test sees every request
// the screen makes: one POST /api/projects, and no owner route, repo connect
// or GitHub call.

import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import FirstProjectScreen from './FirstProjectScreen'
import { API_BASE, createProject, revealFirstGatePin } from '../api/serverApi'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubFetch(status, body) {
  const fetch = vi.fn(async () => ({ ok: status < 300, status, json: async () => body }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function submit(name) {
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
}

test('Create project sends exactly one request, POST /api/projects with the trimmed name', async () => {
  const fetch = stubFetch(200, { ok: true, id: 7, name: 'Acme', isolation: 'tenant' })
  render(<FirstProjectScreen onCreate={createProject} />)
  expect(screen.getByRole('heading', { name: 'Set up your first project' })).toBeTruthy()

  submit('  Acme  ')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Creating…' }).disabled).toBe(true))
  expect(fetch).toHaveBeenCalledTimes(1)
  const [url, opts] = fetch.mock.calls[0]
  expect(url).toBe(`${API_BASE}/projects`)
  expect(opts.method).toBe('POST')
  expect(JSON.parse(opts.body)).toEqual({ name: 'Acme' })
})

test("the server's 409 is shown inline and the form can be sent again", async () => {
  stubFetch(409, { error: 'A project with that name already exists' })
  render(<FirstProjectScreen onCreate={createProject} />)
  submit('Acme')
  expect((await screen.findByRole('alert')).textContent).toBe('A project with that name already exists')
  expect(screen.getByRole('button', { name: 'Create project' }).disabled).toBe(false)
})

test('a name under 2 characters sends nothing', () => {
  const fetch = stubFetch(200, {})
  render(<FirstProjectScreen onCreate={createProject} />)
  submit(' a ')
  expect(screen.getByRole('alert').textContent).toMatch(/2–80 characters/)
  expect(fetch).not.toHaveBeenCalled()
})

// ---- HZ-773: a fresh sign-up's gate PIN, shown once ----
// Wired to the real serverApi.revealFirstGatePin, so each case sees the exact
// requests: POST /api/auth/gate-pin/first, then POST /api/projects.

// Answers the reveal with `reveal` ({ status, body } or an Error to throw),
// and POST /api/projects with 200.
function stubRevealFetch(reveal) {
  const fetch = vi.fn(async (url) => {
    if (String(url).endsWith('/auth/gate-pin/first')) {
      if (reveal instanceof Error) throw reveal
      return { ok: reveal.status < 300, status: reveal.status, json: async () => reveal.body }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, id: 7, name: 'Acme', isolation: 'tenant' }) }
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const revealCalls = (fetch) => fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/gate-pin/first'))
const createButton = () => screen.getByRole('button', { name: 'Create project' })

test('no PIN panel unless the PIN is pending, and then Create waits for the PIN to be shown and saved', async () => {
  stubRevealFetch({ status: 200, body: { ok: true, pin: '482913' } })
  const { unmount } = render(<FirstProjectScreen onCreate={createProject} onRevealPin={revealFirstGatePin} />)
  expect(screen.queryByRole('region', { name: 'Your gate PIN' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Show my PIN' })).toBeNull()
  expect(createButton().disabled).toBe(false)
  unmount()

  const fetch = stubRevealFetch({ status: 200, body: { ok: true, pin: '482913' } })
  render(<FirstProjectScreen onCreate={createProject} pinPending onRevealPin={revealFirstGatePin} />)
  expect(screen.getByRole('region', { name: 'Your gate PIN' })).toBeTruthy()
  expect(createButton().disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Acme' } })
  fireEvent.click(createButton())
  expect(fetch).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Show my PIN' }))
  expect((await screen.findByLabelText('Gate PIN')).value).toBe('482913')
  expect(screen.getByRole('status').textContent).toMatch(/Save this now/)
  const [url, opts] = revealCalls(fetch)[0]
  expect(url).toBe(`${API_BASE}/auth/gate-pin/first`)
  expect(opts.method).toBe('POST')
  expect(opts.headers['x-horizon-csrf']).toBe('1')
  expect(createButton().disabled).toBe(true)
  fireEvent.click(screen.getByLabelText('I have saved my PIN'))
  expect(createButton().disabled).toBe(false)
  fireEvent.click(createButton())
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  expect(fetch.mock.calls[1][0]).toBe(`${API_BASE}/projects`)
  // The PIN is kept nowhere but the screen.
  for (const storage of [localStorage, sessionStorage]) {
    expect(Object.keys(storage).map((k) => storage.getItem(k)).join('\n')).not.toContain('482913')
  }
})

test('a double click on Show my PIN sends one request and shows the PIN, never a 409', async () => {
  let release
  const fetch = vi.fn(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, pin: '051177' }) })
      }),
  )
  vi.stubGlobal('fetch', fetch)
  render(<FirstProjectScreen onCreate={createProject} pinPending onRevealPin={revealFirstGatePin} />)
  const show = screen.getByRole('button', { name: 'Show my PIN' })
  fireEvent.click(show)
  fireEvent.click(show)
  release()
  expect((await screen.findByLabelText('Gate PIN')).value).toBe('051177')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText(/already shown/)).toBeNull()
})

test('a failed reveal shows an error, keeps Create disabled, and can be tried again', async () => {
  for (const failure of [{ status: 500, body: { error: 'internal' } }, new TypeError('Failed to fetch')]) {
    const fetch = stubRevealFetch(failure)
    render(<FirstProjectScreen onCreate={createProject} pinPending onRevealPin={revealFirstGatePin} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show my PIN' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not show your PIN. Try again.')
    expect(createButton().disabled).toBe(true)
    expect(screen.queryByLabelText('Gate PIN')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show my PIN' }))
    await waitFor(() => expect(revealCalls(fetch)).toHaveLength(2))
    cleanup()
  }
})

test('a 409 (shown in another tab) points to Admin regenerate and never shows an empty PIN', async () => {
  stubRevealFetch({ status: 409, body: { error: 'pin_already_shown' } })
  render(<FirstProjectScreen onCreate={createProject} pinPending onRevealPin={revealFirstGatePin} />)
  fireEvent.click(screen.getByRole('button', { name: 'Show my PIN' }))
  const status = await screen.findByRole('status')
  expect(status.textContent).toMatch(/already shown/)
  expect(status.textContent).toMatch(/Admin → Your PIN and API tokens/)
  expect(screen.queryByLabelText('Gate PIN')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Show my PIN' })).toBeNull()
  expect(createButton().disabled).toBe(false)
})

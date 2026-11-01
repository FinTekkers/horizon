// HZ-661: the "Set up your first project" screen. Wired to the real
// serverApi.createProject with fetch stubbed, so the test sees every request
// the screen makes: one POST /api/projects, and no owner route, repo connect
// or GitHub call.

import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import FirstProjectScreen from './FirstProjectScreen'
import { API_BASE, createProject } from '../api/serverApi'

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

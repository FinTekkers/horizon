// HO-879: Admin's backend picker and the repo link. The connect form's picker
// starts on github and its pick reaches addRepoToProject; a repo's picker is
// read-only once the repo has items; and the repo link is the server's `url`
// for the repo's backend, never one built here. The URLs below stand in for
// what GET /api/projects sends (server/test/repo-links.test.mjs pins
// the server's own strings).

import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GITHUB_WEB } from '../../../../server/src/links.js'

vi.mock('../../api', () => ({
  createProject: vi.fn(),
  addRepoToProject: vi.fn(async () => ({ ok: true })),
  disconnectRepo: vi.fn(),
  fixRepoWebhook: vi.fn(),
}))

import * as api from '../../api'
import { AddRepoForm, RepoRow } from './ProjectsSection'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const PROJECT = { id: 7, name: 'Acme', repos: [] }
const SL_URL = 'https://sl.example.test/repos/acme/sl-app'
const repoConn = (fields) => ({ repo: 'acme/web', prefix: 'WE', defaultBranch: 'main', backend: 'github', url: `${GITHUB_WEB}/acme/web`, itemCount: 0, ...fields })
const renderRow = (fields) => render(<RepoRow projectId={7} repoConn={repoConn(fields)} syncRepos={[]} />)
const rowPicker = (repo = 'acme/web') => screen.getByRole('combobox', { name: `Backend for ${repo}` })

// ---- metric 1: the connect form ----

test('metric 1: the connect form’s Backend picker shows github with no user action', () => {
  render(<AddRepoForm project={PROJECT} />)
  const picker = screen.getByLabelText('Backend')
  expect(picker.value).toBe('github')
  expect([...picker.options].map((o) => o.value)).toEqual(['github', 'sl'])
})

test('metric 1: choosing sl and submitting calls addRepoToProject with sl', async () => {
  render(<AddRepoForm project={PROJECT} />)
  fireEvent.change(screen.getByLabelText('Add a repo to Acme'), { target: { value: ' acme/sl-app ' } })
  fireEvent.change(screen.getByLabelText('Backend'), { target: { value: 'sl' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(api.addRepoToProject).toHaveBeenCalledTimes(1))
  expect(api.addRepoToProject).toHaveBeenCalledWith(7, 'acme/sl-app', 'sl')
})

test('metric 1: submitting without touching the picker connects as github', async () => {
  render(<AddRepoForm project={PROJECT} />)
  fireEvent.change(screen.getByLabelText('Add a repo to Acme'), { target: { value: 'acme/web' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(api.addRepoToProject).toHaveBeenCalledWith(7, 'acme/web', 'github'))
})

test('the server’s refusal of an sl connect is shown as its own message', async () => {
  api.addRepoToProject.mockRejectedValueOnce(new Error('Connecting an sl repository is not supported yet'))
  render(<AddRepoForm project={PROJECT} />)
  fireEvent.change(screen.getByLabelText('Add a repo to Acme'), { target: { value: 'acme/sl-app' } })
  fireEvent.change(screen.getByLabelText('Backend'), { target: { value: 'sl' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  expect(await screen.findByText('Connecting an sl repository is not supported yet')).toBeTruthy()
})

// ---- metric 3: read-only once the repo has items ----

test('metric 3: a repo’s picker is disabled with 1 item and enabled with 0', () => {
  renderRow({ itemCount: 1 })
  expect(rowPicker().disabled).toBe(true)
  expect(rowPicker().value).toBe('github')
  cleanup()
  renderRow({ itemCount: 0 })
  expect(rowPicker().disabled).toBe(false)
})

test('metric 3: an sl repo with items shows sl, disabled', () => {
  renderRow({ repo: 'acme/sl-app', backend: 'sl', url: SL_URL, itemCount: 3 })
  expect(rowPicker('acme/sl-app').value).toBe('sl')
  expect(rowPicker('acme/sl-app').disabled).toBe(true)
})

test('with no items a different pick changes nothing in place: it says how to reconnect', () => {
  renderRow({ itemCount: 0 })
  fireEvent.change(rowPicker(), { target: { value: 'sl' } })
  expect(screen.getByText(/To use sl, disconnect acme\/web and connect it again with Backend: sl\. Nothing was changed\./)).toBeTruthy()
  expect(rowPicker().value).toBe('github')
  expect(api.addRepoToProject).not.toHaveBeenCalled()
  expect(api.disconnectRepo).not.toHaveBeenCalled()
})

// ---- metric 4: the repo link ----

test('metric 4: a github repo links to its GitHub page (host github.com, path /<repo>), as the server sends it', () => {
  renderRow({})
  const link = screen.getByRole('link', { name: 'acme/web' })
  expect(link.getAttribute('href')).toBe(`${GITHUB_WEB}/acme/web`)
  const url = new URL(link.getAttribute('href'))
  expect([url.protocol, url.host, url.pathname]).toEqual(['https:', 'github.com', '/acme/web'])
  expect(link.getAttribute('target')).toBe('_blank')
})

test('metric 4: an sl repo links to the server’s url, with no github.com', () => {
  renderRow({ repo: 'acme/sl-app', backend: 'sl', url: SL_URL })
  const href = screen.getByRole('link', { name: 'acme/sl-app' }).getAttribute('href')
  expect(href).toBe(SL_URL)
  expect(href).not.toContain('github.com')
})

test('metric 4: a repo with no server url shows its name as plain text, not a link', () => {
  const { container } = renderRow({ repo: 'acme/sl-app', backend: 'sl', url: null })
  expect(screen.queryByRole('link', { name: 'acme/sl-app' })).toBeNull()
  expect(container.querySelector('.repo-row__name').textContent).toBe('acme/sl-app')
})

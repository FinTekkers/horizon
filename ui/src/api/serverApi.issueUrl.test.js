// HO-879: the real serverApi.issueUrl, getProjects and addRepoToProject — not
// a mock (every Board test mocks issueUrl). Links come from GET /api/projects,
// stubbed here with what the server's own builder (server/src/links.js)
// returns, so the GitHub strings are the server's, never typed in ui/src.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { GITHUB_TOKEN_PAGES, GITHUB_WEB, repoLinks } from '../../../server/src/links.js'

class MockEventSource {
  constructor() {
    this.listeners = {}
    MockEventSource.last = this
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn
  }
  dispatch(type, data) {
    this.listeners[type]({ data: JSON.stringify(data) })
  }
  close() {}
}

// sl links from test templates: no real sl or internal address anywhere.
const SL_TEMPLATES = { repo: 'https://sl.example.test/r/{repo}', issue: 'https://sl.example.test/r/{repo}/tasks/{n}' }
const GH = repoLinks('github', 'acme/web')
const SL = repoLinks('sl', 'acme/sl-app', SL_TEMPLATES)
const PROJECTS = {
  projects: [
    {
      id: 3,
      name: 'Acme',
      repos: [
        { repo: 'acme/web', prefix: 'WE', backend: 'github', url: GH.url, itemCount: 2 },
        { repo: 'acme/sl-app', prefix: 'SA', backend: 'sl', url: SL.url, itemCount: 0 },
      ],
      repoLinks: [
        { repo: 'acme/web', backend: 'github', ...GH },
        { repo: 'acme/sl-app', backend: 'sl', ...SL },
        { repo: 'acme/old', backend: 'github', ...repoLinks('github', 'acme/old') },
      ],
      tokenPages: { ...GITHUB_TOKEN_PAGES },
    },
  ],
}

let fetchMock
beforeEach(() => {
  vi.stubGlobal('EventSource', MockEventSource)
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => PROJECTS }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

const projectsCalls = (serverApi) => fetchMock.mock.calls.filter(([url, init]) => url === `${serverApi.API_BASE}/projects` && !init)

test('metric 4: a github item links to its GitHub issue page (host github.com, path /<repo>/issues/<n>), exactly as before', async () => {
  const serverApi = await import('./serverApi')
  const item = { repo: 'acme/web', issue: 7 }
  expect(serverApi.issueUrl(item)).toBeNull() // until the links load
  await vi.waitFor(() => expect(serverApi.issueUrl(item)).toBe(`${GITHUB_WEB}/acme/web/issues/7`))
  const url = new URL(serverApi.issueUrl(item))
  expect([url.protocol, url.host, url.pathname]).toEqual(['https:', 'github.com', '/acme/web/issues/7'])
  expect(projectsCalls(serverApi)).toHaveLength(1)
})

test('metric 4: an sl item links to the server-supplied URL, with no github.com', async () => {
  const serverApi = await import('./serverApi')
  const item = { repo: 'acme/sl-app', issue: 12 }
  serverApi.issueUrl(item)
  await vi.waitFor(() => expect(serverApi.issueUrl(item)).toBe('https://sl.example.test/r/acme/sl-app/tasks/12'))
  expect(serverApi.issueUrl(item)).not.toContain('github.com')
})

test('a disconnected repo’s item keeps its link; an item with no repo and no board repo link gets null', async () => {
  const serverApi = await import('./serverApi')
  serverApi.issueUrl({ repo: 'acme/old', issue: 3 })
  await vi.waitFor(() => expect(serverApi.issueUrl({ repo: 'acme/old', issue: 3 })).toBe(`${GITHUB_WEB}/acme/old/issues/3`))
  expect(serverApi.issueUrl({ issue: 9 })).toBeNull()
})

test('an sl repo with no issue template on the host gets no item link, never a guessed one', async () => {
  const bare = repoLinks('sl', 'acme/bare', { repo: null, issue: null })
  expect(bare).toEqual({ url: null, issueUrlTemplate: null })
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ projects: [{ id: 3, repos: [], repoLinks: [{ repo: 'acme/bare', backend: 'sl', ...bare }] }] }) })
  const serverApi = await import('./serverApi')
  serverApi.issueUrl({ repo: 'acme/bare', issue: 1 })
  await vi.waitFor(() => expect(projectsCalls(serverApi)).toHaveLength(1))
  await Promise.resolve()
  expect(serverApi.issueUrl({ repo: 'acme/bare', issue: 1 })).toBeNull()
})

test('getProjects merges each repo’s backend, url and itemCount, and the project’s tokenPages, into the board’s projects', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  MockEventSource.last.dispatch('snapshot', { items: [], projects: [{ id: 3, name: 'Acme', repos: [{ repo: 'acme/web', prefix: 'WE' }] }], activeProjectId: 3 })
  expect(serverApi.getProjects()[0].repos[0]).toEqual({ repo: 'acme/web', prefix: 'WE' })
  await vi.waitFor(() => expect(serverApi.getProjects()[0].repos[0]).toEqual({ repo: 'acme/web', prefix: 'WE', backend: 'github', url: GH.url, itemCount: 2 }))
  expect(serverApi.getProjects()[0].tokenPages).toEqual(GITHUB_TOKEN_PAGES)
  // The same array until something changes.
  expect(serverApi.getProjects()).toBe(serverApi.getProjects())
  expect(projectsCalls(serverApi)).toHaveLength(1)
})

test('metric 1: the connect POST body carries "backend":"sl", and "github" when none is chosen', async () => {
  const serverApi = await import('./serverApi')
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
  await serverApi.addRepoToProject(7, 'acme/sl-app', 'sl')
  await serverApi.addRepoToProject(7, 'acme/web')
  const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(posts.map(([url]) => url)).toEqual([`${serverApi.API_BASE}/projects/7/repos`, `${serverApi.API_BASE}/projects/7/repos`])
  expect(posts[0][1].body).toBe('{"repo":"acme/sl-app","backend":"sl"}')
  expect(posts[1][1].body).toBe('{"repo":"acme/web","backend":"github"}')
})

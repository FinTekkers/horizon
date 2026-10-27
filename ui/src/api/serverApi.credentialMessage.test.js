// HZ-542 metric 4: a project definitions save refused for a credential says
// exactly what a rules save and an agent definitions save say — all three go
// through serverApi.credentialMessage. The server's 400 body is the same for
// all three (server/test/project-definitions.test.mjs); this pins the text.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const REFUSAL = { error: 'credential_pattern', matches: ['GitHub token'] }
const EXPECTED = 'Looks like a credential — move it to an $ENV_VAR reference (GitHub token)'

let fetchMock

beforeEach(() => {
  localStorage.setItem('horizon_gate_pin', 'test-pin')
  fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve(REFUSAL) }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  vi.resetModules()
})

test('saveProjectDefinition, saveDefinition and saveRule refuse a credential with the same text', async () => {
  const serverApi = await import('./serverApi')
  expect(serverApi.credentialMessage(['GitHub token'])).toBe(EXPECTED)

  const errors = await Promise.all([
    serverApi.saveProjectDefinition('acme', 'personas.json', { personas: [] }).catch((err) => err.message),
    serverApi.saveDefinition('project', 'acme', 'text').catch((err) => err.message),
    serverApi.saveRule('project', 'acme', 'text', 'test-pin').catch((err) => err.message),
  ])
  expect(errors).toEqual([EXPECTED, EXPECTED, EXPECTED])

  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toMatch(/\/api\/projects\/acme\/definitions\/personas\.json$/)
  expect(init.method).toBe('PUT')
  expect(init.headers['x-human-key']).toBe('test-pin')
  expect(JSON.parse(init.body)).toEqual({ content: { personas: [] } })
})

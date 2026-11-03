// HZ-703: the connect card's pure parts. The chip-drift case reads the
// server's REQUIRED_PERMISSIONS as text: importing server/src/tokenCheck.js
// would load the server's database through ./github.js.

import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TOKEN_PAGE, TOKEN_PERMISSIONS, needsRepo, refusalText, tokenPageUrl } from './connectRepo'

const TOKEN_CHECK = join(dirname(fileURLToPath(import.meta.url)), '../../../server/src/tokenCheck.js')

function serverPermissions() {
  const src = readFileSync(TOKEN_CHECK, 'utf8')
  const start = src.indexOf('export const REQUIRED_PERMISSIONS')
  const block = src.slice(start, src.indexOf('])', start))
  return [...block.matchAll(/permission:\s*'([^']+)'/g)].map((m) => m[1])
}

test('every permission the server checks a token for has a chip the token link pre-fills', () => {
  const required = serverPermissions()
  expect(required.length).toBe(10)
  const covered = new Set(TOKEN_PERMISSIONS.flatMap((p) => p.covers))
  expect(required.filter((permission) => !covered.has(permission))).toEqual([])
  // A write permission is pre-filled as write, so it grants the read too.
  for (const p of TOKEN_PERMISSIONS) {
    if (p.covers.some((c) => c.endsWith(':write'))) expect(p.level).toBe('write')
  }
})

test("the token link is GitHub's fine-grained token page with the owner and every permission pre-filled", () => {
  const url = new URL(tokenPageUrl('  Acme/site '))
  expect(`${url.origin}${url.pathname}`).toBe(TOKEN_PAGE)
  expect(TOKEN_PAGE).toBe('https://github.com/settings/personal-access-tokens/new')
  expect(url.searchParams.get('target_name')).toBe('Acme')
  expect(url.searchParams.get('name')).toBe('Horizon')
  expect(Object.fromEntries([...url.searchParams].filter(([k]) => !['name', 'description', 'target_name'].includes(k)))).toEqual({
    contents: 'write',
    issues: 'write',
    pull_requests: 'write',
    repository_hooks: 'write',
    actions: 'read',
    metadata: 'read',
  })
  expect(new URL(tokenPageUrl('https://github.com/Acme/site')).searchParams.get('target_name')).toBe('Acme')
  expect(new URL(tokenPageUrl('')).searchParams.has('target_name')).toBe(false)
})

test("a refusal shows the server's message as is, else the UI's line for its code", () => {
  expect(refusalText({ code: 'token_too_broad', serverMessage: 'This token can reach A/b.' }).text).toBe('This token can reach A/b.')
  expect(refusalText({ code: 'token_too_broad', serverMessage: 'x' }).hint).toMatch(/Only select repositories/)
  expect(refusalText(Object.assign(new Error('network'))).text).toMatch(/could not be reached/)
  expect(refusalText({ code: 'not_a_tenant_project', message: 'not_a_tenant_project', serverMessage: null }).text).toMatch(/Horizon owner/)
  // A bad repo's 400 carries its sentence as `error`, which is the Error's message.
  const bad = Object.assign(new Error('Repository must be owner/name or a github.com URL'), { code: 'Repository must be owner/name or a github.com URL' })
  expect(refusalText(bad)).toEqual({ text: 'Repository must be owner/name or a github.com URL', hint: 'Nothing was saved.' })
  // A code that names an Object.prototype key is not a known code.
  expect(refusalText({ code: 'constructor', message: 'constructor' }).text).toBe('constructor')
})

test("needsRepo: a member's project with no repository and nothing on its board; never the owner", () => {
  const project = { id: 7, name: 'Acme', enabled: true, repos: [] }
  expect(needsRepo(project, false)).toBe(true)
  expect(needsRepo(project, true)).toBe(false)
  expect(needsRepo(null, false)).toBe(false)
  expect(needsRepo({ ...project, repos: [{ repo: 'Acme/site', prefix: 'AC' }] }, false)).toBe(false)
  expect(needsRepo(project, false, [{ id: 'X-1', project_id: 7 }])).toBe(false)
  expect(needsRepo(project, false, [{ id: 'X-1', project_id: 8 }])).toBe(true)
})

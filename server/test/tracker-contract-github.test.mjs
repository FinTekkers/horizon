// HO-871 metric 4: the shared Tracker port contract
// (test/contracts/tracker.contract.mjs) runs against the GitHub adapter
// forRepo() hands out, and passes. Plus the pure re-export guardrail: every
// port method is github.js's own function object.
//
// No live GitHub call and no real token: the database is a fresh temp file (so
// no stored github_token), GITHUB_TOKEN is a fake, and globalThis.fetch is a
// stub that answers only the requests a case primed, refuses anything else,
// and checks every request carries the fake token.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runTrackerContract, TRACKER_METHODS } from './contracts/tracker.contract.mjs'

const FAKE_TOKEN = 'contract-fake-token'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-tracker-contract-')), 'test.db')
process.env.GITHUB_TOKEN = FAKE_TOKEN
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const github = await import('../src/github.js')
const store = await import('../src/store.js')
const settings = await import('../src/settings.js')
const { forRepo } = await import('../src/backends/index.js')

store.purgeDemoItems()

const REPO = 'acme/contract'
const tracker = forRepo(REPO).tracker

test('the contract run reads no real token: the only token is the fake one', () => {
  assert.equal(settings.getSetting('github_token'), null)
  assert.equal(settings.getToken(), FAKE_TOKEN)
})

test('pure re-export: every port method is github.js’s own function', () => {
  for (const method of TRACKER_METHODS) {
    assert.equal(typeof github[method], 'function', `github.js exports ${method}`)
    assert.equal(tracker[method], github[method], `tracker.${method} is github.${method}`)
  }
})

test('ingestIssue is a thin wrapper over store.upsertFromGithub, with no logic of its own', () => {
  const body = github.ingestIssue.toString().replace(/^[^{]*\{|\}\s*$/g, '').trim()
  assert.equal(body, 'return store.upsertFromGithub(ghIssue, repoFullName)')
  // And it behaves as the store function does, result included.
  const projectId = store.createProject('Contract ingest').id
  const added = store.addRepoToProject(projectId, 'acme/contract-ingest')
  assert.equal(added.ok, true)
  const issue = { number: 77, title: 'Ingested', body: '## Outcome\nIt syncs.', labels: [], state: 'open' }
  assert.equal(tracker.ingestIssue(issue, 'acme/contract-ingest'), true)
  assert.equal(store.getItem(`${added.prefix}-77`)?.title, 'Ingested')
  assert.equal(tracker.ingestIssue(issue, 'acme/contract-ingest'), store.upsertFromGithub(issue, 'acme/contract-ingest'))
})

const json = (status, value, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })

function makeHarness() {
  const realFetch = globalThis.fetch
  const problems = []
  const state = { created: null, issues: null, closeStatus: 200 }
  const issuesPath = `/repos/${REPO}/issues`
  globalThis.fetch = async (input, opts = {}) => {
    const url = new URL(String(input))
    const method = (opts.method || 'GET').toUpperCase()
    const auth = new Headers(opts.headers || {}).get('authorization')
    if (auth !== `Bearer ${FAKE_TOKEN}`) problems.push(`${method} ${url.pathname}: Authorization was ${auth === null ? 'missing' : 'not the fake token'}`)
    if (url.origin !== 'https://api.github.com') {
      problems.push(`${method} ${url.href}: not GitHub's API`)
      throw new Error('unprimed request')
    }
    if (method === 'POST' && url.pathname === `/repos/${REPO}/labels`) return json(201, {})
    if (method === 'POST' && url.pathname === issuesPath && state.created) return json(201, state.created)
    if (method === 'GET' && url.pathname === issuesPath && state.issues) return json(200, state.issues, { etag: '"contract"' })
    if (method === 'POST' && url.pathname === `${issuesPath}/${item.issue}/comments`) return json(201, {})
    if (method === 'PATCH' && url.pathname === `${issuesPath}/${item.issue}`) return json(state.closeStatus, {})
    problems.push(`${method} ${url.pathname}: unprimed`)
    throw new Error(`unprimed request: ${method} ${url.pathname}`)
  }
  const item = { id: 'CT-12', repo: REPO, issue: 12, pr: null, release_tag: null, metric: 'One line.' }
  return {
    tracker,
    repo: REPO,
    item,
    primeCreate: (issue) => (state.created = issue),
    primeIssues: (list) => (state.issues = list),
    primeCloseFailure: () => (state.closeStatus = 500),
    violations: () => problems,
    restore: () => (globalThis.fetch = realFetch),
  }
}

runTrackerContract('github', makeHarness)

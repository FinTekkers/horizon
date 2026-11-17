// HO-872 metric 5: the shared VCS port contract
// (test/contracts/vcs.contract.mjs) runs against the GitHub adapter forRepo()
// hands out, and passes. Plus the pure re-export guardrail: every port method
// is github.js's own function object, so vcs.land is github.js's land.
//
// No live GitHub call and no real token: the database is a fresh temp file,
// GITHUB_TOKEN is a fake, and globalThis.fetch is a stub that answers only the
// requests a case primed, refuses anything else, and checks every request
// carries the fake token.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runVcsContract, VCS_METHODS } from './contracts/vcs.contract.mjs'

const FAKE_TOKEN = 'vcs-contract-fake-token'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-vcs-contract-')), 'test.db')
process.env.GITHUB_TOKEN = FAKE_TOKEN
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const github = await import('../src/github.js')
const store = await import('../src/store.js')
const { forRepo } = await import('../src/backends/index.js')

store.purgeDemoItems()

const REPO = 'acme/vcs-contract'
const vcs = forRepo(REPO).vcs

test('pure re-export: every VCS port method is github.js’s own function', () => {
  for (const method of VCS_METHODS) {
    assert.equal(typeof github[method], 'function', `github.js exports ${method}`)
    assert.equal(vcs[method], github[method], `vcs.${method} is github.${method}`)
  }
})

test('GitHub’s land is mergePr unchanged and resolves { hash: null }', () => {
  const body = github.land.toString().replace(/^[^{]*\{|\}\s*$/g, '').trim()
  assert.equal(body, 'await mergePr(item, opts)\n  return { hash: null }')
})

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function makeHarness() {
  const realFetch = globalThis.fetch
  const problems = []
  const state = { branches: {}, ancestor: null, landStatus: 200, landCalls: 0 }
  const item = { id: 'VC-1', repo: REPO, issue: 1, pr: 41 }
  globalThis.fetch = async (input, opts = {}) => {
    const url = new URL(String(input))
    const method = (opts.method || 'GET').toUpperCase()
    const auth = new Headers(opts.headers || {}).get('authorization')
    if (auth !== `Bearer ${FAKE_TOKEN}`) problems.push(`${method} ${url.pathname}: Authorization was ${auth === null ? 'missing' : 'not the fake token'}`)
    if (url.origin !== 'https://api.github.com') {
      problems.push(`${method} ${url.href}: not GitHub's API`)
      throw new Error('unprimed request')
    }
    const path = url.pathname
    if (method === 'PUT' && path === `/repos/${REPO}/pulls/${item.pr}/merge`) {
      state.landCalls++
      return json(state.landStatus, state.landStatus === 200 ? { merged: true, sha: 'e'.repeat(40) } : { message: 'refused' })
    }
    // The work branch's cleanup after a merge, and the screenshot ref land
    // looks for (none here, so nothing is promoted).
    if (method === 'DELETE' && path.startsWith(`/repos/${REPO}/git/refs/`)) return new Response(null, { status: 204 })
    if (method === 'GET' && path.startsWith(`/repos/${REPO}/git/ref/`)) {
      const ref = decodeURIComponent(path.slice(`/repos/${REPO}/git/ref/`.length))
      const branch = ref.startsWith('heads/') ? ref.slice('heads/'.length) : null
      if (branch && Object.hasOwn(state.branches, branch)) return json(200, { object: { sha: state.branches[branch] } })
      return json(404, {})
    }
    if (method === 'GET' && path.startsWith(`/repos/${REPO}/compare/`) && state.ancestor !== null) {
      return json(200, { status: state.ancestor ? 'ahead' : 'diverged' })
    }
    problems.push(`${method} ${path}: unprimed`)
    throw new Error(`unprimed request: ${method} ${path}`)
  }
  return {
    vcs,
    repo: REPO,
    item,
    sha: 'a'.repeat(40),
    otherSha: 'b'.repeat(40),
    primeBranch: (branch, sha) => (state.branches[branch] = sha),
    primeAncestor: (yes) => (state.ancestor = yes),
    primeLandRefused: () => (state.landStatus = 409),
    landCalls: () => state.landCalls,
    violations: () => problems,
    restore: () => (globalThis.fetch = realFetch),
  }
}

runVcsContract('github', makeHarness)

// HO-872 metric 5: the shared Review port contract
// (test/contracts/review.contract.mjs) runs against the GitHub adapter
// forRepo() hands out, and passes. Plus the pure re-export guardrail: every
// port method is github.js's own function object.
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

import { runReviewContract, REVIEW_METHODS } from './contracts/review.contract.mjs'

const FAKE_TOKEN = 'review-contract-fake-token'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-review-contract-')), 'test.db')
process.env.GITHUB_TOKEN = FAKE_TOKEN
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const github = await import('../src/github.js')
const store = await import('../src/store.js')
const { forRepo } = await import('../src/backends/index.js')

store.purgeDemoItems()

const REPO = 'acme/review-contract'
const review = forRepo(REPO).review

test('pure re-export: every Review port method is github.js’s own function', () => {
  for (const method of REVIEW_METHODS) {
    assert.equal(typeof github[method], 'function', `github.js exports ${method}`)
    assert.equal(review[method], github[method], `review.${method} is github.${method}`)
  }
})

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function makeHarness() {
  const realFetch = globalThis.fetch
  const problems = []
  const state = { pr: null }
  const item = { id: 'RC-1', repo: REPO, issue: 1, pr: 52 }
  globalThis.fetch = async (input, opts = {}) => {
    const url = new URL(String(input))
    const method = (opts.method || 'GET').toUpperCase()
    const auth = new Headers(opts.headers || {}).get('authorization')
    if (auth !== `Bearer ${FAKE_TOKEN}`) problems.push(`${method} ${url.pathname}: Authorization was ${auth === null ? 'missing' : 'not the fake token'}`)
    if (url.origin !== 'https://api.github.com') {
      problems.push(`${method} ${url.href}: not GitHub's API`)
      throw new Error('unprimed request')
    }
    if (method === 'GET' && url.pathname === `/repos/${REPO}/pulls/${item.pr}` && state.pr) {
      const p = state.pr
      return json(200, {
        number: item.pr,
        state: p.merged ? 'closed' : 'open',
        merged: p.merged,
        merge_commit_sha: p.mergeSha ?? null,
        mergeable: p.mergeable ?? null,
        head: { sha: p.headSha, ref: p.headRef ?? 'horizon/rc-1' },
        base: { ref: p.baseRef },
      })
    }
    problems.push(`${method} ${url.pathname}: unprimed`)
    throw new Error(`unprimed request: ${method} ${url.pathname}`)
  }
  return {
    review,
    repo: REPO,
    item,
    primePr: (pr) => (state.pr = pr),
    violations: () => problems,
    restore: () => (globalThis.fetch = realFetch),
  }
}

runReviewContract('github', makeHarness)

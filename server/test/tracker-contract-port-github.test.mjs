// HO-875 metric 3: the Tracker port cases HO-871's shared contract lacks
// (test/contracts/tracker-port.contract.mjs — comment, close, abandon, comment
// poll) run against the GitHub adapter forRepo() hands out, unchanged. The sl
// adapter runs the same cases in tracker-contract-sl.test.mjs.
//
// No live GitHub call and no real token: a fresh temp database, a fake
// GITHUB_TOKEN, and a fetch stub that answers only the item's issue routes and
// records what each one was sent.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runTrackerPortContract } from './contracts/tracker-port.contract.mjs'

const FAKE_TOKEN = 'port-contract-fake-token'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-tracker-port-github-')), 'test.db')
process.env.GITHUB_TOKEN = FAKE_TOKEN
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const store = await import('../src/store.js')
const { forRepo } = await import('../src/backends/index.js')

store.purgeDemoItems()

const REPO = 'acme/port-contract'
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function makeHarness() {
  const realFetch = globalThis.fetch
  const problems = []
  const comments = []
  const closes = []
  const item = { id: 'PT-12', repo: REPO, issue: 12, pr: 7, release_tag: null, metric: 'The port holds on GitHub.' }
  const issuePath = `/repos/${REPO}/issues/${item.issue}`
  globalThis.fetch = async (input, opts = {}) => {
    const url = new URL(String(input))
    const method = (opts.method || 'GET').toUpperCase()
    if (new Headers(opts.headers || {}).get('authorization') !== `Bearer ${FAKE_TOKEN}`) problems.push(`${method} ${url.pathname}: not the fake token`)
    if (url.origin !== 'https://api.github.com') {
      problems.push(`${method} ${url.href}: not GitHub's API`)
      throw new Error('unprimed request')
    }
    const body = opts.body ? JSON.parse(opts.body) : null
    if (method === 'POST' && url.pathname === `${issuePath}/comments`) {
      comments.push(body.body)
      return json(201, {})
    }
    if (method === 'PATCH' && url.pathname === issuePath && body.state === 'closed') {
      closes.push({ summary: comments.at(-1) ?? '', reason: body.state_reason })
      return json(200, {})
    }
    problems.push(`${method} ${url.pathname}: unprimed`)
    throw new Error(`unprimed request: ${method} ${url.pathname}`)
  }
  return {
    tracker: forRepo(REPO).tracker,
    repo: REPO,
    item,
    // A close posts its summary as a comment first; comments() is what was
    // posted on its own, so the close's summary comment is not counted twice.
    comments: () => comments.filter((c) => !closes.some((close) => close.summary === c)),
    closes: () => closes,
    violations: () => problems,
    restore: () => (globalThis.fetch = realFetch),
  }
}

runTrackerPortContract('github', makeHarness)

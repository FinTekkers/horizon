// HO-872: Accept lands through the backend's VCS port —
// forRepo(item.repo).vcs.land — and only inside the existing premerge claim.
//
// Driven through the real Fastify app with inject(), as premerge-gate.test.mjs
// is: GitHub is a fetch stub that records every call, and farm/premerge.py is
// replaced at its one seam, premerge.runner. The double-press and
// inside-the-claim cases swap in a fake `land` with setBackendForTest; the
// metric-3 case runs the real GitHub adapter against the fetch stub.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-accept-land-once-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'FARM_HOME', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT']) delete process.env[key]
process.env.PREMERGE_CHECK_TIMEOUT_MS = '90000'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX, stepKeyAt } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')
const accept = await import('../src/caretakerAccept.js')
const { setBackendForTest } = await import('../src/backends/index.js')
const { githubAdapters } = await import('../src/backends/github.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
await app.ready()
const { pin, cookie } = loginFixtureUser(auth, config)

const REPO = 'acme/land-once'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

let seq = 0
function acceptItem({ projectId = null } = {}) {
  const id = `T-LO-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    REPO,
    100 + seq,
    200 + seq,
    projectId,
  )
  return id
}

const row = (id) => db.prepare('SELECT cursor, merged_at, landed_hash, landed_at FROM work_item WHERE id = ?').get(id)

// ---- GitHub: a fetch stub that records every call ----

let gh
function resetGithub() {
  gh = { calls: [] }
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    gh.calls.push({ method, path: u.pathname })
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
    if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) {
      return json(200, { head: { sha: HEAD, ref: 'horizon/t-lo' }, base: { ref: 'main' } })
    }
    if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: BASE } })
    if (method === 'PUT' && u.pathname.endsWith('/merge')) return json(200, { merged: true, sha: 'e'.repeat(40) })
    return json(404, {})
  }
}
const mergeCalls = () => gh.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/merge'))

// ---- premerge.runner: green unless a case says otherwise ----

let runs
function stubRunner(outcome) {
  runs = []
  premerge.runner.spawn = async (args) => {
    runs.push(args)
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...outcome(args) }
  }
}
const cliResult = (args, body, code) => ({ code, stdout: JSON.stringify({ head_sha: args[4], base_sha: args[6], ...body }) + '\n' })
const greenRun = (args) => cliResult(args, { ok: true, merge_sha: 'd'.repeat(40), note: '1 repo check(s) passed' }, 0)
const redRun = (args) => cliResult(args, { ok: false, reason: 'checks_failed', failing_check: 'npm test', tail: 'x failed' }, 1)

// ---- a fake VCS port whose land records each call ----

// `land` resolves only when release() is called; started resolves as soon as
// it is entered, carrying the item's gateAction as the API showed it then.
function fakeLand() {
  const fake = { calls: [] }
  let signal
  fake.started = new Promise((resolve) => (signal = resolve))
  fake.done = new Promise((resolve) => (fake.release = resolve))
  fake.land = async (item, opts) => {
    const items = (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })).json()
    const view = (Array.isArray(items) ? items : items.items).find((i) => i.id === item.id)
    fake.calls.push({ id: item.id, opts, gateAction: view?.gateAction ?? null })
    signal()
    await fake.done
    return { hash: null }
  }
  setBackendForTest('github', { ...githubAdapters, vcs: Object.freeze({ ...githubAdapters.vcs, land: fake.land }) })
  return fake
}

beforeEach(() => {
  db.prepare('DELETE FROM gate_action').run()
  resetGithub()
  stubRunner(greenRun)
})

const approve = (id) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    payload: { action: 'approve', from: stepKeyAt(ACCEPT_GATE_INDEX) },
    headers: { cookie, 'x-human-key': pin },
  })

// ---- metric 2 + guardrail 1 ----

test('metric 2: a second Accept sent while the first is inside land gets 409 premerge; land is called exactly once', async (t) => {
  t.after(() => setBackendForTest('github', null))
  const fake = fakeLand()
  const id = acceptItem()
  const first = approve(id)
  await fake.started
  const second = await approve(id)
  assert.equal(second.statusCode, 409)
  assert.equal(second.json().premerge, true)
  fake.release()
  assert.equal((await first).statusCode, 200)
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].opts.sha, HEAD, 'land is pinned to the head the checks passed')
  assert.notEqual(row(id).merged_at, null)
  assert.equal(row(id).cursor, ACCEPT_GATE_INDEX + 1)
  assert.equal(mergeCalls().length, 0, 'the fake land replaced the GitHub merge')
})

test('guardrail 1: land runs while the item shows its premerge claim, after the checks ran', async (t) => {
  t.after(() => setBackendForTest('github', null))
  const fake = fakeLand()
  const id = acceptItem()
  const first = approve(id)
  await fake.started
  assert.equal(runs.length, 1, 'the pre-merge checks ran before land')
  assert.equal(fake.calls[0].gateAction?.kind, 'premerge')
  assert.equal(fake.calls[0].gateAction?.state, 'running')
  fake.release()
  assert.equal((await first).statusCode, 200)
})

test('guardrail 1: red pre-merge checks record zero land calls', async (t) => {
  t.after(() => setBackendForTest('github', null))
  stubRunner(redRun)
  const fake = fakeLand()
  fake.release()
  const id = acceptItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 502)
  assert.equal(res.json().premerge, true)
  assert.equal(fake.calls.length, 0)
  assert.equal(row(id).cursor, ACCEPT_GATE_INDEX)
  assert.equal(row(id).merged_at, null)
})

// ---- metric 3 ----

test('metric 3: through the real GitHub adapter, Accept PUTs the PR merge and the item keeps landed_hash NULL', async (t) => {
  t.after(() => setBackendForTest('github', null))
  setBackendForTest('github', null)
  const id = acceptItem()
  const pr = db.prepare('SELECT pr FROM work_item WHERE id = ?').get(id).pr
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(
    mergeCalls().map((c) => c.path),
    [`/repos/${REPO}/pulls/${pr}/merge`],
  )
  const after = row(id)
  assert.notEqual(after.merged_at, null)
  assert.equal(after.landed_hash, null)
  assert.equal(after.landed_at, null)
})

// ---- guardrail 2: the caretaker's Accept is gateActions.approve, nothing else ----

test('guardrail 2: a caretaker Accept reaches land once, through gateActions.approve, while the premerge claim is held', async (t) => {
  t.after(() => setBackendForTest('github', null))
  const fake = fakeLand()
  const projectId = Number(db.prepare("INSERT INTO project (name, enabled, autopilot) VALUES ('Land once', 1, 'on')").run().lastInsertRowid)
  const id = acceptItem({ projectId })
  db.prepare('UPDATE work_item SET cursor = ?, pr_mergeable = 1 WHERE id = ?').run(ACCEPT_GATE_INDEX - 1, id)
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, ?, 'review', 'done', 'review passed')").run(
    id,
    ACCEPT_GATE_INDEX - 1,
  )
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, id)

  const approvals = []
  const gateActions = {
    ...app.gateActions,
    approve: (...args) => {
      approvals.push(args)
      return app.gateActions.approve(...args)
    },
  }
  const counts = accept.actOnAcceptGate({ gateActions, actor: 'Caretaker', log: null, limit: 10 })
  assert.equal(counts.accepted, 1)
  await fake.started
  assert.deepEqual(approvals, [[id, ACCEPT_GATE_INDEX, '', 'Caretaker']])
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].gateAction?.kind, 'premerge')
  assert.equal(fake.calls[0].gateAction?.state, 'running')
  fake.release()
  for (let i = 0; i < 50 && row(id).cursor === ACCEPT_GATE_INDEX; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(row(id).cursor, ACCEPT_GATE_INDEX + 1)
  assert.equal(fake.calls.length, 1)
})

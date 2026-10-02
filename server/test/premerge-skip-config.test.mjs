// HZ-257 metric 4: a non-default PREMERGE_SKIP_MAX_AGE_HOURS is honoured at
// Accept. Its own file because config.js reads the variable once, at import.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-premerge-skip-config-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
delete process.env.PREMERGE_SKIP
process.env.PREMERGE_SKIP_MAX_AGE_HOURS = '2'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)

const REPO = 'acme/demo'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const HOUR = 60 * 60 * 1000

globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url)
  const method = options.method || 'GET'
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
  if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) return json(200, { head: { sha: HEAD, ref: 'horizon/t' }, base: { ref: 'main' } })
  if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: BASE } })
  if (method === 'GET' && u.pathname.includes('/compare/')) return json(200, { status: 'ahead' })
  if (method === 'PUT' && u.pathname.endsWith('/merge')) return json(200, { merged: true })
  return json(404, {})
}

let runs
beforeEach(() => {
  runs = 0
  premerge.runner.spawn = async (args) => {
    runs++
    return { code: 0, stdout: JSON.stringify({ ok: true, head_sha: args[4], base_sha: args[6], note: 'green' }) + '\n', stderr: '', timedOut: false }
  }
})

let seq = 0
function acceptItemWithPass(ageMs) {
  const id = `T-SKC-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    REPO,
    10 + seq,
    20 + seq,
  )
  store.recordCheckPass({ repo: REPO, itemId: id, sha: HEAD, finishedAt: new Date(Date.now() - ageMs).toISOString(), source: 'implement' })
  return id
}

const approve = (id) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve`, payload: {}, headers: { cookie, 'x-human-key': pin } })

test('PREMERGE_SKIP_MAX_AGE_HOURS=2 sets a 2h limit', () => {
  assert.equal(config.PREMERGE_SKIP_MAX_AGE_MS, 2 * HOUR)
})

test('with a 2h limit, a 3h-old pass is not used — pre-merge runs', async () => {
  const id = acceptItemWithPass(3 * HOUR)
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal(runs, 1)
})

test('with a 2h limit, a 1h-old pass is used — pre-merge is skipped', async () => {
  const id = acceptItemWithPass(1 * HOUR)
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal(runs, 0)
})

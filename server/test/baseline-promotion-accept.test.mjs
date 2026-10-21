// HZ-510: Accept the code promotes the screens approved at that gate (HZ-509's
// screenshot_approval rows) into e2e-baseline. Driven through the real Fastify
// app with inject(): the approve route records approvals, the gate approve
// merges. GitHub is helpers/fakeGit.mjs plus the PR and main-branch reads the
// pre-merge check makes; farm/premerge.py is replaced at premerge.runner.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { fakeGit } from './helpers/fakeGit.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-baseline-promotion-')), 'test.db')
process.env.GITHUB_TOKEN = 'test-token'
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
process.env.PREMERGE_CHECK_TIMEOUT_MS = '90000'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')
const screenshots = await import('../src/screenshots.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
const SESSION = { cookie, 'x-human-key': pin }

const REPO = 'acme/promote'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const SHOT = (name) => `e2e/__screenshots__/${name}.png`
const SHOTS = [
  { name: 'board', status: 'changed', diffRatio: 0.042, diff: null, error: null },
  { name: 'gates', status: 'new', diffRatio: null, diff: null, error: null },
]

premerge.runner.spawn = async (args) => ({
  code: 0,
  stdout: JSON.stringify({ head_sha: args[4], base_sha: args[6], ok: true, merge_sha: 'd'.repeat(40), note: 'passed' }) + '\n',
  stderr: '',
  timedOut: false,
})

let git, base, art, artRef
let seq = 0
function setup() {
  const id = `T-PROMO-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'Screens',
    'Medium',
    ACCEPT_GATE_INDEX,
    REPO,
    100 + seq,
    200 + seq,
  )
  git = fakeGit(REPO)
  base = { [SHOT('board')]: git.blob('board-base'), [SHOT('keep')]: git.blob('keep') }
  const head = git.commit(base)
  git.refs.set('heads/e2e-baseline', head)
  art = { [SHOT('board')]: git.blob('board-v1'), [SHOT('gates')]: git.blob('gates-v1') }
  art['e2e/__screenshots__/results.json'] = git.blob(JSON.stringify({ version: 1, baseline: head, shots: SHOTS }))
  artRef = `heads/e2e-artifacts/${id.toLowerCase()}`
  const commit = git.commit(art)
  git.refs.set(artRef, commit)
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url)
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
    if ((options.method || 'GET') === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) {
      return json(200, { head: { sha: HEAD, ref: `horizon/${id.toLowerCase()}` }, base: { ref: 'main' } })
    }
    if (u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: BASE } })
    return git.fetch(url, options)
  }
  return { id, item: store.getItem(id), commit }
}

beforeEach(() => db.prepare('DELETE FROM gate_action').run())

const accept = (id) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve`, payload: {}, headers: SESSION })
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((r) => r.text)

test('Accept promotes the screens approved at the gate, and only those (HZ-510)', async () => {
  const { id, item, commit } = setup()
  const approved = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/screenshots/approve`,
    payload: { commit, screens: ['board'] },
    headers: SESSION,
  })
  assert.equal(approved.statusCode, 200)
  assert.deepEqual([...(await screenshots.mergeApprovals(item))], ['board'])

  const res = await accept(id)
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(events(id).some((t) => t.startsWith('merged PR')))
  assert.deepEqual(git.filesAt('e2e-baseline'), { [SHOT('board')]: art[SHOT('board')], [SHOT('keep')]: base[SHOT('keep')] })
  assert.equal(git.refs.has(artRef), false)
})

test('when the approvals cannot be read, the merge still completes and the artifacts ref is kept (HZ-510)', async () => {
  const { id, item } = setup()
  git.fail['GET /git/trees'] = 500
  assert.equal(await screenshots.mergeApprovals(item), null)

  const before = git.refs.get('heads/e2e-baseline')
  const res = await accept(id)
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(events(id).some((t) => t.startsWith('merged PR')))
  assert.equal(git.refs.get('heads/e2e-baseline'), before)
  assert.equal(git.refs.has(artRef), true)
})

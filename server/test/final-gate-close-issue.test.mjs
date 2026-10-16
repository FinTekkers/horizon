// HZ-493: approving the final gate closes the GitHub issue for every kind, not
// only a Change. "Final" is the kind's own last step row in domain/steps.json —
// a Task's and a Plan's last gate is "Review & close", not the Change's
// "Review the work & close", and before this fix their issues stayed open, so
// the next sync saw an open issue on a closed item and restarted it at step 0.
//
// Driven end to end: the real approve route (stubbed GitHub fetch), then the
// real /api/webhooks/github route with an HMAC-signed "issues" payload — the
// same entry the live sync takes into store.upsertFromGithub.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-final-gate-close-')), 'test.db')
process.env.GITHUB_WEBHOOK_SECRET = 'final-gate-close-secret'
process.env.GITHUB_TOKEN = 'test-token'
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, endIndex, firstStepIndex } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { 'x-human-key': pin, ...opts.headers, cookie } })

const REPO = 'acme/final-gate-close'
const { id: projectId } = store.createProject('HZ-493 fixture project')
assert.ok(store.addRepoToProject(projectId, REPO).ok)

// One item per kind, parked at its kind's final gate with a linked issue.
const KINDS = ['change', 'task', 'plan']
const fixtures = KINDS.map((kind, i) => ({ kind, id: `FG-${kind.toUpperCase()}`, issue: 930 + i }))
for (const f of fixtures) {
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, repo, issue, project_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(f.id, `Final gate ${f.kind}`, 'Medium', endIndex(f.kind) - 1, REPO, f.issue, projectId, f.kind)
}

function stubGithub({ patchStatus = 200 } = {}) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    const status = opts.method === 'PATCH' ? patchStatus : 200
    return { ok: status < 400, status, json: async () => ({}), text: async () => '' }
  }
  return { calls, restore: () => (globalThis.fetch = realFetch) }
}

function issuesWebhook(f, state) {
  const body = JSON.stringify({
    action: state === 'closed' ? 'closed' : 'reopened',
    repository: { full_name: REPO },
    issue: { number: f.issue, title: `Final gate ${f.kind}`, body: '', state, labels: [] },
  })
  const sig = 'sha256=' + crypto.createHmac('sha256', 'final-gate-close-secret').update(body).digest('hex')
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-hub-signature-256': sig },
    payload: body,
  })
}

const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const eventTexts = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const approveFinal = (f) => inject({ method: 'POST', url: `/api/items/${f.id}/gates/${endIndex(f.kind) - 1}/approve`, payload: {} })

test('every kind ends on a gate row, so its last step is the issue-closing gate', () => {
  for (const kind of KINDS) {
    const last = STEPS[endIndex(kind) - 1]
    assert.equal(last.itemKind ?? 'change', kind)
    assert.equal(last.kind, 'gate', `${kind}'s last step must be a gate`)
  }
})

test('a Task final-gate approval whose issue close fails returns 502 and leaves the gate open', async () => {
  const f = { kind: 'task', id: 'FG-TASK-FAIL', issue: 940 }
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, repo, issue, project_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(f.id, 'Close fails', 'Medium', endIndex(f.kind) - 1, REPO, f.issue, projectId, f.kind)
  const gh = stubGithub({ patchStatus: 403 })
  try {
    const res = await approveFinal(f)
    assert.equal(res.statusCode, 502)
  } finally {
    gh.restore()
  }
  assert.equal(cursorOf(f.id), endIndex(f.kind) - 1)
  assert.ok(eventTexts(f.id).some((t) => t.startsWith(`could not close issue #${f.issue}`)))
})

for (const f of fixtures) {
  test(`approving a ${f.kind}'s final gate closes its issue, and the next sync leaves it closed`, async () => {
    const gh = stubGithub()
    try {
      const res = await approveFinal(f)
      assert.equal(res.statusCode, 200, res.body)
    } finally {
      gh.restore()
    }
    const patches = gh.calls.filter((c) => c.method === 'PATCH' && c.url.endsWith(`/repos/${REPO}/issues/${f.issue}`))
    assert.equal(patches.length, 1, 'expected one close PATCH')
    assert.deepEqual(patches[0].body, { state: 'closed', state_reason: 'completed' })
    assert.ok(eventTexts(f.id).includes(`closed issue #${f.issue} on GitHub with a summary`))
    assert.equal(cursorOf(f.id), endIndex(f.kind))

    // The issues.closed webhook that close triggers must not move the item.
    assert.equal((await issuesWebhook(f, 'closed')).statusCode, 204)
    assert.equal(cursorOf(f.id), endIndex(f.kind))
    assert.ok(!eventTexts(f.id).some((t) => t.startsWith('reopened issue')))
  })
}

test('a person reopening a really-closed issue on GitHub still restarts the item at its first step', async () => {
  const f = fixtures.at(-1) // the Plan
  assert.equal(cursorOf(f.id), endIndex(f.kind))
  assert.equal((await issuesWebhook(f, 'open')).statusCode, 204)
  assert.equal(cursorOf(f.id), firstStepIndex(f.kind))
  assert.ok(eventTexts(f.id).includes(`reopened issue #${f.issue}`))
  orchestrator.cancel(f.id, 'cancelled') // don't leave a mock run going
})

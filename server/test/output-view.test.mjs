// HTTP-contract tests for the standalone agent-output pages:
//   GET /api/items/:id/artifacts/:stepIndex       ("View full artifact")
//   GET /api/items/:id/steps/:stepIndex/output    (HZ-14, completed steps)
//   GET /api/runs/:runId/log/view                 (HZ-14, the active run's live tail)
// All three replace showing agent text inline in the tracker with a link
// that opens a standalone page — opened in a new tab, so the browser sends
// the session cookie automatically and no extra login prompt appears. These
// used to be unauthenticated, link-shareable pages; HZ-21 puts them behind
// the same session gate as the rest of the app, so most cases here log in a
// fixture user once up front, with an explicit 401-without-cookie case each.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-output-view-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie } })

db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-OUT', 'Has output', 'Medium', 12)").run()
db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, ended_at) VALUES ('T-OUT', 11, 1, 'Eng', 'done', '<script>alert(1)</script> plain output text', '2026-01-01 12:00:00')",
).run()
db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, ended_at) VALUES ('T-OUT', 10, 1, 'Eng', 'done', '# A plan\\n\\nSome **markdown**.', '2026-01-01 12:00:00')",
).run()

// HZ-46 fixtures: a step with a full attempt history (two real revisions plus
// a failed one in between that must never surface as a version), and a
// second item that shares the same step_index/attempt numbers so scoping can
// be asserted.
db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-VER', 'Has attempt history', 'Medium', 12)").run()
db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, started_at, ended_at) VALUES ('T-VER', 11, 1, 'Eng', 'done', 'Attempt one content', '2026-01-01 10:00:00', '2026-01-01 10:05:00')",
).run()
db.prepare(
  "INSERT INTO feedback (item_id, target, message, created_at) VALUES ('T-VER', 'Eng', 'please add tests', '2026-01-01 10:06:00')",
).run()
db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, started_at, ended_at) VALUES ('T-VER', 11, 2, 'Eng', 'done', 'Attempt two content', '2026-01-01 10:07:00', '2026-01-01 10:10:00')",
).run()
// A cancelled attempt (HZ-44: dies mid-flight) between the two real ones —
// carries FAILED-prefixed output and no artifact, must be invisible here.
db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, started_at, ended_at) VALUES ('T-VER', 11, 3, 'Eng', 'cancelled', 'FAILED: agent crashed', '2026-01-01 10:11:00', '2026-01-01 10:12:00')",
).run()

db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-VER2', 'Different item, same shape', 'Medium', 12)").run()
db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, started_at, ended_at) VALUES ('T-VER2', 11, 1, 'Eng', 'done', 'Item two attempt one content', '2026-01-01 10:00:00', '2026-01-01 10:05:00')",
).run()

// ---- /api/items/:id/artifacts/:stepIndex ----

test('a completed step with an artifact renders a 200 HTML page for a logged-in session', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-OUT/artifacts/10' })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.body, /T-OUT/)
  assert.match(res.body, /<strong>markdown<\/strong>/)
})

test('the artifact page 401s without a session cookie (HZ-21)', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/items/T-OUT/artifacts/10' })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('a step with no completed+artifact row 404s', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-OUT/artifacts/0' })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'no artifact for that step' })
})

test('an unknown item 404s for the artifact page too', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/NOPE-1/artifacts/10' })
  assert.equal(res.statusCode, 404)
})

// ---- /api/items/:id/artifacts/:stepIndex/:attempt (HZ-46: earlier attempts stay reachable) ----

test("requesting an earlier attempt returns that attempt's content, not the newest", async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-VER/artifacts/11/1' })
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /Attempt one content/)
  assert.ok(!res.body.includes('Attempt two content'), "must not include the newer attempt's content")
})

test('the bare (no-attempt) artifact URL still resolves to the latest attempt, unchanged', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-VER/artifacts/11' })
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /Attempt two content/)
  assert.ok(!res.body.includes('Attempt one content'))
})

test("cross-item scoping: an attempt number from the URL never returns another item's artifact", async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-VER2/artifacts/11/1' })
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /Item two attempt one content/)
  assert.ok(!res.body.includes('Attempt one content'), "must not fall through to another item's attempt 1")
})

test('a cancelled/FAILED attempt (HZ-44) is excluded: 404s directly and is absent from the version nav', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-VER/artifacts/11/3' })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'no artifact for that attempt' })

  const page = await inject({ method: 'GET', url: '/api/items/T-VER/artifacts/11/1' })
  assert.ok(!page.body.includes('attempt 3'), 'the cancelled attempt must not be listed as a version')
})

test('an out-of-range attempt number 404s with the same error shape', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-VER/artifacts/11/99' })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'no artifact for that attempt' })
})

test('a non-integer attempt is rejected at the schema layer', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-VER/artifacts/11/not-a-number' })
  assert.equal(res.statusCode, 400)
})

test('the specific-attempt page 401s without a session cookie (HZ-21)', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/items/T-VER/artifacts/11/1' })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('the page shows "attempt X of Y" labelled with the feedback that drove this revision, with a link back to the other version', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-VER/artifacts/11/2' })
  assert.match(res.body, /attempt 2 of 2/)
  assert.match(res.body, /please add tests/)
  assert.match(res.body, /href="\/api\/items\/T-VER\/artifacts\/11\/1"/)
})

test('the artifact page prints exactly one "attempt N" mention for its own attempt number, not a duplicate', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-VER/artifacts/11/1' })
  const matches = res.body.match(/attempt 1\b/g) || []
  assert.equal(matches.length, 1, `expected exactly one "attempt 1" mention, saw ${matches.length}`)
})

// ---- /api/items/:id/steps/:stepIndex/output ----

test('a completed step with output renders a 200 HTML page for a logged-in session', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-OUT/steps/11/output' })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.body, /T-OUT/)
})

test('the step output page 401s without a session cookie (HZ-21)', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/items/T-OUT/steps/11/output' })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('the step output page escapes the stored output instead of rendering it as HTML', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-OUT/steps/11/output' })
  assert.ok(!res.body.includes('<script>alert(1)</script>'), 'raw script tag must not appear unescaped')
  assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(res.body, /plain output text/)
})

test('a step with no completed+output row 404s', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/T-OUT/steps/0/output' })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'no output for that step' })
})

test('an unknown item 404s', async () => {
  const res = await inject({ method: 'GET', url: '/api/items/NOPE-1/steps/11/output' })
  assert.equal(res.statusCode, 404)
})

// ---- /api/runs/:runId/log/view ----

const runId = db.prepare("SELECT id FROM step_run WHERE item_id = 'T-OUT' AND step_index = 11").get().id

test('the live-tail page renders 200 HTML for a logged-in session, for a known run', async () => {
  const res = await inject({ method: 'GET', url: `/api/runs/${runId}/log/view` })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.body, /T-OUT/)
})

test('the live-tail page 401s without a session cookie (HZ-21)', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/log/view` })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('the live-tail page still renders 200 for an unknown run id (client script handles the 404 itself)', async () => {
  const res = await inject({ method: 'GET', url: '/api/runs/999999/log/view' })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
})

test('a non-integer run id is rejected at the schema layer', async () => {
  const res = await inject({ method: 'GET', url: '/api/runs/not-a-number/log/view' })
  assert.equal(res.statusCode, 400)
})

test('the page embeds a Reconnect control and a status region for the 3-minute timeout', async () => {
  const res = await inject({ method: 'GET', url: `/api/runs/${runId}/log/view` })
  assert.match(res.body, /id="reconnect"/)
  assert.match(res.body, /id="status"/)
  assert.match(res.body, /id="log"/)
})

test('the page fetches the run log relative to itself, starting at offset 0 on first read', async () => {
  const res = await inject({ method: 'GET', url: `/api/runs/${runId}/log/view` })
  // offset starts at 0 and is only ever appended to the query string once the
  // client script runs — the served markup itself carries no stale offset.
  assert.match(res.body, /var offset = 0/)
  assert.match(res.body, /'\.\.\/log\?offset='/)
})

// ---- shared stylesheet ----
// These pages link a stylesheet with a relative href (not an absolute one)
// because the app is reverse-proxied under a subpath in production
// (infra/host/nginx-site.conf) with no env var telling this server about it.
// If the relative "../" count in app.js's cssHrefFor() ever drifts from a
// route's real path depth, the link silently 404s in the browser instead of
// failing a request — so the resolution itself is asserted here, not just
// that a <link> tag exists.

test('GET /api/agent-pages.css serves the shared stylesheet with no session required', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/agent-pages.css' })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/css/)
  assert.match(res.body, /\.page/)
})

function stylesheetHref(html) {
  const match = html.match(/<link rel="stylesheet" href="([^"]+)">/)
  assert.ok(match, 'expected a <link rel="stylesheet"> tag')
  return match[1]
}

for (const origin of ['http://x', 'http://x/horizon']) {
  test(`the artifact page's stylesheet link resolves to the css route (origin ${origin})`, async () => {
    const res = await inject({ method: 'GET', url: '/api/items/T-OUT/artifacts/10' })
    const href = stylesheetHref(res.body)
    const resolved = new URL(href, `${origin}/api/items/T-OUT/artifacts/10`)
    assert.equal(resolved.href, `${origin}/api/agent-pages.css`)
  })

  test(`the step output page's stylesheet link resolves to the css route (origin ${origin})`, async () => {
    const res = await inject({ method: 'GET', url: '/api/items/T-OUT/steps/11/output' })
    const href = stylesheetHref(res.body)
    const resolved = new URL(href, `${origin}/api/items/T-OUT/steps/11/output`)
    assert.equal(resolved.href, `${origin}/api/agent-pages.css`)
  })

  test(`the live-tail page's stylesheet link resolves to the css route (origin ${origin})`, async () => {
    const res = await inject({ method: 'GET', url: `/api/runs/${runId}/log/view` })
    const href = stylesheetHref(res.body)
    const resolved = new URL(href, `${origin}/api/runs/${runId}/log/view`)
    assert.equal(resolved.href, `${origin}/api/agent-pages.css`)
  })
}

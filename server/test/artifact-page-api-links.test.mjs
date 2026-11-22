// Links to /api/… on the full-artifact pages are written relative to the
// page, like its stylesheet (cssHrefFor), so they resolve under the
// production subpath (shoreward.ai/horizon/…) instead of 404ing at the host
// root. Covers an agent's artifact line (the design page's
// `/api/items/<id>/design-page`) and the page's own "other versions" links,
// on both the latest-attempt and the specific-attempt routes. Other links are
// left as they are.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-artifact-api-links-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
delete process.env.HORIZON_REPO

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const get = (url) => app.inject({ method: 'GET', url, headers: { cookie } })

const ID = 'AL-1'
const ARTIFACT = [
  '**Design page:** [Open the design page](/api/items/AL-1/design-page) · round 1',
  '',
  'See [the issue](https://github.com/acme/web/issues/1).',
].join('\n')
db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES (?, 'Links', 'Medium', ?)").run(ID, ACCEPT_GATE_INDEX)
const insertRun = db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, started_at, ended_at) VALUES (?, ?, ?, 'Eng', 'done', 'summary', ?, '2026-10-01 10:00:00', '2026-10-01 10:05:00')",
)
insertRun.run(ID, IMPLEMENT_STEP_INDEX, 1, 'first attempt')
insertRun.run(ID, IMPLEMENT_STEP_INDEX, 2, ARTIFACT)

test('the latest-attempt page writes /api/ links relative to itself', async () => {
  const res = await get(`/api/items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}`)
  assert.equal(res.statusCode, 200)
  // /api/items/:id/artifacts/:stepIndex is three levels below /api/.
  assert.ok(res.body.includes('href="../../../items/AL-1/design-page"'), 'design page link is relative')
  assert.ok(res.body.includes(`href="../../../items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}/1"`), 'attempt link is relative')
  assert.ok(res.body.includes('href="https://github.com/acme/web/issues/1"'), 'other links are unchanged')
  assert.ok(!res.body.includes('href="/api/'), 'no root-relative /api/ link is left')
})

test('the specific-attempt page writes them one level deeper', async () => {
  const res = await get(`/api/items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}/2`)
  assert.equal(res.statusCode, 200)
  assert.ok(res.body.includes('href="../../../../items/AL-1/design-page"'))
  assert.ok(res.body.includes(`href="../../../../items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}/1"`))
  assert.ok(!res.body.includes('href="/api/'))
})

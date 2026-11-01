// HZ-664: a signed-in user who is a member of no project gets nothing. Every
// route in the scope registry — app.routeScopes(), Fastify's HEAD routes and
// the /api/test/* hooks included — is walked over a real listener with the
// outsider's session and with their API token, then as a disabled user, then
// as the owner. Nothing here uses a host secret or the screenshot test login:
// SCREENSHOT_LOGIN_KEY is deleted below and no request may carry its header.
//
// What a non-member gets, per route scope (access.js):
//   owner, test, member:*  the guard's 404 { error: 'not_found' }, for ids that
//                          are real rows in ISO Alpha / ISO Bravo — the owner
//                          gets past the guard with the same params
//   filtered               200 with nothing at each `emptyAt` path, where the
//                          owner's same response has something
//   self                   the caller's own data, and none of anyone else's
//   farm, hmac, wa, public the same status an anonymous request gets; each is
//                          then sent once more with its own credential
// Every outsider body, whatever its scope, is scanned for the seeded item
// ids, project names and slugs, repo names and the owner's email.
//
// A route with no row in CASES fails the walk by name (assertCasesCover), so
// a route added later must say what a non-member sees.
//
// setInterval is faked before app.js loads, as in stream-heartbeat.test.mjs,
// so the stream test can tick to a heartbeat rather than sleep.

import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureToken, loginFixtureUser } from './helpers/session.mjs'
import { FAKE_STRIPE_ENV, fakeStripe, setFakeStripeEnv } from './helpers/fakeStripe.mjs'
import { assertCasesCover, isEmptyValue, leaksIn, routeKey, valueAt } from './helpers/isolation-cases.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-isolation-non-member-')), 'test.db')
process.env.HORIZON_TEST_HOOKS = '1'
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'iso-farm-secret'
process.env.WA_APPROVAL_SECRET = 'iso-wa-secret'
process.env.WA_APPROVER_JIDS = '15550001111'
process.env.GITHUB_WEBHOOK_SECRET = 'iso-github-secret'
process.env.RULES_HMAC_SECRET = 'iso-rules-secret'
setFakeStripeEnv()
delete process.env.SCREENSHOT_LOGIN_KEY
delete process.env.HORIZON_REPO
delete process.env.FARM_HOME

mock.timers.enable({ apis: ['setInterval'] })

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const appModule = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { USER_SCOPES, EXEMPT_SCOPES } = await import('../src/access.js')
const { disableUser } = await import('../src/membership.js')
const definitions = await import('../src/definitions.js')
const github = await import('../src/github.js')
const projectValidate = await import('../src/projectValidate.js')
const { PERSONAS } = await import('../src/personas.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')

assert.equal(config.SCREENSHOT_LOGIN_KEY, '')
assert.equal(config.TEST_HOOKS_ENABLED, true)

// The farm answers every call; GitHub and anything else off this host is down,
// so no test reaches the network.
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  const { hostname } = new URL(String(url))
  if (hostname === '127.0.0.1') return realFetch(url, opts)
  if (hostname === 'farm.test') return Response.json({ ok: true, content: '', next_offset: 0 })
  return Response.json({ message: 'unreachable in this test' }, { status: 503 })
}

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

// ---- seed: two projects, each with a repo, items and a finished run ----

const ACCEPT_INDEX = STEPS.findIndex((step) => step.label === 'Accept the code')
assert.ok(ACCEPT_INDEX > 0)
const OWNER_EMAIL = 'iso-owner@example.com'
const A = store.createProject('ISO Alpha').id
const B = store.createProject('ISO Bravo').id
store.setProjectEnabled(B, true)
const REPO_A = 'iso-org/alpha-app'
const REPO_B = 'iso-org/bravo-app'
assert.equal(store.addRepoToProject(A, REPO_A).ok, true)
assert.equal(store.addRepoToProject(B, REPO_B).ok, true)
assert.equal(store.setRepoTestEnvFile(A, REPO_A, '/tmp/iso-alpha-test.env').ok, true)
const SLUG_A = definitions.rulesKey('project', 'ISO Alpha')

function seedItem(id, projectId, repo, cursor) {
  db.prepare(
    `INSERT INTO work_item (id, title, priority, desc, metric, guardrails, cursor, repo, project_id)
     VALUES (?, ?, 'Medium', '', '', '', ?, ?, ?)`,
  ).run(id, `Item ${id}`, cursor, repo, projectId)
  return Number(
    db
      .prepare(
        `INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at)
         VALUES (?, 0, 1, 'pm', 'done', 'iso output', '# Plan\n\nThe artifact.', '2026-10-01 12:00:00')`,
      )
      .run(id).lastInsertRowid,
  )
}
const RUN_A = seedItem('ISOA-1', A, REPO_A, ACCEPT_INDEX)
seedItem('ISOA-2', A, REPO_A, 0)
const RUN_B = seedItem('ISOB-1', B, REPO_B, ACCEPT_INDEX)

// ---- users: the owner, a member of nothing, and a member to be disabled ----

const owner = loginFixtureUser(auth, config, { email: OWNER_EMAIL, name: 'Iso Owner', role: 'owner' })
const ownerToken = loginFixtureToken(auth, owner.user, 'iso owner cli')
const ownerSpareToken = loginFixtureToken(auth, owner.user, 'iso owner spare')
const outsider = loginFixtureUser(auth, config, { email: 'iso-outsider@example.com', name: 'Iso Outsider', role: 'member' })
const outsiderToken = loginFixtureToken(auth, outsider.user, 'iso outsider cli')
const gone = loginFixtureUser(auth, config, { email: 'iso-disabled@example.com', name: 'Iso Disabled', role: 'member' })
const goneToken = loginFixtureToken(auth, gone.user, 'iso disabled cli')
for (const projectId of [A, B]) db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)').run(projectId, gone.user.id)

// What no outsider response may contain.
const NEEDLES = ['ISOA-1', 'ISOA-2', 'ISOB-1', 'ISO Alpha', 'ISO Bravo', SLUG_A, 'iso-bravo', REPO_A, REPO_B, 'iso-org__', OWNER_EMAIL]

const WA_JID = '15550001111'
const FARM = { 'x-farm-secret': 'iso-farm-secret' }
const WA = { 'x-wa-approval-secret': 'iso-wa-secret' }
const firstPersona = Object.entries(PERSONAS).find(([, bucket]) => Object.keys(bucket ?? {}).length > 0)
const [PERSONA_AGENT, PERSONA_ID] = [firstPersona[0], Object.keys(firstPersona[1])[0]]
const ROLE = definitions.listDefinitions().global[0]

// ISOA-1's screenshot publish, served in place of GitHub (as the e2e
// fixture does), so the owner's screenshot routes answer 200.
const SHOT_COMMIT = 'c'.repeat(40)
const SHOT_SHA = '01'.repeat(20)
const SCREENSHOTS = {
  snapshots: {
    [`${REPO_A}#ISOA-1`]: {
      commit: SHOT_COMMIT,
      results: { version: 1, baseline: 'b'.repeat(40), shots: [{ name: 'home', status: 'new', diffRatio: null, diff: null, error: null }] },
      files: { [`${github.SCREENSHOT_DIR}/home.png`]: { sha: SHOT_SHA, size: 4 } },
    },
  },
  blobs: { [SHOT_SHA]: Buffer.from('png!').toString('base64') },
}
github.setScreenshotSnapshotForTest(SCREENSHOTS.snapshots)
github.setBlobsForTest({ [SHOT_SHA]: Buffer.from('png!') })

function githubSigned(event, payload) {
  const body = JSON.stringify(payload)
  const signature = `sha256=${crypto.createHmac('sha256', 'iso-github-secret').update(body).digest('hex')}`
  return { body, headers: { 'x-github-event': event, 'x-hub-signature-256': signature } }
}
function stripeSigned(payload) {
  const body = JSON.stringify(payload)
  const t = Math.floor(Date.now() / 1000)
  const v1 = crypto.createHmac('sha256', FAKE_STRIPE_ENV.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex')
  return { body, headers: { 'stripe-signature': `t=${t},v1=${v1}` } }
}
const GITHUB_PING = githubSigned('ping', { zen: 'iso' })
const STRIPE_PING = stripeSigned({ id: 'evt_iso_ping', type: 'iso.ping', data: { object: {} } })

// ---- the case table: one row per registry route ----
//
// `owner` is the status the owner's session gets with the same params and
// body. A 2xx wherever the route can answer one in-process; otherwise the
// handler's own refusal, which is never the guard's not_found, so it still
// proves the params name a real row the guard let through. Each non-2xx says
// why beside it.
//
// `self` (self scope, and public routes that read the session themselves) is
// the outsider's status by credential. Exempt rows carry `own`: the request
// that presents the route's own credential, and the status it gets.

const DEPLOY_TARGET = {
  repo: REPO_A,
  script: 'deploy-horizon.sh',
  service: 'horizon-server',
  repoDir: '/tmp/iso-deploy',
  stateKey: 'iso-target',
  healthUrl: 'http://127.0.0.1:9/api/health',
  healthCheckType: 'json-ok',
}
const ITEM = '/api/items/ISOA-1'
const THREE = ['one', 'two', 'three']
const PLAN_DOC = {
  items: [{ id: '#1', repo: 'iso-org/plan-app', title: 'Iso draft', outcome: 'An outcome', metric: THREE, guardrails: THREE, depends_on: [], must_also_cover: [] }],
  shared_guardrails: [],
  open_questions: [],
}

const READ_CASES = {
  // owner
  'GET /api/admin/check-flakes': { expect: '404', url: '/api/admin/check-flakes', owner: 200 },
  'GET /api/admin/deploy-targets': { expect: '404', url: '/api/admin/deploy-targets', owner: 200 },
  'GET /api/admin/deploy-targets/config': { expect: '404', url: '/api/admin/deploy-targets/config', owner: 200 },
  // 503 farm_health_warming: no farm-health loop runs in a test.
  'GET /api/admin/farm-health': { expect: '404', url: '/api/admin/farm-health', owner: 503 },
  'GET /api/admin/productivity': { expect: '404', url: '/api/admin/productivity', owner: 200 },
  'GET /api/admin/test-history': { expect: '404', url: `/api/admin/test-history?repo=${REPO_A}`, owner: 200 },
  'GET /api/definitions': { expect: '404', url: '/api/definitions', owner: 200 },
  'GET /api/definitions/:kind/:name': { expect: '404', url: `/api/definitions/${ROLE.kind}/${ROLE.name}`, owner: 200 },
  'GET /api/projects/:id/repos/webhooks': { expect: '404', url: `/api/projects/${A}/repos/webhooks`, owner: 200 },
  'GET /api/sync/status': { expect: '404', url: '/api/sync/status', owner: 200 },
  // member:*
  'GET /api/definitions/effective': { expect: '404', url: '/api/definitions/effective?project=ISO%20Alpha', owner: 200 },
  'GET /api/items/:id/artifacts/:stepIndex': { expect: '404', url: `${ITEM}/artifacts/0`, owner: 200 },
  'GET /api/items/:id/artifacts/:stepIndex/:attempt': { expect: '404', url: `${ITEM}/artifacts/0/1`, owner: 200 },
  'GET /api/items/:id/steps/:stepIndex/output': { expect: '404', url: `${ITEM}/steps/0/output`, owner: 200 },
  // 404 no_job / no_plan_draft: ISOA-1 is a change item, with no Execute job or plan draft.
  'GET /api/items/:id/job': { expect: '404', url: `${ITEM}/job`, owner: 404 },
  'GET /api/items/:id/job/log': { expect: '404', url: `${ITEM}/job/log`, owner: 404 },
  'GET /api/items/:id/plan-draft': { expect: '404', url: `${ITEM}/plan-draft`, owner: 404 },
  'GET /api/items/:id/screenshots': { expect: '404', url: `${ITEM}/screenshots`, owner: 200 },
  'GET /api/items/:id/screenshots/:screen/:kind': { expect: '404', url: `${ITEM}/screenshots/home/new`, owner: 200 },
  'GET /api/items/:id/stream': { expect: '404', url: `/api/items/ISOB-1/stream`, owner: 200 },
  'GET /api/projects/:id/repos/check-defaults': { expect: '404', url: `/api/projects/${A}/repos/check-defaults?repo=${REPO_A}`, owner: 200 },
  'GET /api/projects/:id/validation': { expect: '404', url: `/api/projects/${B}/validation`, owner: 200 },
  'GET /api/projects/:slug/definitions': { expect: '404', url: `/api/projects/${SLUG_A}/definitions`, owner: 200 },
  'GET /api/projects/:slug/definitions/:file/history': { expect: '404', url: `/api/projects/${SLUG_A}/definitions/personas.json/history`, owner: 200 },
  'GET /api/rules/:scope/:key/versions': { expect: '404', url: `/api/rules/project/${SLUG_A}/versions`, owner: 200 },
  'GET /api/runs/:runId/log': { expect: '404', url: `/api/runs/${RUN_A}/log`, owner: 200 },
  'GET /api/runs/:runId/log/view': { expect: '404', url: `/api/runs/${RUN_B}/log/view`, owner: 200 },
  // filtered
  'GET /api/items': { expect: 'empty', url: '/api/items?v=2', emptyAt: ['items', 'projects'], owner: 200 },
  'GET /api/projects': { expect: 'empty', url: '/api/projects', emptyAt: ['projects'], owner: 200 },
  'GET /api/rules/targets': { expect: 'empty', url: '/api/rules/targets', emptyAt: ['projects', 'repos'], owner: 200 },
  'GET /api/stream': { expect: 'empty', url: '/api/stream?v=2', emptyAt: ['items', 'projects'], owner: 200 },
  // self
  // 404 no_subscription, for the owner too: nobody here has a Stripe subscription.
  'GET /api/billing': { expect: 'self', url: '/api/billing', self: { session: 404, token: 403 }, owner: 404 },
  'GET /api/tokens': { expect: 'self', url: '/api/tokens', self: { session: 200, token: 403 }, owner: 200 },
  // exempt
  'GET /api/agent-pages.css': { expect: 'exempt', url: '/api/agent-pages.css', own: { status: 200 } },
  'GET /api/auth/google/callback': { expect: 'exempt', url: '/api/auth/google/callback', own: { status: 302 } },
  'GET /api/auth/google/start': { expect: 'exempt', url: '/api/auth/google/start', own: { status: 302 } },
  'GET /api/auth/me': { expect: 'exempt', url: '/api/auth/me', readsSession: true, self: { session: 200 }, own: { status: 401 }, owner: 200 },
  'GET /api/billing/session-status': { expect: 'exempt', url: '/api/billing/session-status', own: { status: 400 } },
  'GET /api/health': { expect: 'exempt', url: '/api/health', own: { status: 200 } },
  'GET /api/openapi.json': { expect: 'exempt', url: '/api/openapi.json', own: { status: 200 } },
  'GET /api/farm/deploy-drain': { expect: 'exempt', url: '/api/farm/deploy-drain', own: { headers: FARM, status: 200 } },
  'GET /api/farm/knowledge/sources': { expect: 'exempt', url: '/api/farm/knowledge/sources', own: { headers: FARM, status: 200 } },
  'GET /api/farm/rules': { expect: 'exempt', url: `/api/farm/rules?project=ISO%20Alpha`, own: { headers: FARM, status: 200 } },
  'GET /api/farm/snapshot': { expect: 'exempt', url: '/api/farm/snapshot?scope=enabled', own: { headers: FARM, status: 200 } },
}

// Writes, in the order the owner runs them: anything that ends a row's use
// (abandon, disconnect, delete) comes last.
const WRITE_CASES = {
  // test (owner-only e2e hooks)
  'POST /api/test/run-state': { expect: '404', url: '/api/test/run-state', body: {}, owner: 200 },
  'POST /api/test/conflict-reply': { expect: '404', url: '/api/test/conflict-reply', body: {}, owner: 200 },
  'POST /api/test/github-pr': { expect: '404', url: '/api/test/github-pr', body: {}, owner: 200 },
  'POST /api/test/screenshot-snapshot': { expect: '404', url: '/api/test/screenshot-snapshot', body: SCREENSHOTS, owner: 200 },
  // owner
  'POST /api/admin/deploy-targets': { expect: '404', url: '/api/admin/deploy-targets', body: { key: 'iso-target', ...DEPLOY_TARGET }, owner: 201 },
  'PUT /api/admin/deploy-targets/:key': { expect: '404', url: '/api/admin/deploy-targets/iso-target', body: DEPLOY_TARGET, owner: 200 },
  'POST /api/admin/deploy-targets/:key/dry-run': { expect: '404', url: '/api/admin/deploy-targets/iso-target/dry-run', body: {}, owner: 200 },
  // An unknown kind: a real one would commit to this checkout's farm/ dir.
  'PUT /api/definitions/:kind/:name': { expect: '404', url: '/api/definitions/iso-nope/iso', body: { content: 'iso' }, owner: 404 },
  'PUT /api/projects/:id/isolation': { expect: '404', url: `/api/projects/${A}/isolation`, body: { runUser: 'isoalpha' }, owner: 200 },
  'POST /api/projects/:id/repos': { expect: '404', url: `/api/projects/${A}/repos`, body: { repo: 'iso-org/new-app' }, owner: 400 }, // GitHub is unreachable here: validateRepo fails
  'PUT /api/projects/:id/repos/test-env': { expect: '404', url: `/api/projects/${A}/repos/test-env`, body: { repo: REPO_A, path: '/tmp/iso-alpha-test.env' }, owner: 200 },
  'POST /api/projects/:id/repos/webhook/fix': { expect: '404', url: `/api/projects/${A}/repos/webhook/fix`, body: { repo: REPO_A }, owner: 503 }, // webhook_url_not_public: the test UI_URL is localhost
  'POST /api/sync/token': { expect: '404', url: '/api/sync/token', body: { token: 'iso-not-a-real-token' }, owner: 400 }, // GitHub is unreachable here
  // member:*
  'POST /api/items': { expect: '404', url: '/api/items', body: { title: 'Iso new item', outcome: 'An outcome', metric: 'A metric', repo: REPO_A }, owner: 502 }, // GitHub is unreachable: no issue is created
  'POST /api/items/:id/dependencies': { expect: '404', url: `${ITEM}/dependencies`, body: { dependsOnId: 'ISOA-2' }, owner: 200 },
  'POST /api/items/:id/dependencies/remove': { expect: '404', url: `${ITEM}/dependencies/remove`, body: { dependsOnId: 'ISOA-2' }, owner: 200 },
  'POST /api/items/:id/feedback': { expect: '404', url: `${ITEM}/feedback`, body: { message: 'iso feedback' }, owner: 200 },
  'POST /api/items/:id/pause': { expect: '404', url: `${ITEM}/pause`, body: { paused: false }, owner: 200 },
  'POST /api/items/:id/persona': { expect: '404', url: `${ITEM}/persona`, body: { agent: PERSONA_AGENT, persona: PERSONA_ID }, owner: 200 },
  'POST /api/items/:id/priority': { expect: '404', url: `${ITEM}/priority`, body: { priority: 'High' }, owner: 200 },
  'PUT /api/items/:id/steps/:stepIndex/provider': { expect: '404', url: `${ITEM}/steps/0/provider`, body: { provider: 'default' }, owner: 200 },
  'PUT /api/items/:id/plan-draft': { expect: '404', url: `${ITEM}/plan-draft`, body: { base_version: 1, doc: PLAN_DOC }, owner: 404 }, // no_plan_draft, as the GET
  'POST /api/items/:id/autopilot-off': { expect: '404', url: `${ITEM}/autopilot-off`, body: { off: true }, owner: 409 }, // no_github_issue: the seeded items have no issue
  // 409 no_job / nothing_to_resume / review_not_rejected / no_pr: states the seeded item is not in.
  'POST /api/items/:id/job/stop': { expect: '404', url: `${ITEM}/job/stop`, owner: 409 },
  'POST /api/items/:id/job/resume': { expect: '404', url: `${ITEM}/job/resume`, owner: 409 },
  'POST /api/items/:id/forward-to-accept': { expect: '404', url: `${ITEM}/forward-to-accept`, owner: 409 },
  'POST /api/items/:id/resolve-conflicts': { expect: '404', url: `${ITEM}/resolve-conflicts`, owner: 409 },
  'POST /api/items/:id/screenshots/approve': { expect: '404', url: `${ITEM}/screenshots/approve`, body: { commit: SHOT_COMMIT, all: true }, owner: 200 },
  'POST /api/items/:id/phases/:phase/restart': { expect: '404', url: '/api/items/ISOA-2/phases/0/restart', body: {}, owner: 200 },
  'POST /api/items/:id/gates/:stepIndex/approve': { expect: '404', url: `${ITEM}/gates/${ACCEPT_INDEX}/approve`, body: {}, owner: 200 },
  'POST /api/items/:id/reject': { expect: '404', url: `${ITEM}/reject`, body: {}, owner: 200 },
  'POST /api/projects/:id/activate': { expect: '404', url: `/api/projects/${B}/activate`, owner: 200 },
  'POST /api/projects/:id/autopilot': { expect: '404', url: `/api/projects/${A}/autopilot`, body: { mode: 'off' }, owner: 200 },
  'POST /api/projects/:id/definitions-enabled': { expect: '404', url: `/api/projects/${A}/definitions-enabled`, body: { enabled: false }, owner: 200 },
  'POST /api/projects/:id/enabled': { expect: '404', url: `/api/projects/${B}/enabled`, body: { enabled: true }, owner: 200 },
  'PUT /api/projects/:id/repos/checks': { expect: '404', url: `/api/projects/${A}/repos/checks`, body: { repo: REPO_A, test: 'npm test' }, owner: 200 },
  'PUT /api/projects/:id/repos/marks': { expect: '404', url: `/api/projects/${A}/repos/marks`, body: { repo: REPO_A, noDeploy: true }, owner: 200 },
  'PUT /api/projects/:id/step-providers/:stepIndex': { expect: '404', url: `/api/projects/${A}/step-providers/0`, body: { provider: 'default' }, owner: 200 },
  // 409 validation_in_progress: the owner's walk holds the slot, as a real run spawns the farm's checks.
  'POST /api/projects/:id/validate': { expect: '404', url: `/api/projects/${A}/validate`, body: {}, owner: 409 },
  // An unknown file: a real one would commit to this checkout's farm/ dir.
  'PUT /api/projects/:slug/definitions/:file': { expect: '404', url: `/api/projects/${SLUG_A}/definitions/iso-nope.json`, body: { content: {} }, owner: 404 },
  'POST /api/rules/:scope/:key': { expect: '404', url: `/api/rules/project/${SLUG_A}`, body: { content: 'iso rule' }, owner: 200 },
  'POST /api/rules/:scope/:key/versions/:version/restore': { expect: '404', url: `/api/rules/project/${SLUG_A}/versions/1/restore`, owner: 200 },
  // self
  'POST /api/projects': { expect: 'self', url: '/api/projects', body: { name: 'Iso Outsider Own' }, self: { session: 200, token: 409 }, owner: 200, ownerBody: { name: 'Iso Owner New' } },
  'POST /api/tokens': { expect: 'self', url: '/api/tokens', body: { name: 'iso new token' }, self: { session: 201, token: 403 }, owner: 201 },
  'POST /api/billing/cancel': { expect: 'self', url: '/api/billing/cancel', body: {}, self: { session: 404, token: 403 }, owner: 404 },
  'POST /api/billing/resume': { expect: 'self', url: '/api/billing/resume', body: {}, self: { session: 404, token: 403 }, owner: 404 },
  'POST /api/billing/card-session': { expect: 'self', url: '/api/billing/card-session', body: {}, self: { session: 404, token: 403 }, owner: 404 },
  // The owner's spare token: the outsider's DELETE must not revoke it.
  'DELETE /api/tokens/:id': { expect: 'self', url: `/api/tokens/${ownerSpareToken.id}`, self: { session: 404, token: 403 }, owner: 200 },
  // exempt: public
  'POST /api/auth/login': { expect: 'exempt', url: '/api/auth/login', body: { email: OWNER_EMAIL, password: 'not-the-password' }, own: { status: 401 } },
  'POST /api/billing/checkout-session': { expect: 'exempt', url: '/api/billing/checkout-session', body: {}, own: { status: 400 } },
  // exempt: hmac
  'POST /api/webhooks/github': { expect: 'exempt', url: '/api/webhooks/github', body: GITHUB_PING.body, own: { headers: GITHUB_PING.headers, status: 204 } },
  'POST /api/billing/stripe-webhook': { expect: 'exempt', url: '/api/billing/stripe-webhook', body: STRIPE_PING.body, own: { headers: STRIPE_PING.headers, status: 200 } },
  // exempt: wa. Step 0 is not ISOA-1's gate, so its own credential approves nothing.
  'POST /api/items/:id/gates/:stepIndex/approve-via-whatsapp': { expect: 'exempt', url: `${ITEM}/gates/0/approve-via-whatsapp`, body: { senderJid: WA_JID }, own: { headers: WA, status: 409 } },
  'POST /api/wa/poll-vote': { expect: 'exempt', url: '/api/wa/poll-vote', body: { voteId: 'iso-vote', pollMessageId: 'iso-poll', voterJid: WA_JID, selectedOption: 'Approve' }, own: { headers: WA, status: 404 } }, // ignored_unknown_poll, past the secret and the allowlist
  'POST /api/projects/autopilot-off-via-whatsapp': { expect: 'exempt', url: '/api/projects/autopilot-off-via-whatsapp', body: { project: 'ISO Alpha', senderJid: WA_JID }, own: { headers: WA, status: 200 } },
  // exempt: farm
  'POST /api/farm/deploy-drain': { expect: 'exempt', url: '/api/farm/deploy-drain', body: { ttl_s: 0 }, own: { headers: FARM, status: 200 } },
  'POST /api/farm/deploy-drain/interrupt': { expect: 'exempt', url: '/api/farm/deploy-drain/interrupt', body: { runs: [] }, own: { headers: FARM, status: 200 } },
  'DELETE /api/farm/deploy-drain': { expect: 'exempt', url: '/api/farm/deploy-drain', own: { headers: FARM, status: 200 } },
  'POST /api/farm/items/finished': { expect: 'exempt', url: '/api/farm/items/finished', body: { ids: ['ISOA-1'] }, own: { headers: FARM, status: 200 } },
  'PUT /api/farm/knowledge/docs/:projectId/:slug': {
    expect: 'exempt',
    url: `/api/farm/knowledge/docs/${A}/iso-doc`,
    body: { repo: REPO_A, path: 'docs/iso.pdf', sourceSha: 'a'.repeat(40), status: 'failed', pageCount: 0, sectionCount: 0, sections: [], error: 'iso' },
    own: { headers: FARM, status: 404 }, // unknown_source: ISO Alpha's definitions switch is off
  },
  'POST /api/farm/steps/:runId/started': { expect: 'exempt', url: `/api/farm/steps/${RUN_A}/started`, own: { headers: FARM, status: 200 } },
  'POST /api/farm/steps/:runId/checks': { expect: 'exempt', url: `/api/farm/steps/${RUN_A}/checks`, body: { phase: 'start' }, own: { headers: FARM, status: 200 } },
  'POST /api/farm/steps/:runId/progress': { expect: 'exempt', url: `/api/farm/steps/${RUN_A}/progress`, body: { commands: [] }, own: { headers: FARM, status: 200 } },
  'POST /api/farm/steps/:runId/test-runs': { expect: 'exempt', url: `/api/farm/steps/${RUN_A}/test-runs`, body: { test_runs: [] }, own: { headers: FARM, status: 200 } },
  'POST /api/farm/steps/:runId/test-runs/abandon': { expect: 'exempt', url: `/api/farm/steps/${RUN_A}/test-runs/abandon`, body: { why: 'rejected' }, own: { headers: FARM, status: 200 } },
  'POST /api/farm/steps/:runId/blocked': { expect: 'exempt', url: `/api/farm/steps/${RUN_A}/blocked`, body: { rule: 'iso rule', needs: 'iso needs' }, own: { headers: FARM, status: 200 } },
  'POST /api/farm/steps/:runId/complete': { expect: 'exempt', url: `/api/farm/steps/${RUN_A}/complete`, body: { summary: 'iso' }, own: { headers: FARM, status: 200 } },
  'POST /api/farm/steps/:runId/fail': { expect: 'exempt', url: `/api/farm/steps/${RUN_A}/fail`, body: { error: 'iso' }, own: { headers: FARM, status: 200 } },
  // Last: each ends the use of the row it names.
  'DELETE /api/admin/deploy-targets/:key': { expect: '404', url: '/api/admin/deploy-targets/iso-target', owner: 200 },
  'POST /api/items/:id/abandon': { expect: '404', url: '/api/items/ISOA-2/abandon', body: { reason: 'iso abandon' }, owner: 200 },
  'POST /api/projects/:id/repos/disconnect': { expect: '404', url: `/api/projects/${B}/repos/disconnect`, body: { repo: REPO_B }, owner: 200 },
  // After every PIN route: a new PIN would refuse the rest.
  'POST /api/auth/gate-pin/regenerate': { expect: 'exempt', url: '/api/auth/gate-pin/regenerate', readsSession: true, freshSession: true, self: { session: 200 }, own: { status: 401 }, owner: 200 },
  'POST /api/auth/logout': { expect: 'exempt', url: '/api/auth/logout', readsSession: true, freshSession: true, self: { session: 200 }, own: { status: 200 }, owner: 200 },
}

// Fastify adds a HEAD route for every GET; each answers its GET's status.
const HEAD_CASES = Object.fromEntries(
  Object.entries(READ_CASES).map(([key, c]) => [key.replace(/^GET /, 'HEAD '), { ...c, expect: 'head', get: key }]),
)

const CASES = { ...READ_CASES, ...HEAD_CASES, ...WRITE_CASES }
const exemptCase = (c) => c.expect === 'exempt' || (c.expect === 'head' && CASES[c.get].expect === 'exempt')

// ---- the walker ----

const app = appModule.buildApp({ logger: false, stripe: fakeStripe() })
let base
before(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${app.server.address().port}`
})
after(async () => {
  mock.timers.reset()
  await app.close()
})

const methodOf = (key) => key.slice(0, key.indexOf(' '))
const isRead = (key) => ['GET', 'HEAD'].includes(methodOf(key))
const ORDERED_KEYS = [...Object.keys(CASES).filter(isRead), ...Object.keys(CASES).filter((key) => !isRead(key))]

// Reads an SSE response until its first whole frame.
async function firstFrame(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

// The JSON of an SSE frame's data line, or of a whole body.
function parseBody(text) {
  const data = /^data: (.*)$/m.exec(text)
  try {
    return JSON.parse(data ? data[1] : text)
  } catch {
    return null
  }
}

// One request over the real listener — SSE routes included, which
// app.inject() cannot end. An SSE body is read to its first frame, then the
// connection is dropped.
async function call(key, c, headers = {}, { body = c.body } = {}) {
  for (const name of Object.keys(headers)) {
    assert.ok(!name.toLowerCase().startsWith('x-horizon-test-env'), `${key}: the test-env login header is never sent`)
  }
  const controller = new AbortController()
  const init = { method: methodOf(key), headers: { ...headers }, signal: controller.signal, redirect: 'manual' }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers['content-type'] = 'application/json'
  }
  const res = await fetch(base + c.url, init)
  let text = ''
  if (init.method !== 'HEAD') {
    text = (res.headers.get('content-type') || '').startsWith('text/event-stream') ? await firstFrame(res) : await res.text()
  }
  controller.abort()
  return { status: res.status, text, json: parseBody(text) }
}

const shown = (res) => `${res.status} ${res.text.slice(0, 160)}`

// The credentials a walk sends, by name. The PIN rides along so a route's
// gate check is never what stops the caller: only the guard may.
function credentialsOf(who, token) {
  return {
    session: { cookie: who.cookie, 'x-human-key': who.pin },
    token: { ...token.headers, 'x-human-key': who.pin },
  }
}
function freshSessionOf(who) {
  return { cookie: `${config.SESSION_COOKIE_NAME}=${auth.createSession(who.user.id)}`, 'x-human-key': who.pin }
}

const scopeOf = new Map()
function registry() {
  return app.routeScopes()
}

// ---- G2 / metric 3: the table covers the registry, and a gap is named ----

test('the registry lists every route, HEAD and /api/test/* included, and CASES has exactly one row per route', () => {
  const routes = registry()
  for (const route of routes) scopeOf.set(routeKey(route), route.scope)
  assert.ok(routes.some((r) => r.method === 'HEAD'))
  assert.ok(routes.some((r) => r.scope === 'test'))
  for (const route of routes) assert.ok([...USER_SCOPES, ...EXEMPT_SCOPES].includes(route.scope), routeKey(route))
  assertCasesCover(routes, CASES)
  // A user-scope route is never walked as exempt, nor the reverse.
  for (const [key, c] of Object.entries(CASES)) {
    assert.equal(exemptCase(c), EXEMPT_SCOPES.includes(scopeOf.get(key)), key)
  }
})

test('a registry route with no non-member case fails the walk, naming the route', () => {
  const routes = registry()
  const withDummy = [...routes, { method: 'GET', url: '/api/__iso_dummy', scope: 'filtered' }]
  assert.throws(() => assertCasesCover(withDummy, CASES), (err) => err.message.includes('GET /api/__iso_dummy'))
  assert.equal(registry().length, routes.length, 'the live registry is untouched')
  const { [routeKey(routes[0])]: _dropped, ...short } = CASES
  assert.throws(() => assertCasesCover(routes, short), (err) => err.message.includes(routeKey(routes[0])))
})

// ---- metric 1 setup: the outsider is a member of nothing ----

const memberRows = (userId) => db.prepare('SELECT COUNT(*) AS n FROM project_member WHERE user_id = ?').get(userId).n

test('the outsider was created after the membership migration and has no project_member row', () => {
  assert.equal(db.prepare("SELECT value FROM setting WHERE key = 'membership_v1'").get()?.value, 'done')
  assert.equal(memberRows(outsider.user.id), 0)
  assert.equal(memberRows(gone.user.id), 2)
})

// ---- metric 2: the outsider's live feed carries nothing ----

function streamReader(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const state = { text: '', done: false }
  const readUntil = async (needle, count = 1) => {
    while (state.text.split(needle).length - 1 < count) {
      const { value, done } = await reader.read()
      if (done) {
        state.done = true
        break
      }
      state.text += decoder.decode(value, { stream: true })
    }
    return state.text.split(needle).length - 1 >= count
  }
  return { state, readUntil }
}

// Each frame as { event, data }.
function framesOf(text) {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? 'message'
      const data = /^data: (.*)$/m.exec(chunk)?.[1]
      return { event, data: data === undefined ? null : JSON.parse(data) }
    })
}

const HEARTBEAT = 'event: heartbeat'

test('the outsider’s /api/stream, by session and by token, stays open and sends no item, farm, sync or testEnvFile frame while items in both projects change', async () => {
  const controller = new AbortController()
  const open = async (headers) => {
    const res = await fetch(`${base}/api/stream?v=2`, { headers, signal: controller.signal })
    assert.equal(res.status, 200)
    return streamReader(res)
  }
  try {
    const ownerTab = await open({ cookie: owner.cookie })
    const bySession = await open({ cookie: outsider.cookie })
    const byToken = await open(outsiderToken.headers)
    for (const tab of [ownerTab, bySession, byToken]) assert.ok(await tab.readUntil('event: snapshot'))
    assert.equal(appModule.streamClientCount(), 3)

    for (const id of ['ISOA-1', 'ISOB-1']) db.prepare('UPDATE work_item SET title = ? WHERE id = ?').run(`Changed ${id}`, id)
    store.notifyChange()
    appModule.flushStream()
    // The heartbeat goes out after the flush, so once a tab has it, any delta
    // for that tab is already in its text.
    mock.timers.tick(15_000)
    for (const tab of [ownerTab, bySession, byToken]) assert.ok(await tab.readUntil(HEARTBEAT), 'no heartbeat')

    // Positive control: the owner's tab saw both changes, and its feed
    // carries farm, sync and a repo's testEnvFile.
    const ownerFrames = framesOf(ownerTab.state.text)
    const ownerSnapshot = ownerFrames.find((f) => f.event === 'snapshot').data
    assert.ok(Object.hasOwn(ownerSnapshot, 'farm') && Object.hasOwn(ownerSnapshot, 'sync'))
    assert.ok(ownerTab.state.text.includes('"testEnvFile":"/tmp/iso-alpha-test.env"'))
    const upserted = ownerFrames.filter((f) => f.event === 'delta').flatMap((f) => (f.data.upserts ?? []).map((item) => item.id))
    assert.ok(upserted.includes('ISOA-1') && upserted.includes('ISOB-1'), `owner deltas: ${upserted}`)

    for (const [name, tab] of [['session', bySession], ['token', byToken]]) {
      const frames = framesOf(tab.state.text)
      assert.deepEqual(
        frames.map((f) => f.event),
        ['snapshot', 'heartbeat'],
        `${name}: only the connect snapshot and the heartbeat`,
      )
      const snap = frames[0].data
      assert.deepEqual(snap.items, [], name)
      assert.deepEqual(snap.projects, [], name)
      for (const key of ['farm', 'sync', 'deployBlock']) assert.ok(!Object.hasOwn(snap, key), `${name}: ${key}`)
      assert.ok(!tab.state.text.includes('testEnvFile'), name)
      assert.deepEqual(leaksIn(tab.state.text, NEEDLES), [], name)
      assert.equal(tab.state.done, false, `${name}: the stream ended`)
    }
    assert.equal(appModule.streamClientCount(), 3, 'every tab is still connected')
  } finally {
    controller.abort()
    appModule.flushStream()
  }
})

// ---- metric 1 and guardrail 4: the outsider's walk ----

// The seeded projects' rows, and the owner's tokens, as the walks must leave them.
function seededState() {
  const items = "SELECT id FROM work_item WHERE project_id IN (?, ?)"
  return {
    project: db.prepare('SELECT * FROM project WHERE id IN (?, ?) ORDER BY id').all(A, B),
    project_repo: db.prepare('SELECT * FROM project_repo WHERE project_id IN (?, ?) ORDER BY id').all(A, B),
    project_member: db.prepare('SELECT * FROM project_member WHERE project_id IN (?, ?) ORDER BY project_id, user_id').all(A, B),
    work_item: db.prepare('SELECT * FROM work_item WHERE project_id IN (?, ?) ORDER BY id').all(A, B),
    step_run: db.prepare(`SELECT * FROM step_run WHERE item_id IN (${items}) ORDER BY id`).all(A, B),
    owner_tokens: db.prepare('SELECT id, revoked_at FROM api_token WHERE user_id = ? ORDER BY id').all(owner.user.id),
  }
}
let stateBeforeWalks

// One caller's walk. `check(key, c, res, cred)` returns a failure or null.
// Returns the failures, and the walked keys by credential.
async function walk(creds, check, { anon = true, bodyOf = (c) => c.body } = {}) {
  // A registry route with no case fails here, by name, before anything is sent.
  assertCasesCover(registry(), CASES)
  const failures = []
  const walked = Object.fromEntries(Object.keys(creds).map((cred) => [cred, new Set()]))
  const statuses = Object.fromEntries(Object.keys(creds).map((cred) => [cred, new Map()]))
  const anonStatus = new Map()
  for (const phase of [true, false]) {
    for (const cred of Object.keys(creds)) {
      for (const key of ORDERED_KEYS.filter((k) => isRead(k) === phase)) {
        const c = CASES[key]
        if (exemptCase(c) && anon && !anonStatus.has(key)) anonStatus.set(key, (await call(key, c)).status)
        const headers = c.freshSession && cred === 'session' && creds.fresh ? creds.fresh() : creds[cred]
        const res = await call(key, c, headers, { body: bodyOf(c) })
        statuses[cred].set(key, res.status)
        walked[cred].add(key)
        const failure = check(key, c, res, cred, { anonStatus, statuses: statuses[cred] })
        if (failure) failures.push(`${cred} ${key}: ${failure}`)
      }
    }
  }
  return { failures, walked }
}

function outsiderCheck(key, c, res, cred, { anonStatus, statuses }) {
  const leaks = leaksIn(res.text, NEEDLES)
  if (leaks.length) return `leaked ${leaks.join(', ')} in ${shown(res)}`
  switch (c.expect) {
    case '404':
      return res.status === 404 && res.json?.error === 'not_found' ? null : `expected the guard's 404, got ${shown(res)}`
    case 'empty': {
      if (res.status !== 200) return `expected 200, got ${shown(res)}`
      const full = c.emptyAt.filter((path) => !isEmptyValue(valueAt(res.json, path)))
      return full.length ? `not empty at ${full.join(', ')}: ${shown(res)}` : null
    }
    case 'self':
      return res.status === c.self[cred] ? null : `expected ${c.self[cred]}, got ${shown(res)}`
    case 'head':
      // An empty HEAD body is never a pass on its own: its GET's row checked the body.
      return res.status === statuses.get(c.get) ? null : `expected its GET's ${statuses.get(c.get)}, got ${res.status}`
    case 'exempt':
      if (c.readsSession && cred === 'session') return res.status === c.self.session ? null : `expected ${c.self.session}, got ${shown(res)}`
      return res.status === anonStatus.get(key) ? null : `expected the anonymous ${anonStatus.get(key)}, got ${shown(res)}`
    default:
      return `unknown expectation ${c.expect}`
  }
}

test('the outsider gets 404, an empty result or only their own data from every route, by session and by token', async () => {
  stateBeforeWalks = seededState()
  const outsiderCreds = credentialsOf(outsider, outsiderToken)
  Object.defineProperty(outsiderCreds, 'fresh', { value: () => freshSessionOf(outsider), enumerable: false })
  const { failures, walked } = await walk(outsiderCreds, outsiderCheck)
  assert.deepEqual(failures, [])
  const keys = registry().map(routeKey)
  for (const cred of ['session', 'token']) assert.deepEqual([...walked[cred]].sort(), [...keys].sort(), `${cred}: every registry route walked`)
  assert.equal(walked.session.size, registry().length)
})

// ---- metric 5: a disabled user's credentials die ----

test('a disabled user’s existing session and token get 401 on every user route, and the anonymous status on every exempt one', async () => {
  const goneCreds = credentialsOf(gone, goneToken)
  for (const headers of Object.values(goneCreds)) {
    const res = await call('GET /api/items', CASES['GET /api/items'], headers)
    assert.equal(res.status, 200, 'the credential worked before the disable')
    assert.ok(res.text.includes('ISOA-1') && res.text.includes('ISOB-1'))
  }
  assert.equal(disableUser(db, gone.user.id, 'iso test'), true)
  const { failures, walked } = await walk(goneCreds, (key, c, res, cred, { anonStatus }) => {
    if (!exemptCase(c)) return res.status === 401 ? null : `expected 401, got ${shown(res)}`
    return res.status === anonStatus.get(key) ? null : `expected the anonymous ${anonStatus.get(key)}, got ${shown(res)}`
  })
  assert.deepEqual(failures, [])
  for (const cred of ['session', 'token']) assert.equal(walked[cred].size, registry().length)
})

test('the outsider’s and the disabled user’s walks left both projects’ rows and the owner’s tokens unchanged', () => {
  assert.ok(stateBeforeWalks)
  assert.deepEqual(seededState(), stateBeforeWalks)
  assert.equal(memberRows(outsider.user.id), 1, 'only the project the outsider made themselves')
})

// ---- metric 4: the owner sees everything ----

test('the owner’s token lists items and projects from both seeded projects', async () => {
  const items = await call('GET /api/items', CASES['GET /api/items'], ownerToken.headers)
  assert.equal(items.status, 200)
  const ids = items.json.items.map((item) => item.id)
  for (const id of ['ISOA-1', 'ISOA-2', 'ISOB-1']) assert.ok(ids.includes(id), id)
  const projects = await call('GET /api/projects', CASES['GET /api/projects'], ownerToken.headers)
  const names = projects.json.projects.map((p) => p.name)
  assert.ok(names.includes('ISO Alpha') && names.includes('ISO Bravo'))
})

test('the owner walks the same routes and gets each one’s documented status, with both projects’ items', async () => {
  // A real validation run spawns the farm's checks; a run already in progress
  // answers 409 instead, after the guard.
  assert.equal(projectValidate.tryBeginValidation(A), true)
  try {
    const ownerCreds = { session: { cookie: owner.cookie, 'x-human-key': owner.pin } }
    Object.defineProperty(ownerCreds, 'fresh', { value: () => freshSessionOf(owner), enumerable: false })
    const { failures, walked } = await walk(
      ownerCreds,
      (key, c, res, cred, { statuses }) => {
        if (c.expect === 'head') {
          return res.status === statuses.get(c.get) ? null : `expected its GET's ${statuses.get(c.get)}, got ${res.status}`
        }
        if (c.expect === 'exempt' && !c.readsSession) return null
        if (res.status !== c.owner) return `expected ${c.owner}, got ${shown(res)}`
        if (c.expect === '404' && res.json?.error === 'not_found' && res.status === 404) return 'the guard refused the owner'
        if (c.expect === 'empty') {
          const empty = c.emptyAt.filter((path) => isEmptyValue(valueAt(res.json, path)))
          if (empty.length) return `owner empty at ${empty.join(', ')}`
        }
        if (key === 'GET /api/items' || key === 'GET /api/stream') {
          const ids = (res.json?.items ?? []).map((item) => item.id)
          if (!ids.includes('ISOA-1') || !ids.includes('ISOB-1')) return `owner items: ${ids}`
        }
        return null
      },
      { anon: false, bodyOf: (c) => c.ownerBody ?? c.body },
    )
    assert.deepEqual(failures, [])
    assert.equal(walked.session.size, registry().length)
  } finally {
    projectValidate.endValidation(A)
  }
})

test('every exempt route answers its own credential', async () => {
  const failures = []
  for (const key of ORDERED_KEYS) {
    const c = CASES[key]
    if (c.expect !== 'exempt') continue
    const res = await call(key, c, c.own.headers ?? {})
    if (res.status !== c.own.status) failures.push(`${key}: expected ${c.own.status}, got ${shown(res)}`)
  }
  assert.deepEqual(failures, [])
})

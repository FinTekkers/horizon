// HZ-235: a merge into main starts the existing Resolve-conflicts run on each
// Accept-gate item it left conflicted — through the real signed webhook, the
// real poll tick and the real resolveConflicts(). Metric line 1, the poll
// fallback, coalescing, the webhook and feedback-loop guardrails, the mixed
// one-line-per-item fixture (metric line 5), frozen gate state and log
// hygiene. See helpers/autoResolveHarness.mjs for what is faked.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupAutoResolve, REPO, MAIN_SHA_2, MAIN_SHA_3, TOKEN, WEBHOOK_SECRET } from './helpers/autoResolveHarness.mjs'

const h = await setupAutoResolve('auto-resolve-main-moved')
const { db, lifecycle, settings, autoResolve, gh, lines } = h
const { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, STEPS } = lifecycle
const REVIEW_STEP_INDEX = ACCEPT_GATE_INDEX - 1

beforeEach(() => h.reset())

const snapshot = (ids) =>
  ids.map((id) => {
    const { cursor, priority, paused, abandoned_at, rejected } = h.row(id)
    return { id, cursor, priority, paused, abandoned_at, rejected }
  })

test('metric 1: merging X leaves Y conflicted — exactly one auto run, recorded as main moved, Y back clean and still at the gate', async () => {
  // On by default: no setting row and no env var.
  assert.equal(settings.getSetting('auto_resolve_on_main'), null)
  assert.equal(process.env.AUTO_RESOLVE_ON_MAIN, undefined)
  assert.equal(settings.isAutoResolveOnMain(), true)

  h.insertItem('M1-X', { cursor: STEPS.length, pr: 241 }) // X: already accepted, PR merged
  h.conflictedAtGate('M1-Y', 302)
  h.insertItem('M1-P', { pr: 303, paused: 1 }) // a skipped neighbour, for the frozen-state check
  const before = snapshot(['M1-Y', 'M1-P'])
  gh.mainSha = MAIN_SHA_2

  const res = await h.mergeWebhook(241)
  assert.equal(res.statusCode, 204)
  await h.untilFarmCalls(1)

  // The run is in flight: one farm call, recorded as started by main moving.
  assert.equal(h.resolveCallsFor('M1-Y').length, 1)
  assert.equal(h.gateAction('M1-Y').started_by, 'main_moved')
  assert.equal(h.gateAction('M1-Y').state, 'running')
  const started = h.events('M1-Y').find((t) => t.startsWith('main moved'))
  assert.ok(started, 'an event says the run was started by main moving')
  assert.match(started, /merged PR #241/)
  assert.match(started, /started Resolve conflicts automatically/)

  gh.mergeable.set(302, true) // the resolver's push made it mergeable again
  h.farmCalls[0].resolve(h.replyOk(h.resolved))
  await autoResolve.whenIdleForTest()

  assert.equal(h.gateAction('M1-Y').state, 'resolved')
  assert.equal(h.row('M1-Y').pr_mergeable, 1, 'Y merges cleanly into main')
  assert.equal(h.row('M1-Y').cursor, ACCEPT_GATE_INDEX, 'Y still waits at the Accept gate for a human')
  assert.deepEqual(snapshot(['M1-Y', 'M1-P']), before, 'cursor, priority, paused, abandoned unchanged')
  assert.deepEqual(h.nonGetGithubCalls(), [], 'nothing but reads reached GitHub — nothing merged into main')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = 'M1-Y'").get().n, 0, 'no gate decision')
  assert.deepEqual(h.itemLines('M1-Y'), [`auto-resolve ${REPO} [main moved: merged PR #241] M1-Y PR #302: started — resolved`])
  assert.deepEqual(h.itemLines('M1-P'), [`auto-resolve ${REPO} [main moved: merged PR #241] M1-P PR #303: skipped (paused)`])

  // The next poll tick reads main at the same sha the scan handled: no second scan.
  lines.length = 0
  await h.pollTick()
  assert.equal(h.farmCalls.length, 1, 'still exactly one run')
  assert.deepEqual(h.itemLines('M1-Y'), [])
})

test('poll fallback: a new main sha with no webhook starts one scan; the same sha again starts none', async () => {
  h.insertItem('PF-C', { pr: 311 }) // clean probe: one `clean` line per scan
  h.conflictedAtGate('PF-Y', 312)
  h.farmReplyNext(h.resolved)

  await h.pollTick() // first sight of main only seeds
  assert.equal(h.itemLines('PF-C').length, 0)

  gh.mainSha = MAIN_SHA_2
  gh.commitPrs.set(MAIN_SHA_2, [250])
  gh.mergeable.set(312, false)
  await h.pollTick()
  await autoResolve.whenIdleForTest()
  assert.equal(h.resolveCallsFor('PF-Y').length, 1)
  assert.deepEqual(h.itemLines('PF-C'), [`auto-resolve ${REPO} [main moved: merged PR #250] PF-C PR #311: clean`])
  assert.ok(h.events('PF-Y').some((t) => /main moved \(merged PR #250\)/.test(t)))

  gh.mergeable.set(312, true)
  await h.pollTick()
  await h.pollTick()
  assert.equal(h.itemLines('PF-C').length, 1, 'the same sha starts no scan')
  assert.equal(h.farmCalls.length, 1)
})

test('poll fallback: a sha a webhook scan already handled starts nothing', async () => {
  h.insertItem('PW-C', { pr: 321 })
  await h.pollTick() // seeds MAIN_SHA_1
  gh.mainSha = MAIN_SHA_3
  await h.mergeWebhook(260, { sha: MAIN_SHA_3 })
  await autoResolve.whenIdleForTest()
  assert.equal(h.itemLines('PW-C').length, 1)

  await h.pollTick()
  assert.equal(h.itemLines('PW-C').length, 1, 'the poll sees the scanned sha and starts nothing')
})

test('a lost claim writes no "started" event and logs skipped (lock held)', async () => {
  h.conflictedAtGate('LC-Y', 331)
  // Another run takes the lock between the scan's lock check and its claim:
  // while the scan is reading the PR's mergeability.
  gh.onPrRead = (n) => {
    if (n === 331 && !h.gateAction('LC-Y')) h.store.claimGateAction('LC-Y', 'resolve', { timeoutMs: 60_000 })
  }
  await h.mergeWebhook(270)
  await autoResolve.whenIdleForTest()

  assert.equal(h.farmCalls.length, 0)
  assert.equal(h.events('LC-Y').filter((t) => t.startsWith('main moved')).length, 0, 'no false "started" event')
  assert.equal(h.gateAction('LC-Y').started_by, 'human', 'the lock is still the other run’s')
  assert.deepEqual(h.itemLines('LC-Y'), [`auto-resolve ${REPO} [main moved: merged PR #270] LC-Y PR #331: skipped (lock held)`])
})

test('two merges inside the debounce make one scan and one run naming both; a PR seen by webhook and poll appears once', async () => {
  h.insertItem('CO-C', { pr: 341 })
  h.conflictedAtGate('CO-Y', 342)
  await h.pollTick() // seed main for the poll path
  h.farmReplyNext(h.resolved)

  gh.mainSha = MAIN_SHA_2
  gh.commitPrs.set(MAIN_SHA_2, [281])
  await h.mergeWebhook(280, { sha: 'd'.repeat(40) })
  await h.mergeWebhook(281, { sha: MAIN_SHA_2 })
  await h.github.pollOnce({ info() {}, warn() {} }) // the poll also reports #281, inside the same window
  await autoResolve.whenIdleForTest()

  assert.equal(h.itemLines('CO-C').length, 1, 'one scan')
  assert.equal(h.resolveCallsFor('CO-Y').length, 1, 'one run')
  const started = h.events('CO-Y').filter((t) => t.startsWith('main moved'))
  assert.equal(started.length, 1)
  assert.match(started[0], /^main moved \(merged PR #280, #281\) — PR #342/)
})

test('a push to an item branch and a PR closed unmerged start nothing (no feedback loop)', async () => {
  h.insertItem('FL-C', { pr: 351 })
  h.conflictedAtGate('FL-Y', 352)
  const push = await h.webhook('push', { ref: 'refs/heads/horizon/fl-y', after: MAIN_SHA_3 })
  assert.equal(push.statusCode, 204)
  const unmerged = await h.mergeWebhook(290, { merged: false })
  assert.equal(unmerged.statusCode, 204)
  await autoResolve.whenIdleForTest()
  assert.equal(h.farmCalls.length, 0)
  assert.deepEqual(h.itemLines('FL-C'), [], 'no scan')
})

test('unsigned, badly signed and non-main merges start nothing', async () => {
  h.insertItem('WG-C', { pr: 361 })
  h.conflictedAtGate('WG-Y', 362)
  const bad = await h.mergeWebhook(291, { signature: 'sha256=' + '0'.repeat(64) })
  assert.equal(bad.statusCode, 401)
  const missing = await h.mergeWebhook(292, { signature: null })
  assert.equal(missing.statusCode, 401)
  const otherBase = await h.mergeWebhook(293, { base: 'release' })
  assert.equal(otherBase.statusCode, 204)
  await autoResolve.whenIdleForTest()
  assert.equal(h.farmCalls.length, 0)
  assert.deepEqual(h.itemLines('WG-C'), [], 'no scan')
})

test('metric 5: every rule — exactly one line per item, each skip names its reason', async () => {
  const { id: offProject } = h.store.createProject('auto-resolve disabled project')
  db.prepare('UPDATE project SET enabled = 0 WHERE id = ?').run(offProject)

  h.insertItem('MX-CLOSE', { cursor: REVIEW_STEP_INDEX, pr: 400 })
  const closeRun = h.startStep('MX-CLOSE', REVIEW_STEP_INDEX)
  await h.mergeWebhook(299)
  await autoResolve.whenIdleForTest()
  assert.ok(autoResolve.waitingForTest().includes('MX-CLOSE'))
  // It is closed while waiting (its step ended without telling anyone).
  db.prepare("UPDATE step_run SET status = 'done' WHERE id = ?").run(closeRun)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(STEPS.length, 'MX-CLOSE')
  lines.length = 0

  h.insertItem('MX-CLEAN', { pr: 401 })
  h.insertItem('MX-PAUSED', { pr: 402, paused: 1 })
  h.insertItem('MX-ABANDONED', { pr: 403, abandoned: true })
  h.insertItem('MX-STEP', { cursor: REVIEW_STEP_INDEX, pr: 404 })
  h.startStep('MX-STEP', REVIEW_STEP_INDEX)
  h.insertItem('MX-NOTGATE', { cursor: IMPLEMENT_STEP_INDEX })
  h.insertItem('MX-NOPR', {})
  h.insertItem('MX-MERGING', { pr: 405 })
  h.store.claimGateAction('MX-MERGING', 'premerge', { timeoutMs: 60_000 })
  h.insertItem('MX-LOCKED', { pr: 406, mergeable: 0 })
  h.store.claimGateAction('MX-LOCKED', 'resolve', { timeoutMs: 60_000 })
  h.insertItem('MX-OFFPROJ', { pr: 407, projectId: offProject })
  h.conflictedAtGate('MX-CONFLICT', 408)
  h.insertItem('MX-UNKNOWN', { pr: 409 })
  gh.mergeable.set(409, null)
  h.farmReplyNext(h.resolved)

  gh.mainSha = MAIN_SHA_3
  await h.mergeWebhook(300, { sha: MAIN_SHA_3 })
  await autoResolve.whenIdleForTest()

  const expected = {
    'MX-CLOSE': 'skipped (closed)',
    'MX-CLEAN': 'clean',
    'MX-PAUSED': 'skipped (paused)',
    'MX-ABANDONED': 'skipped (abandoned)',
    'MX-STEP': 'skipped (step running)',
    'MX-NOTGATE': 'skipped (not at accept gate)',
    'MX-NOPR': 'skipped (no PR)',
    'MX-MERGING': 'skipped (merge in progress)',
    'MX-LOCKED': 'skipped (lock held)',
    'MX-OFFPROJ': 'skipped (project disabled)',
    'MX-CONFLICT': 'started — resolved',
    'MX-UNKNOWN': 'checked (mergeability unknown — re-check queued)',
  }
  for (const [id, decision] of Object.entries(expected)) {
    const got = h.itemLines(id)
    assert.equal(got.length, 1, `${id}: exactly one line, got ${JSON.stringify(got)}`)
    assert.ok(got[0].endsWith(`: ${decision}`), `${id}: ${got[0]}`)
    assert.match(got[0], /^auto-resolve acme\/auto-resolve \[main moved: merged PR #300\] /)
  }
  assert.equal(h.farmCalls.length, 1, 'only the conflicted item got a run')
  assert.equal(h.resolveCallsFor('MX-CONFLICT').length, 1)
  assert.ok(!autoResolve.waitingForTest().includes('MX-CLOSE'), 'the closed item left the re-check list')
})

test('no token, webhook secret, URL or git command line in any log line or event text', () => {
  // Runs last: checks everything the tests above logged and recorded.
  const all = [...h.allLines, ...db.prepare('SELECT text FROM event').all().map((r) => r.text)]
  db.prepare("SELECT detail FROM gate_action WHERE detail IS NOT NULL").all().forEach((r) => all.push(r.detail))
  for (const text of all) {
    assert.ok(!text.includes(TOKEN), text)
    assert.ok(!text.includes(WEBHOOK_SECRET), text)
    assert.ok(!text.includes('https://'), text)
    assert.ok(!/\bgit /.test(text), text)
  }
})

// HZ-729: every open ask gets one independent review on a provider other than
// its author's (server/src/askReview.js). Muse by default, the project's
// ask_review_provider when set; no fallback — an unavailable reviewer leaves
// the ask awaiting. The verdict (accept, amend, escalate) and its reasons are
// stored on the ask_review table and shown in the item snapshot; the review
// changes no item and no ask field. The farm call is always an injected stub:
// no test here reaches farmd.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitGithubStub } from './helpers/splitGithubStub.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-ask-review-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = 'ghp_TEST_ASK_REVIEW'
delete process.env.GITHUB_WEBHOOK_SECRET

const stub = splitGithubStub()
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const askReview = await import('../src/askReview.js')
const { stepLabel } = await import('../src/asks.js')
const { composeIssueBody } = await import('../src/github.js')
const { requiredStepIndex, PLAN_DRAFT_STEP_INDEX, STEPS } = await import('../../domain/js/lifecycle.js')
const { defaultModel, PROVIDERS } = await import('../../domain/js/providers.js')

store.purgeDemoItems()
await orchestrator.init({ info: () => {}, warn: () => {} })
await new Promise((r) => setTimeout(r, 50)) // ensureFarm's start handshake

after(() => {
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
})

const ARCH = requiredStepIndex('Architecture review')
const PLAN = requiredStepIndex('Draft implementation plan')
const IMPLEMENT = requiredStepIndex('Specialist agent implements')
const PLAN_KIND = STEPS[PLAN_DRAFT_STEP_INDEX].itemKind
const SRC = 'FinTekkers/ledger-service'
const LIB = 'FinTekkers/ledger-models'
const MUSE_MODEL = defaultModel('muse')

const projectId = store.createProject('FinTekkers').id
for (const repo of [SRC, LIB]) store.addRepoToProject(projectId, repo)

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
let seq = 0

const draftOf = (over = {}) => ({
  title: 'Publish script must use the bot identity',
  repo: SRC,
  outcome: 'The publish script commits as the bot.',
  metric: '1. Commits name the bot.\n2. The owner identity is never used.\n3. A dry run prints the identity.',
  guardrails: '- No change to the release tag format.\n- No new secrets.\n- No new dependency.',
  ...over,
})

function newItem(title, cursor, { repo = SRC, kind = null } = {}) {
  seq++
  const id = `AR-${seq}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor) VALUES (?, ?, 'Medium', 'Fix it.', 'Works.', '', ?, ?, ?, ?)",
  ).run(id, title, 9000 + seq, repo, projectId, cursor)
  if (kind) db.prepare('UPDATE work_item SET kind = ? WHERE id = ?').run(kind, id)
  return id
}

function doneRun(itemId, stepIndex, { provider = null, runsOn = null, artifact = null } = {}) {
  return db
    .prepare("INSERT INTO step_run (item_id, step_index, agent, status, provider, runs_on, artifact) VALUES (?, ?, 'Architect', 'done', ?, ?, ?)")
    .run(itemId, stepIndex, provider, runsOn, artifact).lastInsertRowid
}

// One open ask on a fresh item, raised by a step that ran on `provider`.
function seedAsk({ provider = 'claude', runsOn = null, draft = draftOf(), kind = 'soft', itemId = null } = {}) {
  const item = itemId ?? newItem(`asker ${seq + 1}`, ARCH)
  const runId = doneRun(item, ARCH, { provider, runsOn })
  const askId = db
    .prepare("INSERT INTO ask (item_id, step_run_id, step_index, kind, status, draft_json, why) VALUES (?, ?, ?, ?, 'open', ?, ?)")
    .run(item, runId, ARCH, kind, JSON.stringify(draft), 'Architecture review: the publish script commits as the owner.').lastInsertRowid
  return { itemId: item, askId: Number(askId), runId }
}

// A farm stand-in: records each body, answers from `reply(body)`.
function farm(reply = (body) => ({ verdict: 'accept', reasons: ['fits'], refers_to: [], provider: body.provider })) {
  const calls = []
  const review = async (body) => {
    calls.push(body)
    return reply(body)
  }
  return { calls, review, callsFor: (askId) => calls.filter((b) => b.ask_id === askId) }
}

const reviewRow = (askId) => db.prepare('SELECT * FROM ask_review WHERE ask_id = ?').get(askId)
const shown = (itemId, askId) => store.itemViewById(itemId).asks.find((a) => a.id === askId)
const retire = (...askIds) => {
  for (const id of askIds) db.prepare("UPDATE ask SET status = 'superseded' WHERE id = ?").run(id)
}
const setProjectReviewer = (value) => db.prepare('UPDATE project SET ask_review_provider = ? WHERE id = ?').run(value, projectId)

// ---- metric line 1: one review, never on the author's provider ----

test('provider matrix: Muse by default, the project setting overrides, the author is never chosen, anything unknown waits', () => {
  const pick = (authorProvider, projectSetting) => askReview.chooseReviewer({ authorProvider, projectSetting })
  const cases = [
    ['claude', null, 'muse'],
    ['muse', null, 'claude'],
    ['muse', 'claude', 'claude'],
    ['claude', 'claude', 'muse'],
    ['muse', 'muse', 'claude'],
  ]
  for (const [author, setting, expected] of cases) {
    const got = pick(author, setting)
    assert.equal(got.provider, expected, `${author} / ${setting}`)
    assert.notEqual(got.provider, author)
  }
  assert.match(pick('claude', 'gemini').wait, /“gemini” is not a declared provider/)
  assert.match(pick(null, null).wait, /unknown/)
  assert.match(pick('gemini', null).wait, /unknown/)
  const onlyClaude = PROVIDERS.filter((p) => p.name === 'claude')
  assert.match(askReview.chooseReviewer({ authorProvider: 'claude', projectSetting: 'claude', providers: onlyClaude }).wait, /no provider other than Claude/)
})

test('through the sweep: default, override, setting equal to the author; unknown setting, unknown author wait and call nothing', async () => {
  const f = farm()
  const byDefault = seedAsk({ provider: 'claude' })
  await askReview.reviewAsks({ review: f.review })
  assert.deepEqual(f.callsFor(byDefault.askId).map((b) => b.provider), ['muse'])
  assert.equal(reviewRow(byDefault.askId).author_provider, 'claude')

  setProjectReviewer('claude')
  const override = seedAsk({ provider: 'muse' })
  const sameAsAuthor = seedAsk({ provider: 'claude' })
  // No provider recorded: the provider the run was dispatched on is the author.
  const fromRunsOn = seedAsk({ provider: null, runsOn: 'claude:claude-opus-5-5' })
  await askReview.reviewAsks({ review: f.review })
  assert.deepEqual(f.callsFor(override.askId).map((b) => b.provider), ['claude'])
  assert.deepEqual(f.callsFor(sameAsAuthor.askId).map((b) => b.provider), ['muse'])
  assert.deepEqual(f.callsFor(fromRunsOn.askId).map((b) => b.provider), ['muse'])

  setProjectReviewer('gemini')
  const unknownSetting = seedAsk({ provider: 'claude' })
  setProjectReviewer(null)
  const unknownAuthor = seedAsk({ provider: null, runsOn: null })
  setProjectReviewer('gemini')
  await askReview.reviewAsks({ review: f.review })
  setProjectReviewer(null)
  for (const { itemId, askId } of [unknownSetting, unknownAuthor]) {
    assert.equal(f.callsFor(askId).length, 0)
    const review = shown(itemId, askId).review
    assert.equal(review.status, 'awaiting')
    assert.ok(review.wait_reason)
    assert.equal(review.verdict, null)
  }
  for (const body of f.calls) {
    const author = reviewRow(body.ask_id).author_provider
    assert.notEqual(body.provider, author)
  }
  retire(unknownSetting.askId, unknownAuthor.askId)
})

test('a step reply with two asks starts their reviews through the change signal, once each, never on the author', async () => {
  const f = farm()
  const handle = askReview.init({ warn: () => {}, error: () => {} }, { review: f.review })
  try {
    const issue = stub.addIssue(SRC, { title: 'two asks', body: composeIssueBody({ outcome: 'Fix it.', metric: 'Works.', guardrails: '' }) })
    const id = `LS-${issue.number}`
    db.prepare(
      "INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor) VALUES (?, 'two asks', 'Medium', 'Fix it.', 'Works.', '', ?, ?, ?, ?)",
    ).run(id, issue.number, SRC, projectId, ARCH)
    orchestrator.kick(id)
    await tick()
    const run = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, ARCH)
    assert.ok(run)
    const ask = (title) => ({ kind: 'soft', ...draftOf({ title }), why: 'Architecture review: a follow-up.' })
    const artifacts = { artifact_md: '## Verdict\n**pass**', provider: 'claude', model: 'claude-opus-5-5', asks: [ask('first'), ask('second')] }
    assert.deepEqual(await orchestrator.completeFarmRun(run.id, { summary: 'done', artifacts }), { ok: true })
    const askIds = db.prepare('SELECT id FROM ask WHERE item_id = ? ORDER BY id').all(id).map((r) => r.id)
    assert.equal(askIds.length, 2)

    const deadline = Date.now() + 5000
    while (askIds.some((a) => f.callsFor(a).length === 0) && Date.now() < deadline) await tick()
    // Two more sweeps at once, then a third: no second run for either ask.
    await Promise.all([askReview.reviewAsks({ review: f.review }), askReview.reviewAsks({ review: f.review })])
    await askReview.reviewAsks({ review: f.review })
    for (const askId of askIds) {
      const calls = f.callsFor(askId)
      assert.equal(calls.length, 1, `ask ${askId} was reviewed ${calls.length} times`)
      assert.equal(calls[0].provider, 'muse')
      assert.notEqual(calls[0].provider, db.prepare('SELECT provider FROM step_run WHERE id = ?').get(run.id).provider)
      assert.equal(shown(id, askId).review.status, 'done')
    }
  } finally {
    handle.stop()
  }
})

// ---- metric line 2: an unavailable reviewer leaves the ask waiting ----

test('a usage-limited reviewer model waits (shown in the snapshot), calls nothing, then runs once when the limit clears', async () => {
  const f = farm()
  const { itemId, askId } = seedAsk({ provider: 'claude' })
  store.markModelLimited('muse', MUSE_MODEL, '2099-01-01T00:00:00Z', 'test')
  try {
    for (let i = 0; i < 3; i++) await askReview.reviewAsks({ review: f.review })
    assert.equal(f.callsFor(askId).length, 0, 'no run on any provider while Muse is limited')
    const review = shown(itemId, askId).review
    assert.equal(review.status, 'awaiting')
    assert.match(review.wait_reason, /usage-limited until 2099-01-01/)
  } finally {
    db.prepare('DELETE FROM model_limit WHERE model = ?').run(MUSE_MODEL)
  }
  await askReview.reviewAsks({ review: f.review })
  assert.deepEqual(f.callsFor(askId).map((b) => [b.provider, b.model]), [['muse', MUSE_MODEL]])
  assert.equal(shown(itemId, askId).review.status, 'done')
})

test('a limit on a different model of the reviewer provider does not block the review', async () => {
  const f = farm()
  const { askId } = seedAsk({ provider: 'claude' })
  const other = PROVIDERS.find((p) => p.name === 'muse').models.find((m) => m.id !== MUSE_MODEL).id
  store.markModelLimited('muse', other, '2099-01-01T00:00:00Z', 'test')
  try {
    await askReview.reviewAsks({ review: f.review })
  } finally {
    db.prepare('DELETE FROM model_limit WHERE model = ?').run(other)
  }
  assert.deepEqual(f.callsFor(askId).map((b) => [b.provider, b.model]), [['muse', MUSE_MODEL]])
})

test('a farmd 503 — not authenticated, or a usage limit hit mid-call — sends the review back to awaiting with no verdict', async () => {
  const refuse = (code) => Object.assign(new Error(code), { status: 503, code })
  let answer = () => {
    throw refuse('provider not authenticated: muse is logged out')
  }
  const f = farm((body) => answer(body))
  const { itemId, askId } = seedAsk({ provider: 'claude' })
  await askReview.reviewAsks({ review: f.review })
  let row = reviewRow(askId)
  assert.equal(row.status, 'awaiting')
  assert.equal(row.verdict, null)
  assert.match(shown(itemId, askId).review.wait_reason, /Muse is unavailable: provider not authenticated/)

  answer = () => {
    throw refuse('usage limited until 2099-02-03T04:00:00Z')
  }
  await askReview.reviewAsks({ review: f.review })
  row = reviewRow(askId)
  assert.equal(row.status, 'awaiting')
  assert.equal(row.verdict, null)
  assert.match(row.wait_reason, /usage-limited until 2099-02-03 04:00 UTC/)
  try {
    assert.equal(store.activeModelLimits(Date.now()).get(MUSE_MODEL), Date.parse('2099-02-03T04:00:00Z'), 'the limit is on the ledger')
    await askReview.reviewAsks({ review: f.review })
    assert.equal(f.callsFor(askId).length, 2, 'no call while the recorded limit holds')
  } finally {
    db.prepare('DELETE FROM model_limit WHERE model = ?').run(MUSE_MODEL)
  }
  assert.ok(f.callsFor(askId).every((b) => b.provider === 'muse'), 'never the author’s provider')
  retire(askId)
})

test('a repeated farmd 503 does not re-trigger the sweep: the change-driven loop settles after a bounded number of calls', async () => {
  const f = farm(() => {
    throw Object.assign(new Error('provider not authenticated: muse is logged out'), { status: 503, code: 'provider not authenticated' })
  })
  const { askId } = seedAsk({ provider: 'claude' })
  const handle = askReview.init({ warn: () => {}, error: () => {} }, { review: f.review })
  try {
    await tick(300)
    const settled = f.callsFor(askId).length
    assert.ok(settled >= 1 && settled <= 2, `the 503 was retried ${settled} times`)
    await tick(300)
    assert.equal(f.callsFor(askId).length, settled, 'no further calls until the timed re-sweep')
    assert.equal(reviewRow(askId).status, 'awaiting')
  } finally {
    handle.stop()
    retire(askId)
  }
})

// ---- metric line 3: verdicts stored and shown; nothing else changes ----

function snapshotOf(itemId) {
  return {
    asks: db.prepare('SELECT * FROM ask ORDER BY id').all(),
    item: db.prepare('SELECT * FROM work_item WHERE id = ?').get(itemId),
    events: db.prepare('SELECT * FROM event WHERE item_id = ? ORDER BY id').all(itemId),
    deps: db.prepare('SELECT * FROM work_item_dependency ORDER BY item_id, depends_on_id').all(),
    runs: db.prepare('SELECT COUNT(*) AS n FROM step_run').get().n,
    items: db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n,
  }
}

test('accept, amend and escalate: each verdict and its reasons are stored and shown; no item or ask field changes', async () => {
  const itemId = newItem('three verdicts', ARCH)
  const accept = seedAsk({ itemId })
  const amend = seedAsk({ itemId, draft: draftOf({ title: 'Too big', metric: '1. a\n2. b\n3. c\n4. d\n5. e' }) })
  const escalate = seedAsk({ itemId })
  const edited = draftOf({ title: 'Smaller', repo: LIB, metric: '1. a\n2. b\n3. c' })
  const replies = {
    [accept.askId]: { verdict: 'accept', reasons: ['Fits the rules.'] },
    [amend.askId]: { verdict: 'amend', reasons: ['Metric too long.', 'Cut to three lines.'], draft: edited },
    [escalate.askId]: { verdict: 'escalate', reasons: ['Conflicts with a project rule.'] },
  }
  const f = farm((body) => ({ ...replies[body.ask_id], refers_to: [], provider: body.provider }))
  const before = snapshotOf(itemId)
  await askReview.reviewAsks({ review: f.review })
  assert.deepEqual(snapshotOf(itemId), before, 'the review changed no ask, item, event or dependency row')

  const view = (askId) => shown(itemId, askId).review
  assert.deepEqual(view(accept.askId), {
    status: 'done', provider: 'muse', verdict: 'accept', reasons: ['Fits the rules.'], amended_draft: null, refers_to: [], wait_reason: null,
  })
  assert.equal(view(amend.askId).status, 'done')
  assert.equal(view(amend.askId).verdict, 'amend')
  assert.deepEqual(view(amend.askId).reasons, ['Metric too long.', 'Cut to three lines.'])
  assert.deepEqual(view(amend.askId).amended_draft, edited)
  assert.equal(view(escalate.askId).verdict, 'escalate')
  assert.deepEqual(view(escalate.askId).reasons, ['Conflicts with a project rule.'])
  assert.equal(view(escalate.askId).status, 'done')
  // The ask's own draft is unchanged: the amended draft sits beside it.
  assert.equal(shown(itemId, amend.askId).title, 'Too big')
})

test('an amend whose edited draft fails the ask checks is stored as escalate naming the field', async () => {
  const { itemId, askId } = seedAsk()
  const f = farm((body) => ({ verdict: 'amend', reasons: ['Shorter.'], draft: draftOf({ metric: '1. only one line' }), provider: body.provider }))
  await askReview.reviewAsks({ review: f.review })
  const review = shown(itemId, askId).review
  assert.equal(review.verdict, 'escalate')
  assert.equal(review.amended_draft, null)
  assert.match(review.reasons[0], /edited draft's `metric` has 1 lines/)
})

test('a network error stores failed, a restart mid-review stores interrupted; neither is re-run', async () => {
  const f = farm(() => {
    throw new Error('farm request to /ask/review timed out after 180000ms')
  })
  const failed = seedAsk()
  await askReview.reviewAsks({ review: f.review })
  let review = shown(failed.itemId, failed.askId).review
  assert.equal(review.status, 'failed')
  assert.equal(review.verdict, 'escalate')
  assert.match(review.reasons[0], /timed out/)

  const running = seedAsk()
  db.prepare("INSERT INTO ask_review (ask_id, status, provider) VALUES (?, 'running', 'muse')").run(running.askId)
  assert.equal(askReview.failInterruptedReviews(), 1)
  await askReview.reviewAsks({ review: f.review })
  await askReview.reviewAsks({ review: f.review })
  review = shown(running.itemId, running.askId).review
  assert.equal(review.status, 'interrupted')
  assert.equal(review.verdict, 'escalate')
  assert.deepEqual(f.callsFor(running.askId), [])
  assert.equal(f.callsFor(failed.askId).length, 1)
})

test('the farm’s fail-closed reply is stored as failed, not as a reviewer verdict; a provider mismatch escalates', async () => {
  const unusable = seedAsk()
  const mismatch = seedAsk()
  const f = farm((body) =>
    body.ask_id === unusable.askId
      ? { verdict: 'escalate', reasons: ['the reviewer did not return a usable answer'], provider: body.provider, unusable: true }
      : { verdict: 'accept', reasons: ['fine'], provider: 'claude' },
  )
  await askReview.reviewAsks({ review: f.review })
  assert.equal(shown(unusable.itemId, unusable.askId).review.status, 'failed')
  const review = shown(mismatch.itemId, mismatch.askId).review
  assert.equal(review.status, 'failed', 'a reply from the wrong provider is a farm fault, not a reviewer verdict')
  assert.equal(review.verdict, 'escalate')
  assert.match(review.reasons[0], /ran on claude, not Muse/)
})

// ---- metric line 4: overlap matches reach the reviewer and its verdict ----

// The reviewer stand-in names only what it was given.
const overlapFarm = () =>
  farm((body) => {
    const ids = body.matches.map((m) => m.id)
    const plan = body.matches.find((m) => m.kind === PLAN_KIND)
    return plan
      ? { verdict: 'amend', reasons: [`Amend ${plan.id} instead.`], refers_to: [...ids, 'HZ-NOT-A-MATCH'], draft: body.draft, provider: body.provider }
      : { verdict: 'escalate', reasons: [`Duplicates ${ids.join(', ')}.`], refers_to: [...ids, 'HZ-NOT-A-MATCH'], provider: body.provider }
  })

test('an ask that duplicates an in-flight item: the match is in the input and the escalate names it', async () => {
  const peer = newItem('Bot identity for publish', IMPLEMENT)
  doneRun(peer, PLAN, { artifact: '## Changes\n- `scripts/publish.sh`: switch `commitIdentity()` to the bot.' })
  const { itemId, askId } = seedAsk({ draft: draftOf({ outcome: 'Change `scripts/publish.sh` so commits use the bot.' }) })
  const f = overlapFarm()
  await askReview.reviewAsks({ review: f.review })
  const [body] = f.callsFor(askId)
  const match = body.matches.find((m) => m.id === peer)
  assert.ok(match, 'the in-flight peer is a match')
  assert.deepEqual(match.sharedFiles, ['scripts/publish.sh'])
  assert.deepEqual(JSON.parse(reviewRow(askId).input_json).matches, body.matches)
  const review = shown(itemId, askId).review
  assert.equal(review.verdict, 'escalate')
  assert.deepEqual(review.refers_to, [peer], 'an id that is not a match is dropped')
  assert.match(review.reasons[0], new RegExp(peer))
  retire(askId)
})

test('an ask inside an open Plan’s area: the Plan is a match and the amend names it; an abandoned Plan is not', async () => {
  const draftsMd = '## Draft items\n- Touches `server/src/ledgerExport.js` and `server/src/ledgerFormat.js`.'
  const plan = newItem('Ledger export roadmap', PLAN_DRAFT_STEP_INDEX + 1, { kind: PLAN_KIND })
  doneRun(plan, PLAN_DRAFT_STEP_INDEX, { artifact: draftsMd })
  const abandoned = newItem('Old ledger roadmap', PLAN_DRAFT_STEP_INDEX + 1, { kind: PLAN_KIND })
  doneRun(abandoned, PLAN_DRAFT_STEP_INDEX, { artifact: draftsMd })
  db.prepare("UPDATE work_item SET abandoned_at = datetime('now') WHERE id = ?").run(abandoned)

  const { itemId, askId } = seedAsk({ draft: draftOf({ outcome: 'Add a CSV column in `server/src/ledgerExport.js`.' }) })
  const f = overlapFarm()
  await askReview.reviewAsks({ review: f.review })
  const [body] = f.callsFor(askId)
  assert.deepEqual(body.matches.map((m) => [m.id, m.kind]), [[plan, PLAN_KIND]])
  assert.deepEqual(JSON.parse(reviewRow(askId).input_json).matches, body.matches)
  const review = shown(itemId, askId).review
  assert.equal(review.verdict, 'amend')
  assert.deepEqual(review.refers_to, [plan])
  assert.match(review.reasons[0], new RegExp(`Amend ${plan}`))
  db.prepare("UPDATE work_item SET abandoned_at = datetime('now') WHERE id = ?").run(plan)
})

// ---- guardrails ----

test('review only: askReview.js writes nothing but ask_review and reaches no filing, dependency or GitHub write helper', () => {
  const code = readFileSync(join(REPO_ROOT, 'server/src/askReview.js'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  for (const forbidden of [/addDependency/, /applyOverlap/, /queueFeedback/, /from '\.\/github\.js'/, /from '\.\/spawn\.js'/, /patchIssue|createIssue|postComment/, /UPDATE ask\b/, /UPDATE work_item/]) {
    assert.doesNotMatch(code, forbidden)
  }
  const writes = [...code.matchAll(/\b(INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM)\s+(\w+)/g)].map((m) => m[2])
  assert.ok(writes.length > 0)
  assert.deepEqual([...new Set(writes)], ['ask_review'])
  // The overlap footprint may read a peer's PR files (a GitHub read).
  assert.match(code, /footprintOf/)
})

test('input hygiene: the body carries exactly the allowed keys; a host path or token is never sent; input_json is not shown', async () => {
  const f = farm()
  const ok = seedAsk()
  // Bypasses the ask checks on purpose: a stored draft holding a host path.
  const hostPath = seedAsk({ draft: draftOf({ outcome: 'Read /home/ubuntu/.horizon-farm/logs/run.log first.' }) })
  await askReview.reviewAsks({ review: f.review })
  const [body] = f.callsFor(ok.askId)
  assert.deepEqual(Object.keys(body).sort(), [...askReview.REVIEW_INPUT_KEYS].sort())
  assert.equal(f.callsFor(hostPath.askId).length, 0)
  const waiting = shown(hostPath.itemId, hostPath.askId).review
  assert.equal(waiting.status, 'awaiting')
  assert.match(waiting.wait_reason, /host path/)
  assert.ok(!('input_json' in shown(ok.itemId, ok.askId).review))
  retire(hostPath.askId)

  const ask = db.prepare('SELECT * FROM ask WHERE id = ?').get(ok.askId)
  const build = (rules) =>
    askReview.buildReviewInput(ask, draftOf(), { provider: 'muse', model: MUSE_MODEL, project: 'FinTekkers', overlap: { matches: [], candidates: [] }, rules })
  assert.ok(build({ project: 'Keep the API stable.' }).body)
  assert.match(build({ project: 'Logs live in /home/ubuntu/.horizon/logs.' }).refused, /host path/)
  assert.match(build({ repo: `Deploy with ghp_${'A'.repeat(36)}.` }).refused, /token or secret/)
})

test('steps by name: the body names the step by its label and carries no step index', async () => {
  const f = farm()
  const { askId } = seedAsk()
  await askReview.reviewAsks({ review: f.review })
  const [body] = f.callsFor(askId)
  assert.equal(body.step, stepLabel(ARCH))
  assert.equal(body.step, 'Architecture review')
  assert.ok(!('step_index' in body))
  assert.doesNotMatch(JSON.stringify(body), /"step_index"/)
})

test('the role prompt covers fit, overlap and shape; both docs describe the review step and its provider rule', () => {
  const read = (file) => readFileSync(join(REPO_ROOT, file), 'utf8')
  const role = read('farm/roles/ask_review.md')
  for (const words of [/\*\*Fit\.\*\*/, /\*\*Overlap\.\*\*/, /\*\*Shape\.\*\*/, /3–5 line/, /3–4\s+guardrails/, /never file, dismiss or edit/]) assert.match(role, words)
  const arch = read('docs/agent-architecture.md')
  assert.match(arch, /## Ask review/)
  assert.match(arch, /else \*\*Muse\*\*/)
  assert.match(arch, /never runs on the ask\s+author's provider/)
  assert.match(arch, /ask_review_provider/)
  const workflow = read('docs/workflow.md')
  const section = workflow.slice(workflow.indexOf('## Which agent does what'))
  assert.match(section, /\*\*Ask reviewer\*\*/)
  assert.match(section, /never falls back to the author's provider/)
})

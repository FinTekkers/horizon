// HZ-183: Accept the code runs the repo's checks on a test-merge of the
// current base + the PR head BEFORE the GitHub merge call, and merges only on
// green, pinned to the head that passed.
//
// Driven through the real Fastify app with inject(): the gate PIN route, the
// WhatsApp concierge route and the WhatsApp poll vote all reach
// performGateApproval, so all three legs are covered. GitHub is a fetch stub
// that records every call; farm/premerge.py is replaced at its one seam,
// premerge.runner (its own behaviour is covered by farm/tests/test_premerge.py
// and server/test/premerge.test.mjs).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-premerge-gate-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
process.env.WA_APPROVAL_SECRET = 'wa-approval-secret-for-premerge-test'
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
process.env.PREMERGE_CHECK_TIMEOUT_MS = '90000'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX, STEPS } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')
const votes = await import('../src/waPollVotes.js')
const { POLL_APPROVE } = await import('../src/waSend.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)

const DAVID = '15550001111@s.whatsapp.net'
const WA_HEADERS = { 'x-wa-approval-secret': config.WA_APPROVAL_SECRET }
const REPO = 'acme/demo'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const MOVED = 'c'.repeat(40)

let seq = 0
function acceptItem() {
  const id = `T-PM-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    REPO,
    100 + seq,
    200 + seq,
  )
  return id
}

const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const eventTexts = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((r) => r.text)

// ---- the GitHub stub: every call recorded; the base tip can move mid-run ----

let gh
function resetGithub() {
  gh = { calls: [], baseTips: [BASE], headSha: HEAD, prStatus: 200, mergeStatus: 200 }
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    gh.calls.push({ method, path: u.pathname, body: options.body ? JSON.parse(options.body) : undefined })
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
    if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) {
      return json(gh.prStatus, { head: { sha: gh.headSha, ref: 'horizon/t-pm' }, base: { ref: 'main' } })
    }
    if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) {
      const sha = gh.baseTips.length > 1 ? gh.baseTips.shift() : gh.baseTips[0]
      return json(200, { object: { sha } })
    }
    if (method === 'PUT' && u.pathname.endsWith('/merge')) return json(gh.mergeStatus, gh.mergeStatus === 200 ? { merged: true } : { message: 'nope' })
    return json(404, {})
  }
}
const mergeCalls = () => gh.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/merge'))

// ---- the premerge.runner stub ----

let runs
function stubRunner(outcome) {
  runs = []
  premerge.runner.spawn = async (args, opts) => {
    runs.push({ args, opts })
    const out = typeof outcome === 'function' ? await outcome(args) : outcome
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...out }
  }
}
const cliResult = (args, body, code) => ({
  code,
  stdout: JSON.stringify({ head_sha: args[4], base_sha: args[6], ...body }) + '\n',
})
const greenRun = (args) => cliResult(args, { ok: true, merge_sha: 'd'.repeat(40), note: '2 repo check(s) passed' }, 0)
const LONG_TAIL = [
  '[earlier output trimmed — last 40 lines]',
  ...Array.from({ length: 38 }, (_, i) => `farm/tests/test_x.py::test_${i} PASSED`),
  'FAILED farm/tests/test_one_reply_parser.py::test_no_module_under_farm_parses_a_model_reply_itself',
  '1 failed, 812 passed in 61.2s',
].join('\n')
const redRun = (args) =>
  cliResult(args, { ok: false, reason: 'checks_failed', failing_check: '/usr/bin/python3 -m pytest -q', tail: LONG_TAIL }, 1)

beforeEach(() => {
  // HZ-216: a gate_action row left running by an earlier test would answer a
  // later one's Accept with a false 409.
  db.prepare('DELETE FROM gate_action').run()
  resetGithub()
  stubRunner(greenRun)
})

const approve = (id) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve`,
    payload: {},
    headers: { cookie, 'x-human-key': pin },
  })
const approveViaWhatsapp = (id) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve-via-whatsapp`,
    payload: { senderJid: DAVID, sender: 'David' },
    headers: WA_HEADERS,
  })

// ---- metric 1 + 2: red checks — no merge call, gate open, failing check and tail logged ----

test('red checks: 502, the gate stays open, and the merge call never happens', async () => {
  stubRunner(redRun)
  const id = acceptItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 502)
  assert.deepEqual(res.json(), { error: 'pre-merge checks failed: /usr/bin/python3 -m pytest -q', premerge: true })
  assert.equal(cursorOf(id), ACCEPT_GATE_INDEX)
  assert.equal(mergeCalls().length, 0)
  assert.equal(runs.length, 1)
})

test('red checks: the activity log names the failing check and the last lines of its output, read back over the API', async () => {
  stubRunner(redRun)
  const id = acceptItem()
  await approve(id)
  const items = (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })).json()
  const events = (Array.isArray(items) ? items : items.items).find((it) => it.id === id).events
  const failure = events.find((e) => e.text.includes('pre-merge checks failed'))
  assert.ok(failure, 'no failure event')
  assert.match(failure.text, /\/usr\/bin\/python3 -m pytest -q/)
  assert.match(failure.text, /FAILED farm\/tests\/test_one_reply_parser\.py::test_no_module_under_farm_parses_a_model_reply_itself/)
  assert.match(failure.text, /1 failed, 812 passed in 61\.2s/)
  assert.match(failure.text, /is not merged and the gate stays open/)
})

test('the checks run on the PR head and base tip GitHub reported', async () => {
  const id = acceptItem()
  await approve(id)
  const [{ args }] = runs
  assert.deepEqual(args.slice(0, 7), ['-m', 'farm.premerge', REPO, id, HEAD, '--base', BASE])
  assert.equal(args[8], '90', 'the timeout comes from PREMERGE_CHECK_TIMEOUT_MS')
})

// ---- metric 3: green merges the head that passed ----

test('green checks: the merge proceeds, pinned to the head sha that passed', async () => {
  const id = acceptItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal(cursorOf(id), ACCEPT_GATE_INDEX + 1)
  assert.equal(mergeCalls().length, 1)
  assert.deepEqual(mergeCalls()[0].body, { merge_method: 'squash', sha: HEAD })
  const texts = eventTexts(id)
  assert.ok(texts.some((t) => t.startsWith('pre-merge checks passed')))
  assert.ok(texts.some((t) => t.startsWith(`merged PR #`)))
})

test('the PR head moving after the checks (GitHub 409) is a 502 and the gate stays open', async () => {
  gh.mergeStatus = 409
  const id = acceptItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 502)
  assert.match(res.json().error, /the PR head moved while the checks ran — click Accept again/)
  assert.equal(cursorOf(id), ACCEPT_GATE_INDEX)
})

test('the base branch moving while the checks ran blocks the merge — the HZ-154 x HZ-156 window', async () => {
  gh.baseTips = [BASE, MOVED]
  const id = acceptItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 502)
  assert.match(res.json().error, /main moved while the pre-merge checks ran/)
  assert.equal(mergeCalls().length, 0)
  assert.equal(cursorOf(id), ACCEPT_GATE_INDEX)
  assert.ok(eventTexts(id).some((t) => t.includes(`main moved from ${BASE.slice(0, 12)} to ${MOVED.slice(0, 12)}`)))
})

// ---- guardrail: fail closed on anything inconclusive ----

const inconclusive = [
  ['a timeout', { timedOut: true, code: null }],
  ['python missing', { code: null, error: new Error('spawn python3 ENOENT') }],
  ['a crash with no JSON', { code: 1, stdout: '', stderr: 'Traceback (most recent call last):\nKeyError' }],
  ['exit 0 with ok:false', { code: 0, stdout: JSON.stringify({ ok: false, reason: 'crash' }) }],
  ['empty stdout', { code: 0, stdout: '' }],
]
for (const [name, out] of inconclusive) {
  test(`fail closed: ${name} blocks the merge`, async () => {
    stubRunner(out)
    const id = acceptItem()
    const res = await approve(id)
    assert.equal(res.statusCode, 502)
    assert.equal(res.json().premerge, true)
    assert.equal(mergeCalls().length, 0)
    assert.equal(cursorOf(id), ACCEPT_GATE_INDEX)
  })
}

for (const [name, setup] of [
  ['the PR cannot be read', () => (gh.prStatus = 404)],
  ['the PR has no head sha', () => (gh.headSha = undefined)],
]) {
  test(`fail closed: ${name} — no check run, no merge`, async () => {
    setup()
    const id = acceptItem()
    const res = await approve(id)
    assert.equal(res.statusCode, 502)
    assert.equal(runs.length, 0)
    assert.equal(mergeCalls().length, 0)
    assert.equal(cursorOf(id), ACCEPT_GATE_INDEX)
  })
}

// ---- guardrail: tell the user it is running; a second click is refused ----

test('the "checks running" event is logged before the run finishes', async () => {
  const id = acceptItem()
  let seenDuringRun = null
  stubRunner((args) => {
    seenDuringRun = eventTexts(id)
    return greenRun(args)
  })
  await approve(id)
  assert.ok(seenDuringRun.some((t) => t.startsWith("running the repo's checks on a test-merge of main + PR #") && t.includes("don't click Accept again")))
})

test('a second Accept while the checks run gets 409 and starts no second run', async () => {
  const id = acceptItem()
  let release
  const gate = new Promise((resolve) => (release = resolve))
  stubRunner(async (args) => {
    await gate
    return greenRun(args)
  })
  const first = approve(id)
  while (runs.length === 0) await new Promise((r) => setImmediate(r))
  const second = await approve(id)
  assert.equal(second.statusCode, 409)
  assert.deepEqual(second.json(), { error: 'pre-merge checks are already running for this item — wait for them to finish', premerge: true })
  release()
  assert.equal((await first).statusCode, 200)
  assert.equal(runs.length, 1)
  assert.equal(mergeCalls().length, 1)
})

// ---- the other two approve legs ----

test('WhatsApp concierge approve: red checks are a 502 and no merge call', async () => {
  stubRunner(redRun)
  const id = acceptItem()
  const res = await approveViaWhatsapp(id)
  assert.equal(res.statusCode, 502)
  assert.match(res.json().error, /pre-merge checks failed/)
  assert.equal(mergeCalls().length, 0)
  assert.equal(cursorOf(id), ACCEPT_GATE_INDEX)
})

test('WhatsApp poll vote: red checks leave the vote retakeable and issue no merge call', async () => {
  stubRunner(redRun)
  const id = acceptItem()
  const pollId = votes.registerPoll({ itemId: id, stepIndex: ACCEPT_GATE_INDEX, recipient: DAVID, question: `${id} — ${STEPS[ACCEPT_GATE_INDEX].label}` })
  votes.attachPollMessageId(pollId, `MSG-PM-${id}`)
  const vote = (voteId) =>
    app.inject({
      method: 'POST',
      url: '/api/wa/poll-vote',
      payload: { voteId, pollMessageId: `MSG-PM-${id}`, voterJid: DAVID, selectedOption: POLL_APPROVE },
      headers: WA_HEADERS,
    })

  const red = await vote(`V-PM-${id}-1`)
  assert.equal(red.statusCode, 502)
  assert.equal(mergeCalls().length, 0)
  assert.equal(cursorOf(id), ACCEPT_GATE_INDEX)

  stubRunner(greenRun)
  const green = await vote(`V-PM-${id}-2`)
  assert.equal(green.statusCode, 200)
  assert.equal(mergeCalls().length, 1)
  assert.equal(cursorOf(id), ACCEPT_GATE_INDEX + 1)
})

// ---- HZ-216: the gate action is server state, visible to every client ----

const gateActionOf = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  return res.json().items.find((it) => it.id === id).gateAction
}

// Holds the check run open until release(); resolves once it has started.
function holdRunner(outcome = greenRun) {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  stubRunner(async (args) => {
    await gate
    return outcome(args)
  })
  return {
    release,
    started: async () => {
      while (runs.length === 0) await new Promise((r) => setImmediate(r))
    },
  }
}

const pollVote = (id) => {
  const pollId = votes.registerPoll({ itemId: id, stepIndex: ACCEPT_GATE_INDEX, recipient: DAVID, question: `${id} — ${STEPS[ACCEPT_GATE_INDEX].label}` })
  votes.attachPollMessageId(pollId, `MSG-GA-${id}`)
  return app.inject({
    method: 'POST',
    url: '/api/wa/poll-vote',
    payload: { voteId: `V-GA-${id}`, pollMessageId: `MSG-GA-${id}`, voterJid: DAVID, selectedOption: POLL_APPROVE },
    headers: WA_HEADERS,
  })
}

for (const [leg, start] of [
  ['the browser route', approve],
  ['the WhatsApp concierge', approveViaWhatsapp],
  ['a WhatsApp poll vote', pollVote],
]) {
  test(`HZ-216: an Accept via ${leg} shows gateAction running in GET /api/items, with a server-side startedAt`, async () => {
    const id = acceptItem()
    const pr = db.prepare('SELECT pr FROM work_item WHERE id = ?').get(id).pr
    assert.equal(await gateActionOf(id), null, 'no gate action before the click')
    const held = holdRunner()
    const pending = start(id)
    await held.started()

    const during = await gateActionOf(id)
    assert.equal(during.kind, 'premerge')
    assert.equal(during.state, 'running')
    assert.equal(during.detail, `running checks on main + PR #${pr}`)
    assert.ok(!Number.isNaN(Date.parse(during.since)), 'since is an ISO timestamp')
    assert.ok(Date.parse(during.deadline) > Date.parse(during.since))
    // A reload reads the same row: the same startedAt.
    assert.equal((await gateActionOf(id)).since, during.since)

    held.release()
    assert.equal((await pending).statusCode, 200)
    const after = await gateActionOf(id)
    assert.equal(after.state, 'merged')
    assert.equal(after.since, during.since)
  })
}

test('HZ-216: red checks finish the row as blocked, naming the failing check — never its output', async () => {
  stubRunner(redRun)
  const id = acceptItem()
  await approve(id)
  const action = await gateActionOf(id)
  assert.equal(action.state, 'blocked')
  assert.equal(action.failingCheck, '/usr/bin/python3 -m pytest -q')
  assert.ok(action.finishedAt)
  assert.doesNotMatch(JSON.stringify(action), /FAILED farm\/tests|812 passed/)
})

test('HZ-216: a check run that times out finishes the row as timed_out with its own reason', async () => {
  stubRunner({ timedOut: true, code: null })
  const id = acceptItem()
  await approve(id)
  const action = await gateActionOf(id)
  assert.equal(action.state, 'timed_out')
  assert.match(action.reason, /^pre-merge checks did not finish: no result within/)
  assert.notEqual(action.reason, store.GATE_ACTION_EXPIRED_REASON)
})

test('HZ-216: the runner rejecting is a 502, the row ends failed with a reason, and a retry is not a 409', async () => {
  premerge.runner.spawn = async () => {
    throw new Error('spawn exploded')
  }
  const id = acceptItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 502)
  assert.deepEqual(Object.keys(res.json()).sort(), ['error', 'premerge'])
  assert.equal(mergeCalls().length, 0)
  const action = await gateActionOf(id)
  assert.equal(action.state, 'failed')
  assert.ok(action.reason)

  stubRunner(greenRun)
  assert.equal((await approve(id)).statusCode, 200)
})

test('HZ-216: the merge call throwing is a 502, the row ends failed with a reason, and a retry is not a 409', async () => {
  const id = acceptItem()
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    if ((options.method || 'GET') === 'PUT') throw new Error('socket hang up')
    return realFetch(url, options)
  }
  const res = await approve(id)
  assert.equal(res.statusCode, 502)
  assert.deepEqual(Object.keys(res.json()), ['error'])
  assert.equal(cursorOf(id), ACCEPT_GATE_INDEX)
  const action = await gateActionOf(id)
  assert.equal(action.state, 'failed')
  assert.match(action.reason, /merge failed/)

  globalThis.fetch = realFetch
  assert.equal((await approve(id)).statusCode, 200)
})

test('HZ-216: a blocked result is not shown again after the item is sent back and returns to the gate', async () => {
  stubRunner(redRun)
  const id = acceptItem()
  await approve(id)
  assert.equal((await gateActionOf(id)).state, 'blocked')

  store.requestChanges(id, 'Accept the code', 'fix the test', 'You')
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, id)
  assert.equal(await gateActionOf(id), null)
})

test('HZ-216: a merge whose gate advance is refused re-opens the gate rather than leaving it stuck', async () => {
  const { getActiveProjectId, setSetting } = await import('../src/settings.js')
  const before = getActiveProjectId()
  const id = acceptItem()
  const mine = store.createProject(`Mine ${id}`).id
  const other = store.createProject(`Other ${id}`).id
  db.prepare('UPDATE work_item SET project_id = ? WHERE id = ?').run(mine, id)
  setSetting('active_project_id', String(mine))
  store.setProjectEnabled(mine, true)
  try {
    const held = holdRunner()
    const pending = approve(id)
    await held.started()
    // The project is disabled mid-check (HZ-207: switching the board away no
    // longer does it): approveGate refuses with project_not_active.
    store.setProjectEnabled(mine, false)
    held.release()
    assert.notEqual((await pending).statusCode, 200)
    assert.equal(cursorOf(id), ACCEPT_GATE_INDEX)
    // Back on its own project, the board shows a finished row: nothing left
    // running to disable the gate.
    store.setProjectEnabled(mine, true)
    assert.equal((await gateActionOf(id)).state, 'merged')
  } finally {
    if (before == null) db.prepare("DELETE FROM setting WHERE key = 'active_project_id'").run()
    else setSetting('active_project_id', String(before))
  }
})

test('HZ-216: a merge is shown on the done Accept step, but not when the item later returns to the gate', async () => {
  const id = acceptItem()
  assert.equal((await approve(id)).statusCode, 200)
  assert.equal((await gateActionOf(id)).state, 'merged')

  store.restartPhase(id, STEPS[ACCEPT_GATE_INDEX].phase, 'rebuild it', 'You')
  assert.equal(await gateActionOf(id), null, 'not on the upcoming gate while it is rebuilt')
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES (?, ?, 'Eng', 'done')").run(id, ACCEPT_GATE_INDEX - 1)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, id)
  assert.equal(await gateActionOf(id), null, 'not on a later visit to the gate')
})

// ---- HZ-245: the repo's Admin-configured check commands reach the CLI ----

test('HZ-245: Accept passes the stored check commands as --check-commands; an unconfigured repo gets no flag', async () => {
  // Rows written directly: createProject/addRepoToProject would also move the
  // active project and purge demo items, which other tests here rely on.
  const projectId = db.prepare("INSERT INTO project (name, enabled) VALUES ('HZ-245 checks', 1)").run().lastInsertRowid
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, 'AD')").run(projectId, REPO)
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/plain', 'AP')").run(projectId)
  try {
    const stored = { install: 'npm install --ignore-scripts', test: ' npm test ', lint: '', e2e: null }
    store.setRepoCheckCommands(projectId, REPO, stored)

    const id = acceptItem()
    assert.equal((await approve(id)).statusCode, 200)
    const { args } = runs.at(-1)
    const at = args.indexOf('--check-commands')
    assert.ok(at > 0, `no --check-commands in ${JSON.stringify(args)}`)
    assert.deepEqual(JSON.parse(args[at + 1]), { install: 'npm install --ignore-scripts', test: ' npm test ', lint: null, e2e: null })
    assert.equal(at + 2, args.length, 'one flag, one JSON value')
    const envValues = Object.values(runs.at(-1).opts.env ?? {})
    assert.ok(!envValues.some((v) => String(v).includes('--ignore-scripts')), 'argv only, never env')

    const plain = acceptItem()
    db.prepare("UPDATE work_item SET repo = 'acme/plain' WHERE id = ?").run(plain)
    stubRunner(greenRun)
    assert.equal((await approve(plain)).statusCode, 200)
    assert.equal(runs.at(-1).args.includes('--check-commands'), false)
  } finally {
    db.prepare('DELETE FROM project_repo WHERE project_id = ?').run(projectId)
    db.prepare('DELETE FROM project WHERE id = ?').run(projectId)
  }
})

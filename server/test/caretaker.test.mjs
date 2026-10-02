// HZ-270 metrics 2, 3, 4, 6 and 7: the caretaker sweep against a real
// database, with the real role file.
//
// fetch is replaced BEFORE any server module loads, by a recorder that fails
// every call — it is the stubbed GitHub client (github.js and waSend.js both
// reach the network only through global fetch). deploy.js's runner.spawn is
// wrapped the same way, so "no child process" is checked, not assumed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fetchCalls = []
globalThis.fetch = async (...args) => {
  fetchCalls.push(args)
  throw new Error('caretaker test: no network')
}

const dir = mkdtempSync(join(tmpdir(), 'horizon-caretaker-'))
process.env.HORIZON_DB = join(dir, 'test.db')
process.env.HOME = join(dir, 'home')
process.env.HORIZON_DEPLOY_TARGETS_FILE = join(dir, 'deploy-targets.json')
writeFileSync(
  process.env.HORIZON_DEPLOY_TARGETS_FILE,
  JSON.stringify(
    ['shadowed', 'late', 'failing', 'quiet'].map((key) => ({ key, repo: `Acme/${key}`, stateKey: key, script: 'x.sh', service: 'x' })),
  ),
)
mkdirSync(join(process.env.HOME, '.horizon', 'shadowed'), { recursive: true })
// The format deploy-horizon.sh writes: "refs/tags/<tag>:<commit>".
writeFileSync(join(process.env.HOME, '.horizon', 'shadowed', 'last-good-tag'), 'refs/tags/v2026.10.02-1:abc123\n')
delete process.env.FARM_URL
delete process.env.GITHUB_TOKEN

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const deploy = await import('../src/deploy.js')
const caretaker = await import('../src/caretaker.js')
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')
const { gateStepIndexes } = await import('../../domain/js/lifecycle.js')

const spawnCalls = []
deploy.runner.spawn = (...args) => spawnCalls.push(args)

const fixture = (name) => readFileSync(join(REPO_ROOT, 'server/test/fixtures/caretaker', name), 'utf8')
const silent = { warn() {}, error() {} }
const sweep = (opts = {}) => caretaker.sweepCaretaker({ log: silent, ...opts })

const project = (name, autopilot) => {
  const id = Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(name).lastInsertRowid)
  db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(autopilot, id)
  return id
}
const doneRun = (itemId, stepIndex, artifact) =>
  Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output, artifact) VALUES (?, ?, 'x', 'done', ?, ?)")
      .run(itemId, stepIndex, String(artifact).slice(0, 80), artifact).lastInsertRowid,
  )
const item = (id, projectId, cursor, extra = {}) => {
  db.prepare(
    `INSERT INTO work_item (id, title, priority, cursor, project_id, repo, pr_mergeable, release_tag)
     VALUES (?, ?, 'High', ?, ?, 'Acme/shadowed', ?, ?)`,
  ).run(id, `fixture ${id}`, cursor, projectId, extra.pr_mergeable ?? null, extra.release_tag ?? null)
}
// One item per caretaker gate, each fed by a real-looking source run.
const seedAllGates = (prefix, projectId) => {
  item(`${prefix}-5`, projectId, 5)
  doneRun(`${prefix}-5`, 4, fixture('hz270-options.md'))
  item(`${prefix}-10`, projectId, 10)
  doneRun(`${prefix}-10`, 9, fixture('hz270-pm-summary.md'))
  item(`${prefix}-13`, projectId, 13, { pr_mergeable: 1 })
  doneRun(`${prefix}-13`, 12, 'automated review passed — code and QA both clear')
  item(`${prefix}-15`, projectId, 15, { release_tag: 'v2026.10.02-1' })
  doneRun(`${prefix}-15`, 14, 'published release v2026.10.02-1 — the self-deploy webhook will pull it to shoreward.ai')
  return [5, 10, 13, 15].map((g) => `${prefix}-${g}`)
}
const caretakerEvents = (itemId) =>
  db.prepare("SELECT * FROM event WHERE item_id = ? AND who = 'Caretaker' ORDER BY id").all(itemId)
const evals = (itemId) => db.prepare('SELECT * FROM caretaker_eval WHERE item_id = ? ORDER BY id').all(itemId)

const PHRASES = ['approve', 'send back with comment', 'resolve conflicts', 'wait', 'ping the human']
const EVENT_RE = new RegExp(`^caretaker would (${PHRASES.join('|')}) — (.+)$`)

test('CARETAKER_GATES is exactly [5, 10, 13, 15]: gate 3 is excluded in code', () => {
  assert.deepEqual(gateStepIndexes(), [3, 5, 10, 13, 15], 'sanity: the gate set moved')
  assert.deepEqual(caretaker.CARETAKER_GATES, [5, 10, 13, 15])
})

const SHADOW = project('Shadowed', 'shadow')
const shadowItems = seedAllGates('SH', SHADOW)

test('shadow: an item at each of gates 5, 10, 13 and 15 gets exactly one well-formed caretaker event', () => {
  sweep()
  const expected = { 'SH-5': 'approve', 'SH-10': 'send back with comment', 'SH-13': 'approve', 'SH-15': 'approve' }
  for (const id of shadowItems) {
    const events = caretakerEvents(id)
    assert.equal(events.length, 1, id)
    const match = EVENT_RE.exec(events[0].text)
    assert.ok(match, `malformed event text: ${events[0].text}`)
    assert.equal(match[1], expected[id], id)
    assert.ok(!match[2].includes('\n'), 'the reason must be one line')
    const [row] = evals(id)
    assert.equal(row.event_id, events[0].id)
    assert.equal(row.mode, 'shadow')
  }
  // The full send-back comment lives on the decision row, not the event.
  assert.match(evals('SH-10')[0].comment, /pick a real gate 15 fact/)
})

test('re-running the sweep adds no second event', () => {
  sweep()
  sweep()
  for (const id of shadowItems) assert.equal(caretakerEvents(id).length, 1, id)
})

test('shadow -> off -> shadow at the same arrival still gives one event', () => {
  store.setProjectAutopilot(SHADOW, 'off', 'test')
  sweep()
  store.setProjectAutopilot(SHADOW, 'shadow', 'test')
  sweep()
  for (const id of shadowItems) assert.equal(caretakerEvents(id).length, 1, id)
})

test('a send-back re-arrival (a new source run) is judged again: a second event', () => {
  db.prepare('UPDATE work_item SET cursor = 9 WHERE id = ?').run('SH-10')
  sweep()
  assert.equal(caretakerEvents('SH-10').length, 1)
  doneRun('SH-10', 9, '## Recommendation\n**PROCEED** — revised plan is fine.\n')
  db.prepare('UPDATE work_item SET cursor = 10 WHERE id = ?').run('SH-10')
  sweep()
  const events = caretakerEvents('SH-10')
  assert.equal(events.length, 2)
  assert.equal(events[1].text, 'caretaker would approve — PM said PROCEED')
})

test('off: items at every gate get no caretaker rows and no events', () => {
  const off = project('Switched off', 'off')
  const ids = [...seedAllGates('OFF', off), 'OFF-3']
  item('OFF-3', off, 3)
  sweep()
  for (const id of ids) {
    assert.equal(caretakerEvents(id).length, 0, id)
    assert.equal(evals(id).length, 0, id)
  }
})

test('gate 3 never gets a caretaker event in off, shadow or on', () => {
  const policy = caretaker.loadPolicy()
  for (const mode of ['off', 'shadow', 'on']) {
    const pid = project(`Gate three ${mode}`, mode)
    item(`G3-${mode}`, pid, 3)
    doneRun(`G3-${mode}`, 2, '## Recommendation\n**PROCEED**\n')
    sweep()
    assert.equal(caretakerEvents(`G3-${mode}`).length, 0, mode)
    assert.equal(evals(`G3-${mode}`).length, 0, mode)
    assert.equal(caretaker.evaluateArrival({ id: `G3-${mode}`, cursor: 3 }, 3, policy), null)
  }
})

test("on behaves like shadow: same decisions and reasons, and it acts on nothing", () => {
  const on = project('Turned on', 'on')
  const onItems = seedAllGates('ON', on)
  sweep()
  for (const [i, id] of onItems.entries()) {
    const [mine] = evals(id)
    const [theirs] = evals(shadowItems[i])
    assert.equal(mine.mode, 'on')
    assert.equal(mine.decision, theirs.decision, id)
    assert.equal(mine.reason, theirs.reason, id)
    assert.equal(caretakerEvents(id).length, 1)
  }
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'ON-5'").get().cursor, 5)
})

// ---- gate 15: the deploy lands after the arrival ----

const stateDir = (key) => {
  const d = join(process.env.HOME, '.horizon', key)
  mkdirSync(d, { recursive: true })
  return d
}
const releaseItem = (id, repoKey, tag, endedAgo = '0 minutes') => {
  const pid = project(`Release ${id}`, 'shadow')
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, project_id, repo, release_tag) VALUES (?, ?, 'High', 15, ?, ?, ?)",
  ).run(id, `fixture ${id}`, pid, `Acme/${repoKey}`, tag)
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, agent, status, output, ended_at) VALUES (?, 14, 'DevOps', 'done', ?, datetime('now', ?))",
  ).run(id, `published release ${tag} — the self-deploy webhook will pull it to shoreward.ai`, `-${endedAgo}`)
}
const isoNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

test('gate 15: nothing is recorded until the webhook deploy lands, then it approves', () => {
  releaseItem('LT-15', 'late', 'v2026.10.02-2')
  sweep()
  assert.equal(evals('LT-15').length, 0, 'judged before the deploy settled')
  const dir = stateDir('late')
  writeFileSync(join(dir, 'self-deploy.log'), `${isoNow()} DEPLOY OK tag=refs/tags/v2026.10.02-2 commit=def456\n`)
  writeFileSync(join(dir, 'last-good-tag'), 'refs/tags/v2026.10.02-2:def456\n')
  sweep()
  const events = caretakerEvents('LT-15')
  assert.equal(events.length, 1)
  assert.match(events[0].text, /^caretaker would approve — release v2026\.10\.02-2 /)
})

test('gate 15: a failed deploy logged after the arrival pings the human', () => {
  releaseItem('LF-15', 'failing', 'v2026.10.02-3')
  sweep()
  assert.equal(evals('LF-15').length, 0)
  const dir = stateDir('failing')
  writeFileSync(join(dir, 'self-deploy.log'), `${isoNow()} DEPLOY FAILED: health-check (tag=refs/tags/v2026.10.02-3 commit=abc)\n`)
  sweep()
  const [row] = evals('LF-15')
  assert.equal(row.decision, 'ping_human')
  assert.equal(caretakerEvents('LF-15').length, 1)
})

test('gate 15: a deploy that never reports is judged after the settle window', () => {
  releaseItem('LQ-15', 'quiet', 'v2026.10.02-4', `${caretaker.RELEASE_SETTLE_MS / 60000 + 1} minutes`)
  sweep()
  assert.equal(evals('LQ-15')[0].decision, 'ping_human')
})

// ---- metric 3: read-only ----

const TABLES = ['work_item', 'step_run', 'gate_action', 'gate_decision', 'gate_notice', 'gate_poll', 'feedback']
const snapshotTables = () => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]))

for (const mode of ['shadow', 'on']) {
  test(`${mode}: evaluating changes no item, gate or outbox state and makes no GitHub call or spawn`, () => {
    const pid = project(`Read only ${mode}`, mode)
    const ids = seedAllGates(`RO-${mode}`, pid)
    item(`RO-${mode}-13c`, pid, 13, { pr_mergeable: 0 })
    doneRun(`RO-${mode}-13c`, 12, 'automated review passed')
    const before = snapshotTables()
    const fetchesBefore = fetchCalls.length
    const { recorded } = sweep()
    assert.equal(recorded, 5)
    assert.deepEqual(snapshotTables(), before)
    assert.equal(fetchCalls.length, fetchesBefore)
    assert.equal(fetchCalls.length, 0, 'the stubbed GitHub client recorded a call')
    assert.equal(spawnCalls.length, 0, 'a child process was spawned')
    assert.equal(evals(`RO-${mode}-13c`)[0].decision, 'resolve_conflicts')
    for (const id of ids) assert.equal(caretakerEvents(id).length, 1)
  })
}

test('the caretaker modules import no client that can act', () => {
  const BANNED = ['github', 'orchestrator', 'premerge', 'autoResolve', 'waSend', 'waPollVotes', 'gateNotifier', 'child_process']
  for (const file of ['server/src/caretaker.js', 'server/src/caretakerRules.js']) {
    const imports = [...readFileSync(join(REPO_ROOT, file), 'utf8').matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    assert.ok(imports.length > 0, file)
    for (const spec of imports) {
      assert.ok(!BANNED.some((b) => spec.includes(b)), `${file} imports ${spec}`)
    }
  }
})

// ---- guardrails: secrets and errors ----

test('a token quoted in an artifact never reaches the event text or the decision row', () => {
  process.env.GITHUB_TOKEN = 'tok123secret'
  try {
    const pid = project('Leaky', 'shadow')
    item('LK-5', pid, 5)
    doneRun('LK-5', 4, `${fixture('hz270-options.md')}\n## Blockers\n- the deploy used tok123secret in a URL\n`)
    sweep()
    const [event] = caretakerEvents('LK-5')
    const [row] = evals('LK-5')
    assert.equal(row.decision, 'send_back')
    for (const text of [event.text, row.reason, row.comment]) {
      assert.ok(!text.includes('tok123secret'), text)
      assert.match(text, /\[redacted\]/)
    }
  } finally {
    delete process.env.GITHUB_TOKEN
  }
})

test('an evaluator error records one wait event with the error as the reason', () => {
  const pid = project('Erroring', 'shadow')
  item('ER-13', pid, 13)
  doneRun('ER-13', 12, 'review')
  const broken = () => ({ rules: [{ id: 'g13.wait', gateIndex: 13, decision: 'wait', kinds: null }] })
  sweep({ policy: broken })
  sweep({ policy: broken })
  const events = caretakerEvents('ER-13')
  assert.equal(events.length, 1)
  assert.match(events[0].text, /^caretaker would wait — caretaker error: /)
})

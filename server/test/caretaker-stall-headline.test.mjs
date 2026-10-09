// HZ-366 metric 4: when Autopilot stops because the step before a gate failed
// twice on its checks, the owner's ping names what failed — the farm's
// headline line — straight after the item and step. The failure text is the
// one farm/tests/test_checks_headline.py proves the farm builds from HZ-365's
// real output, so a change to the farm's wording fails here too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

globalThis.fetch = async () => {
  throw new Error('caretaker-stall-headline test: no network')
}

const OWNER_NUMBER = '15550001111'
const SECRET = 'tok123secret'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-stall-headline-')), 'test.db')
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'CARETAKER_HOURLY_LIMIT']) delete process.env[key]
Object.assign(process.env, { WA_NOTIFY_ENABLED: '1', WA_APPROVER_JIDS: OWNER_NUMBER, GITHUB_TOKEN: SECRET })

const { db } = await import('../src/db.js')
const actor = await import('../src/caretakerActor.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')

const MESSAGE = readFileSync(join(REPO_ROOT, 'farm/tests/fixtures/check_output/hz365_message.txt'), 'utf8')
const HEADLINE = MESSAGE.split('\n')[0]
const GATE = 10
const silent = { info() {}, warn() {}, error() {} }
const sent = []
const tick = () =>
  actor.actOnDecisions({
    gateActions: { approve: async () => ({ ok: true }), sendBack: async () => ({ ok: true }) },
    log: silent,
    now: () => Date.parse('2026-10-09T12:00:00Z'),
    send: async (to, body) => sent.push({ to, body }),
  })

const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Stall', 1)").run().lastInsertRowid)
db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(projectId)

// Two failed runs of the step feeding the gate (the newest last), then the
// arrival at the gate with an 'approve' decision the stall stops.
function stalledItem(id, outputs) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, ?, 'High', ?, ?)").run(id, `Fix ${id}`, GATE, projectId)
  for (const output of outputs) {
    db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, ?, 'x', 'cancelled', ?)").run(id, GATE - 1, output)
  }
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, ?, 'x', 'done', 'fixture')")
    .run(id, GATE - 1).lastInsertRowid
  db.prepare("INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, reason) VALUES (?, ?, ?, 'on', 'approve', 'r')").run(
    id,
    GATE,
    runId,
  )
}

test('the farm fixture starts with the prefix the caretaker reads', () => {
  assert.ok(HEADLINE.startsWith(actor.CHECK_HEADLINE_PREFIX), HEADLINE)
  assert.match(HEADLINE, /2 failed/)
})

test('a step that failed twice on its checks pings the headline right after the step, secrets redacted', async () => {
  const planted = MESSAGE.replace('\n', ` ${SECRET}\n`)
  stalledItem('SH-1', ['FAILED: agent exited', `FAILED: ${planted}`])

  await tick()

  const prefix = `Horizon caretaker stopped on SH-1 at ${STEPS[GATE].label}: `
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body, `${prefix}${HEADLINE} [redacted] — the step before this gate has failed twice. Waiting for you.`)
  assert.ok(!sent[0].body.includes(SECRET))
  // The event and the dedupe are as before.
  const ping = db.prepare("SELECT reason, body FROM caretaker_ping WHERE item_id = 'SH-1'").get()
  assert.equal(ping.reason, 'step_failed_twice')
  assert.equal(ping.body, sent[0].body)
})

test('the newest failed run decides: a non-check failure there adds no headline, even with an older one', async () => {
  sent.length = 0
  stalledItem('SH-2', [`FAILED: ${MESSAGE}`, 'FAILED: agent exited'])

  await tick()

  assert.deepEqual(
    sent.map((s) => s.body),
    [`Horizon caretaker stopped on SH-2 at ${STEPS[GATE].label}: the step before this gate has failed twice. Waiting for you.`],
  )
})

test('stallHeadline reads only a headline-shaped first line', () => {
  assert.equal(actor.stallHeadline(`FAILED: ${MESSAGE}`), HEADLINE)
  assert.equal(actor.stallHeadline('FAILED: repo checks failed (sh -c npm test):\nnot ok 1 - x'), null)
  assert.equal(actor.stallHeadline(null), null)
})

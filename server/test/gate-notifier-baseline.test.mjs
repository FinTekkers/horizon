// HZ-141's schema-level safety net. Three things the architecture and QA
// reviews each called blocking, none of which the feature's own tests would
// catch, because all three are about what happens around the outbox rather than
// inside it:
//
//   G3. purgeDemoItems() deletes work_item rows directly with foreign_keys = ON
//       and hand-enumerates the children to clear. A child table missing from
//       that list turns demo-item cleanup — a live path, called whenever GitHub
//       sync connects — into an FK constraint error. gate_notice declares
//       ON DELETE CASCADE so it cannot be forgotten there; this asserts it.
//   G4. SEED_ITEMS parks demo items on ALL FIVE gates, and the seed runs at the
//       END of db.js. A baseline placed before it would leave every seeded item
//       un-baselined, so the first sweep on a fresh dev box with the notifier on
//       would fire five demo notifications.
//   G5. A comment asking the next cursor-shift author to re-baseline is not a
//       gate. baselineNotifiedStep() is exported so there is a function to call,
//       and this file is the red test they get if they do not.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { REPO_ROOT } from './helpers/repoFiles.mjs'

const DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-gatenotify-base-')), 'test.db')
process.env.HORIZON_DB = DB_PATH
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'

const { db, baselineNotifiedStep } = await import('../src/db.js')
const store = await import('../src/store.js')
const notifier = await import('../src/gateNotifier.js')
const { STEPS, gateStepIndexes } = await import('../../domain/js/lifecycle.js')

const GATES = gateStepIndexes()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

// ---- G4: the demo seed must not fire five notifications on a fresh box ----
// A FRESH database in a child process, so this sees db.js's real boot sequence
// end to end — the migrations, the seed, and the one-time baseline — in the
// order a real first boot runs them.

test('a fresh database with the demo seed present enqueues nothing on its first sweep', () => {
  const freshDb = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-gatenotify-seed-')), 'test.db')
  const script = `
    const { db } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/src/db.js'))})
    const { sweepGates } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/src/gateNotifier.js'))})
    const { gateStepIndexes } = await import(${JSON.stringify(path.join(REPO_ROOT, 'domain/js/lifecycle.js'))})
    const gates = gateStepIndexes()
    const placeholders = gates.map(() => '?').join(',')
    const seeded = db.prepare("SELECT COUNT(*) AS n FROM work_item WHERE id LIKE 'BF-%'").get().n
    const seededAtGates = db
      .prepare(\`SELECT COUNT(*) AS n FROM work_item WHERE id LIKE 'BF-%' AND cursor IN (\${placeholders})\`)
      .get(...gates).n
    const result = sweepGates()
    console.log(JSON.stringify({ seeded, seededAtGates, enqueued: result.enqueued }))
  `
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    // No HORIZON_REPO: the seed only runs when GitHub sync is unconfigured.
    env: { ...process.env, HORIZON_DB: freshDb, HORIZON_REPO: '', WA_APPROVER_JIDS: '15550001111@s.whatsapp.net' },
  })
  assert.equal(res.status, 0, `child failed:\n${res.stdout}${res.stderr}`)
  const out = JSON.parse(res.stdout.trim().split('\n').at(-1))

  // The premise of the test, asserted rather than assumed: the seed really does
  // park demo items on gates. Without this the "enqueued: 0" below could pass
  // simply because nothing was seeded.
  assert.ok(out.seeded > 0, 'the demo seed did not run — this test proves nothing')
  assert.equal(out.seededAtGates, 5, `the seed parks ${out.seededAtGates} items at gates, expected 5`)
  assert.equal(out.enqueued, 0, `a fresh box would have sent ${out.enqueued} demo notification(s)`)
})

// ---- G3: purgeDemoItems and the foreign key ----

test('purgeDemoItems succeeds with outbox rows present, and leaves no orphans', async () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    'BF-999',
    'A demo item parked at a gate',
    'Low',
    GATES[0],
  )
  notifier.sweepGates()
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gate_notice WHERE item_id = 'BF-999'").get().n, 1)
  // A sent row and a pending row, so the cascade is not only tested on one status.
  db.prepare('INSERT INTO gate_notice (item_id, step_index, recipient, body, status) VALUES (?, ?, ?, ?, ?)').run(
    'BF-999',
    GATES[0],
    '15550001111@s.whatsapp.net',
    'body',
    'sent',
  )
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'the FK pragma is off — this test cannot fail')

  store.purgeDemoItems() // must not throw an FK constraint error

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_item WHERE id = 'BF-999'").get().n, 0)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gate_notice WHERE item_id = 'BF-999'").get().n,
    0,
    'gate_notice rows outlived the work_item they belong to',
  )
})

// ---- G5: the re-baseline helper a future cursor shift must call ----

test('baselineNotifiedStep marks every item at a gate as already notified and clears the rest', () => {
  const atGate = GATES[1]
  const agentStep = STEPS.findIndex((s) => s.kind === 'agent')
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run('T-B1', 'At a gate', 'High', atGate)
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, notified_step) VALUES (?, ?, ?, ?, ?)').run(
    'T-B2',
    'Mid-agent-step but stale-marked',
    'High',
    agentStep,
    GATES[0],
  )

  baselineNotifiedStep(db)()

  assert.equal(db.prepare("SELECT notified_step FROM work_item WHERE id = 'T-B1'").get().notified_step, atGate)
  assert.equal(db.prepare("SELECT notified_step FROM work_item WHERE id = 'T-B2'").get().notified_step, null)
})

test('a re-baseline after a simulated cursor shift sends nothing; without it, it would', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM gate_notice').get().n

  // The shape of both pipeline_v2_shift and pipeline_v3_review_shift: every
  // cursor at or past an inserted index moves by one. An item parked at a gate
  // whose index shifted keeps a notified_step pointing at the OLD index.
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, notified_step) VALUES (?, ?, ?, ?, ?)').run(
    'T-SHIFT',
    'Survived a cursor shift',
    'High',
    GATES[2],
    GATES[2],
  )
  notifier.sweepGates()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gate_notice').get().n, before, 'baseline state should be quiet')

  // Shift it the way a migration would, WITHOUT re-baselining.
  db.prepare("UPDATE work_item SET cursor = ? WHERE id = 'T-SHIFT'").run(GATES[3])
  const unbaselined = notifier.sweepGates()
  assert.ok(unbaselined.enqueued > 0, 'a shift with no re-baseline must look like a fresh arrival — that is the hazard')
  db.prepare("DELETE FROM gate_notice WHERE item_id = 'T-SHIFT'").run()

  // Now the same shift WITH the re-baseline the migration is required to call.
  db.prepare("UPDATE work_item SET cursor = ?, notified_step = ? WHERE id = 'T-SHIFT'").run(GATES[2], GATES[2])
  db.prepare("UPDATE work_item SET cursor = ? WHERE id = 'T-SHIFT'").run(GATES[3])
  baselineNotifiedStep(db)()
  const baselined = notifier.sweepGates()
  assert.equal(baselined.enqueued, 0, 'baselineNotifiedStep did not absorb the shift')
})

test('the one-time baseline is guarded by a setting, so a second boot does not re-run it', () => {
  assert.equal(db.prepare("SELECT value FROM setting WHERE key = 'gate_notice_baseline'").get()?.value, 'done')
})

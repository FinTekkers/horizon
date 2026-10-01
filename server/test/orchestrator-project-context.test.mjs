// HZ-204 (HZ-115 Stage 1): a PM-lane dispatch carries `project_context` — the
// explicit replacement for the PM session's memory. These pin which rows the
// server selects; farm/tests/test_pm_project_context.py pins how the farm
// renders and caps them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-pmctx-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const dispatches = []
globalThis.fetch = async (url, opts) => {
  dispatches.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  return { ok: true, json: async () => ({}) }
}
orchestrator.init({ info: () => {}, warn: () => {} })

const PM_STEP_INDEX = STEPS.findIndex((s) => s.runsIn === 'pm')

const insertItem = db.prepare(
  `INSERT INTO work_item (id, title, priority, "desc", cursor, project_id, rejected, abandoned_at, updated_at)
   VALUES (?, ?, 'Medium', ?, ?, ?, ?, ?, ?)`,
)
function item(id, { project = 1, cursor = 3, rejected = 0, abandoned = null, updated = '2026-09-01 00:00:00', desc = '' } = {}) {
  insertItem.run(id, `Title ${id}`, desc, cursor, project, rejected, abandoned, updated)
}
const insertFeedback = db.prepare(
  'INSERT INTO feedback (item_id, target, message, created_at, delivered_at) VALUES (?, ?, ?, ?, ?)',
)

async function dispatchFor(id) {
  orchestrator.kick(id)
  await new Promise((r) => setTimeout(r, 20))
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === id)
  assert.ok(dispatch, `no /steps/run dispatch captured for ${id}`)
  orchestrator.cancel(id)
  return dispatch
}

test('buildProjectContext selects the 10 newest same-project items, keeping sent-back ones', () => {
  item('P1-CUR', { cursor: 0, updated: '2026-09-30 00:00:00' })
  item('P1-SENTBACK', { rejected: 1, updated: '2026-09-29 00:00:00' })
  item('P1-ABANDONED', { abandoned: '2026-09-28 00:00:00', updated: '2026-09-28 00:00:00' })
  item('P2-OTHER', { project: 2, updated: '2026-09-29 12:00:00' })
  for (let n = 1; n <= 10; n++) item(`P1-${n}`, { updated: `2026-09-${String(n).padStart(2, '0')} 00:00:00` })

  const { items } = orchestrator.buildProjectContext('P1-CUR')
  const ids = items.map((i) => i.id)
  assert.equal(ids.length, 10)
  assert.equal(ids[0], 'P1-SENTBACK') // rejected means "sent back right now", not excluded
  assert.ok(!ids.includes('P1-CUR'), 'the current item is never its own context')
  assert.ok(!ids.includes('P1-ABANDONED'))
  assert.ok(!ids.includes('P2-OTHER'))
  assert.ok(!ids.includes('P1-1'), '11 candidates: the oldest one drops')
  assert.deepEqual(Object.keys(items[0]).sort(), ['desc', 'id', 'title', 'updated_at'])
})

test('buildProjectContext selects the 5 newest delivered PM-lane feedback rows in the project', () => {
  item('F-CUR', { project: 3, cursor: 0 })
  item('F-A', { project: 3 })
  item('F-OTHERPROJ', { project: 4 })
  for (let n = 1; n <= 6; n++) {
    insertFeedback.run('F-A', n % 2 ? 'PM' : 'Architect', `msg ${n}`, `2026-09-0${n} 00:00:00`, '2026-09-30 00:00:00')
  }
  insertFeedback.run('F-A', 'Eng', 'developer target', '2026-09-20 00:00:00', '2026-09-30 00:00:00')
  insertFeedback.run('F-A', 'PM', 'undelivered', '2026-09-21 00:00:00', null)
  insertFeedback.run('F-OTHERPROJ', 'PM', 'other project', '2026-09-22 00:00:00', '2026-09-30 00:00:00')

  const { feedback } = orchestrator.buildProjectContext('F-CUR')
  assert.deepEqual(
    feedback.map((f) => f.message),
    ['msg 6', 'msg 5', 'msg 4', 'msg 3', 'msg 2'],
  )
  assert.deepEqual(Object.keys(feedback[0]).sort(), ['created_at', 'item_id', 'message', 'target'])
})

test('a PM-step dispatch carries project_context; this attempt\'s feedback rides only in `feedback`', async () => {
  item('D-PM', { project: 5, cursor: PM_STEP_INDEX })
  item('D-PM-PEER', { project: 5, desc: 'peer outcome' })
  insertFeedback.run('D-PM', 'PM', 'pending for this attempt', '2026-09-30 00:00:00', null)

  const { body } = await dispatchFor('D-PM')
  assert.deepEqual(body.feedback.map((f) => f.message), ['pending for this attempt'])
  assert.deepEqual(body.project_context.items.map((i) => i.id), ['D-PM-PEER'])
  assert.equal(body.project_context.items[0].desc, 'peer outcome')
  assert.deepEqual(body.project_context.feedback, [])
})

test('a farm-lane dispatch carries no project_context key at all', async () => {
  item('D-FARM', { project: 5, cursor: IMPLEMENT_STEP_INDEX })
  const { body } = await dispatchFor('D-FARM')
  assert.equal('project_context' in body, false)
})

// Intended: items with no project (pre-projects rows, or created before a
// project was picked) form one shared "no project" bucket — the same items the
// retired single PM session saw side by side. They never mix with a real
// project's items, in either direction.
test('project-less items share one context bucket and never mix with a project', () => {
  item('N-CUR', { project: null, cursor: 0 })
  item('N-PEER', { project: null, updated: '2026-09-15 00:00:00' })
  item('N-PROJ', { project: 6, updated: '2026-09-16 00:00:00' })
  insertFeedback.run('N-PEER', 'PM', 'no-project feedback', '2026-09-15 00:00:00', '2026-09-30 00:00:00')

  const nullCtx = orchestrator.buildProjectContext('N-CUR')
  assert.deepEqual(nullCtx.items.map((i) => i.id), ['N-PEER'])
  assert.deepEqual(nullCtx.feedback.map((f) => f.message), ['no-project feedback'])

  const projCtx = orchestrator.buildProjectContext('N-PROJ')
  assert.deepEqual(projCtx.items, [])
  assert.deepEqual(projCtx.feedback, [])
})

// End-to-end proof, in demo/mock mode, that the fail -> re-implement -> pass
// loop is actually exercisable without a real farm/LLM (QA review finding:
// a flat always-pass mock could never drive this, and that's the same class
// of gap that let HZ-21 ship without real e2e coverage). MOCK_REVIEW_FAIL_COUNT
// is read once at import time, so this lives in its own process/file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-review-mock-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '5'
process.env.MOCK_REVIEW_FAIL_COUNT = '2'
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { REVIEW_STEP_INDEX, IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('condition never became true')
}

db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES ('MOCK-CAP', 'Mock review loop', 'Medium', ?)",
).run(REVIEW_STEP_INDEX)
orchestrator.kick('MOCK-CAP')

test('the mock review fails its first 2 cycles then passes, landing at the human gate within the cap', async () => {
  await waitFor(() => store.getItem('MOCK-CAP').cursor === ACCEPT_GATE_INDEX)
  const item = store.getItem('MOCK-CAP')
  assert.equal(item.review_cycle_count, 2) // failed exactly twice before passing
  const attempts = db
    .prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'MOCK-CAP' AND step_index = ?")
    .get(REVIEW_STEP_INDEX).n
  assert.equal(attempts, 3) // 2 failing review attempts + the passing one
  const implementReruns = db
    .prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'MOCK-CAP' AND step_index = ?")
    .get(IMPLEMENT_STEP_INDEX).n
  assert.equal(implementReruns, 2) // implement re-ran once per failure
})

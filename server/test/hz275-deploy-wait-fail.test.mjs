// HZ-275: when the farm's Deploy step finds its release never went live
// (DEPLOY FAILED for the tag, or the wait ran out), it reports a failure whose
// error ends with a bounded, redacted tail of self-deploy.log
// (farm/step_agent.py wait_until_release_live). Driven through the real /fail
// route: the step is failed, the item stops at Deploy, nothing retries on its
// own, and the stored output keeps the tail through to its last line.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-hz275-fail-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here
process.env.FARM_STEP_TIMEOUT_MS = '600000'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { FARM_SHARED_SECRET } = await import('../src/config.js')
const store = await import('../src/store.js')
const { STEPS, DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const app = buildApp({ logger: false })

function activeDeployRun(itemId, issue) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, release_tag) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    itemId,
    'Deploy never went live',
    'Medium',
    DEPLOY_STEP_INDEX,
    'FinTekkers/horizon',
    issue,
    'deploy-hz-275',
  )
  return db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')")
    .run(itemId, DEPLOY_STEP_INDEX, STEPS[DEPLOY_STEP_INDEX].agent).lastInsertRowid
}

// The farm's shape: reason first, then a 20-line, ~1500-char tail.
function farmError(reason) {
  const lines = Array.from(
    { length: 19 },
    (_, i) => `2026-10-03T10:${String(i).padStart(2, '0')}:00Z build step ${i} — npm ci output, still going ......`,
  )
  lines.push('2026-10-03T10:59:00Z DEPLOY FAILED: health-check (tag=refs/tags/deploy-hz-275 commit=abc123) — LAST TAIL LINE')
  return `release deploy-hz-275 did not go live: ${reason}\n--- self-deploy.log (last 20 lines, redacted) ---\n${lines.join('\n')}`
}

for (const [name, reason] of [
  ['DEPLOY FAILED for the tag', 'the deploy log records DEPLOY FAILED for this tag'],
  ['the wait ran out', 'the 1200s wait ran out with last-good-tag still on another version'],
]) {
  test(`${name}: the Deploy step fails, the item stays at Deploy, and the log tail is stored whole`, async () => {
    const itemId = name.startsWith('DEPLOY') ? 'HZF-1' : 'HZF-2'
    const runId = activeDeployRun(itemId, itemId === 'HZF-1' ? 1 : 2)
    const error = farmError(reason)
    assert.ok(error.length <= 2000, `the farm caps its error at 2000 chars (${error.length})`)

    const res = await app.inject({
      method: 'POST',
      url: `/api/farm/steps/${runId}/fail`,
      headers: { 'x-farm-secret': FARM_SHARED_SECRET },
      payload: { error },
    })

    assert.equal(res.statusCode, 200, res.body)
    const row = db.prepare('SELECT status, output FROM step_run WHERE id = ?').get(runId)
    // A failed run is stored as cancelled with a FAILED-prefixed output.
    assert.equal(row.status, 'cancelled')
    assert.ok(row.output.startsWith('FAILED: release deploy-hz-275 did not go live'), row.output.slice(0, 80))
    assert.match(row.output, /--- self-deploy\.log \(last 20 lines, redacted\) ---/)
    assert.match(row.output, /LAST TAIL LINE$/)
    const item = store.getItem(itemId)
    assert.equal(item.cursor, DEPLOY_STEP_INDEX)
    assert.equal(item.paused, true)
    // No auto-retry: no new run was started and no retry event recorded.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND status = 'active'").get(itemId).n, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = ? AND text LIKE '%auto-retrying%'").get(itemId).n, 0)
  })
}

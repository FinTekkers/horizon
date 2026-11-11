// HZ-822: the merged-PR listener app.js hands github.js is one per process. A
// later buildApp replaces it; closing an app drops only its own, so an older
// app closing never unsets a newer one's, and a closed app hears no merges.
//
// No run is spawned: the item's premerge row is claimed directly, and the
// merge is handed to handlePrStateChange as the webhook and the poll do.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'horizon-pr-merged-listener-'))
process.env.HORIZON_DB = join(tmp, 'test.db')
process.env.FARM_HOME = join(tmp, 'farm-home')
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const store = await import('../src/store.js')
const github = await import('../src/github.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
after(() => rmSync(tmp, { recursive: true, force: true }))

let seq = 0
// An item at Accept whose pre-merge check holds the gate.
function runningAccept() {
  const id = `T-PRL-${++seq}`
  const pr = 700 + seq
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    'acme/demo',
    null,
    pr,
  )
  assert.ok(store.claimGateAction(id, 'premerge', { detail: `reading PR #${pr}`, timeoutMs: 60_000 }))
  return { id, pr }
}
const merge = ({ pr }) => github.handlePrStateChange('acme/demo', pr, { merged: true, state: 'closed' })
const state = ({ id }) => store.getGateAction(id, 'premerge').state

test('a second buildApp replaces the listener; closing the older app leaves the newer one hearing merges', async () => {
  const older = buildApp({ logger: false })
  const newer = buildApp({ logger: false })
  await older.close()
  try {
    const a = runningAccept()
    assert.equal(merge(a), true)
    assert.equal(state(a), 'superseded')
  } finally {
    await newer.close()
  }
})

test('a closed app hears no merges: the code is still accepted, the row is left alone', async () => {
  const app = buildApp({ logger: false })
  await app.close()
  const a = runningAccept()
  assert.equal(merge(a), true)
  assert.notEqual(store.getItem(a.id).cursor, ACCEPT_GATE_INDEX, 'the merge still accepted the code')
  assert.equal(state(a), 'running')
})

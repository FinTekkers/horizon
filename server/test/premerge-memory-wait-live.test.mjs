// HZ-571: a pre-merge run while the box is short of memory waits before its
// checks start, the Accept card says "Waiting for memory (10% free, 1.5 GB)",
// and the run goes ahead once memory recovers.
//
// Live across the seam, like premerge-slot-wait-live: the real
// premerge.runner.spawn streams the real stderr of a PREMERGE_PYTHON shim
// that waits in the real farm/check_slots.py memory gate and reports through
// the real farm/premerge.py stderr_event. Memory is a fake meminfo file
// (FARM_MEMINFO_PATH, test-only). Only GitHub is stubbed.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { recordDetailWrites, REPO_ROOT, waitFor } from './helpers/slotWait.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'horizon-memory-wait-live-'))
const farmHome = join(tmp, 'farm-home')
mkdirSync(farmHome, { recursive: true })
const meminfo = join(tmp, 'meminfo')
const ran = join(tmp, 'ran')
const TOTAL_KB = 16000000
const setFree = (pct) =>
  writeFileSync(meminfo, `MemTotal: ${TOTAL_KB} kB\nMemAvailable: ${Math.floor((TOTAL_KB * pct) / 100)} kB\n`)

// argv mirrors farm.premerge's: -m farm.premerge <repo> <item> <head> --base <base> ...
// Inside the gate it writes `ran` — the stand-in for the checks starting.
const SHIM_PY = `
import json, os, sys
sys.path.insert(0, os.getcwd())
from farm import check_slots
from farm.premerge import stderr_event
args = sys.argv[1:]
item_id, head, base = args[3], args[4], args[6]
with check_slots.check_slot(item_id=item_id, caller="premerge", poll_s=0.1, on_event=stderr_event) as slot:
    open(${JSON.stringify(ran)}, "w").close()
print(json.dumps({"ok": True, "head_sha": head, "base_sha": base, "note": "shim checks passed"}), flush=True)
`

function writeShim() {
  const py = join(tmp, 'premerge_memory_shim.py')
  const bin = join(tmp, 'premerge-memory-shim.sh')
  writeFileSync(py, SHIM_PY)
  // Set here because premerge.js passes the child an allowlisted env only.
  // No wait ceiling, so a timeout can never race the raise below.
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `export FARM_MEMINFO_PATH=${JSON.stringify(meminfo)} FARM_MIN_MEM_AVAILABLE_PCT=15 FARM_CHECK_SLOT_WAIT_MAX_S=0`,
      'unset FARM_IN_CHECKS',
      `cd ${JSON.stringify(REPO_ROOT)}`,
      `exec python3 ${JSON.stringify(py)} "$@"`,
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

process.env.HORIZON_DB = join(tmp, 'test.db')
// Never the inherited farm: the shim's markers must be the test's own.
process.env.FARM_HOME = farmHome
process.env.PREMERGE_PYTHON = writeShim()
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
process.env.PREMERGE_CHECK_TIMEOUT_MS = '60000'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
const detailWrites = recordDetailWrites(db)

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const WAITING = 'Waiting for memory (10% free, 1.5 GB)'

let merges = 0
before(() => {
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
    if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) {
      return json(200, { head: { sha: HEAD, ref: 'horizon/t-mem' }, base: { ref: 'main' } })
    }
    if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: BASE } })
    if (method === 'PUT' && u.pathname.endsWith('/merge')) {
      merges++
      return json(200, { merged: true })
    }
    return json(404, {})
  }
})
after(() => rmSync(tmp, { recursive: true, force: true }))

let seq = 0
function acceptItem() {
  const id = `T-MW-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    'acme/demo',
    300 + seq,
    400 + seq,
  )
  return id
}

const gateActionOf = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  return res.json().items.find((it) => it.id === id).gateAction
}

test('the pre-merge runner hears the memory event, nothing runs, and the run ends ok once memory recovers', async () => {
  rmSync(ran, { force: true })
  setFree(10)
  const heard = []
  const pending = premerge.runPreMergeChecks(
    { id: 'T-MW-direct', repo: 'acme/demo' },
    { headSha: HEAD, baseSha: BASE, timeoutMs: 60000, onSlot: (name, event) => heard.push([name, event]) },
  )
  const [, event] = await waitFor(() => heard.find(([name]) => name === 'memory'), { what: 'the memory event' })
  assert.equal(event.available_pct, 10)
  assert.equal(event.threshold_pct, 15)
  assert.equal(existsSync(ran), false, 'the checks started below the threshold')

  setFree(50)
  const result = await pending
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(existsSync(ran), true)
  assert.deepEqual(heard.at(-1)[0], 'granted')
})

test('the Accept card reads Waiting for memory with the figure, then the PR merges once memory recovers', async () => {
  rmSync(ran, { force: true })
  setFree(10)
  const id = acceptItem()
  const mergesBefore = merges
  const pending = app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve`,
    payload: {},
    headers: { cookie, 'x-human-key': pin },
  })
  const waiting = await waitFor(async () => {
    const action = await gateActionOf(id)
    return action?.detail === WAITING && action
  }, { what: 'the waiting-for-memory detail' })
  assert.equal(waiting.state, 'running')
  assert.equal(existsSync(ran), false)
  assert.equal(merges, mergesBefore, 'nothing merges while waiting for memory')

  setFree(50)
  const res = await pending
  assert.equal(res.statusCode, 200)
  assert.equal((await gateActionOf(id)).state, 'merged')
  assert.equal(merges, mergesBefore + 1)
  const details = detailWrites(id).map((w) => w.detail)
  const waitAt = details.indexOf(WAITING)
  assert.ok(waitAt >= 0 && details.indexOf('Running checks') > waitAt, JSON.stringify(details))
})

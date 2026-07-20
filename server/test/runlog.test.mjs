// HTTP contract for the live run-log proxy (HZ-5): the farm's 200/404 pass
// through, and an unreachable farm is a 503 — never a hung request.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-runlog-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'

const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')

// The seeded BF-* demo items are irrelevant here; drop them so nothing kicks.
store.purgeDemoItems()

const app = buildApp({ logger: false })

// Stub the farm: the proxy's contract is what we test, not farmd itself.
let farmResponse = null
globalThis.fetch = async (url) => {
  if (farmResponse instanceof Error) throw farmResponse
  farmResponse.requestedUrl = String(url)
  return { status: farmResponse.status, ok: farmResponse.status < 400, json: async () => farmResponse.body }
}

test('passes the farm log body through with the offset', async () => {
  farmResponse = { status: 200, body: { content: '[12:01:02] ⏺ Read(farm/farmd.py)\n', next_offset: 34, active: true } }
  const res = await app.inject({ method: 'GET', url: '/api/runs/7/log?offset=12' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { content: '[12:01:02] ⏺ Read(farm/farmd.py)\n', next_offset: 34, active: true })
  assert.equal(farmResponse.requestedUrl, 'http://farm.test/runs/7/log?offset=12')
})

test('a run the farm does not know is a 404', async () => {
  farmResponse = { status: 404, body: { error: 'unknown run' } }
  const res = await app.inject({ method: 'GET', url: '/api/runs/999/log' })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'unknown run' })
})

test('an unreachable farm is a 503', async () => {
  farmResponse = new Error('connect ECONNREFUSED')
  const res = await app.inject({ method: 'GET', url: '/api/runs/7/log' })
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.json(), { error: 'farm unavailable' })
})

test('a negative offset is rejected at the schema layer', async () => {
  farmResponse = { status: 200, body: {} }
  const res = await app.inject({ method: 'GET', url: '/api/runs/7/log?offset=-1' })
  assert.equal(res.statusCode, 400)
})

// The live-update batching window is 1 s in production and only shortened by
// STREAM_BATCH_MS in the env (the e2e server sets 100). Each case imports the
// app in its own process, since the value is read once at import.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function windowWith(value) {
  const env = { ...process.env, HORIZON_DB: join(mkdtempSync(join(tmpdir(), 'stream-batch-')), 'h.db') }
  delete env.STREAM_BATCH_MS
  if (value !== undefined) env.STREAM_BATCH_MS = value
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./src/app.js'); console.log(m.STREAM_BATCH_MS); process.exit(0)"], {
    cwd: new URL('..', import.meta.url),
    env,
    encoding: 'utf8',
  })
  return Number(out.trim().split('\n').pop())
}

test('unset, the window is the production 1000 ms', () => {
  assert.equal(windowWith(undefined), 1000)
})

test('STREAM_BATCH_MS=100 shortens it to 100 ms', () => {
  assert.equal(windowWith('100'), 100)
})

test('a junk or tiny value never turns batching off', () => {
  assert.equal(windowWith('abc'), 1000)
  assert.equal(windowWith('5'), 50)
})

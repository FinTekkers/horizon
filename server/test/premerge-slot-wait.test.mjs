// HZ-227: the slot events are fire-and-forget on the Node side. A listener
// that throws never fails the run, the stderr observer leaves `stderr`
// byte-identical, and only well-formed HORIZON_EVENT lines are events.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const premerge = await import('../src/premerge.js')

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const ITEM = { id: 'HZ-1', repo: 'acme/demo' }
const green = (args) => ({ code: 0, stdout: JSON.stringify({ ok: true, head_sha: args[4], base_sha: args[6] }), stderr: '', timedOut: false })

async function withSpawn(fake, fn) {
  const real = premerge.runner.spawn
  premerge.runner.spawn = fake
  try {
    return await fn()
  } finally {
    premerge.runner.spawn = real
  }
}

test('an onSlot that throws never fails the run', async () => {
  const heard = []
  const result = await withSpawn(
    async (args, opts) => {
      opts.onStderrLine('HORIZON_EVENT {"check_slot": "queued"}')
      opts.onStderrLine('HORIZON_EVENT {"check_slot": "granted", "mode": "held"}')
      return green(args)
    },
    () =>
      premerge.runPreMergeChecks(ITEM, {
        headSha: HEAD,
        baseSha: BASE,
        timeoutMs: 60000,
        onSlot: (name) => {
          heard.push(name)
          throw new Error('listener bug')
        },
      }),
  )
  assert.equal(result.ok, true)
  assert.deepEqual(heard, ['queued', 'granted'])
})

test('without onSlot the runner gets no stderr listener', async () => {
  let opts
  await withSpawn(
    async (args, o) => {
      opts = o
      return green(args)
    },
    () => premerge.runPreMergeChecks(ITEM, { headSha: HEAD, baseSha: BASE, timeoutMs: 60000 }),
  )
  assert.equal(opts.onStderrLine, undefined)
})

test('parseSlotEvent accepts only whole, known HORIZON_EVENT lines', () => {
  assert.equal(premerge.parseSlotEvent('HORIZON_EVENT {"check_slot": "queued"}'), 'queued')
  assert.equal(premerge.parseSlotEvent('HORIZON_EVENT {"check_slot": "granted", "mode": "fail-open"}'), 'granted')
  for (const line of [
    'HORIZON_EVENT {"check_slot": ',
    'HORIZON_EVENT {"check_slot": "toString"}',
    'HORIZON_EVENT {"other": "queued"}',
    'HORIZON_EVENT null',
    'noise HORIZON_EVENT {"check_slot": "queued"}',
    'check_slots: all 1 check slots busy — waiting for one',
    '',
  ]) {
    assert.equal(premerge.parseSlotEvent(line), null, line)
  }
})

test('the real runner streams whole lines, keeps stderr byte-identical, and survives a throwing listener', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'horizon-slot-lines-'))
  const bin = join(dir, 'fake-python.sh')
  // A sentinel split across two flushes, a multi-byte character, and a last
  // line with no trailing newline.
  writeFileSync(
    bin,
    "#!/bin/sh\nprintf 'progress é\\nHORIZON_EVENT {\"check_sl' >&2\nsleep 0.2\nprintf 'ot\": \"queued\"}\\nlast line' >&2\necho '{}'\n",
  )
  chmodSync(bin, 0o755)
  const prev = process.env.PREMERGE_PYTHON
  process.env.PREMERGE_PYTHON = bin
  try {
    const lines = []
    const out = await premerge.runner.spawn([], {
      cwd: dir,
      timeoutMs: 10000,
      env: { PATH: process.env.PATH },
      onStderrLine: (line) => {
        lines.push(line)
        throw new Error('listener bug')
      },
    })
    assert.equal(out.code, 0)
    assert.equal(out.stderr, 'progress é\nHORIZON_EVENT {"check_slot": "queued"}\nlast line')
    assert.deepEqual(lines, ['progress é', 'HORIZON_EVENT {"check_slot": "queued"}', 'last line'])
  } finally {
    if (prev === undefined) delete process.env.PREMERGE_PYTHON
    else process.env.PREMERGE_PYTHON = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

// HZ-183: server/src/premerge.js — the seam to `python -m farm.premerge`.
// Every outcome that is not a parsed ok:true from a zero exit must come back
// ok:false (fail closed), and Node must never choose where the checks run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const premerge = await import('../src/premerge.js')

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const ITEM = { id: 'HZ-183', repo: 'FinTekkers/horizon', pr: 7 }
const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

async function withRunner(out, fn) {
  const real = premerge.runner.spawn
  const calls = []
  premerge.runner.spawn = async (args, opts) => {
    calls.push({ args, opts })
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...(typeof out === 'function' ? out(args) : out) }
  }
  try {
    return await fn(calls)
  } finally {
    premerge.runner.spawn = real
  }
}

const green = (over = {}) => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, head_sha: HEAD, base_sha: BASE, merge_sha: 'c'.repeat(40), note: '2 repo check(s) passed', ...over }) + '\n',
})

test('argv carries the repo, item and two shas — no filesystem path — and runs from the farm checkout', async () => {
  await withRunner(green(), async (calls) => {
    const result = await premerge.runPreMergeChecks(ITEM, { headSha: HEAD, baseSha: BASE, timeoutMs: 20 * 60 * 1000 })
    assert.equal(result.ok, true)
    const [{ args, opts }] = calls
    assert.deepEqual(args, ['-m', 'farm.premerge', 'FinTekkers/horizon', 'HZ-183', HEAD, '--base', BASE, '--timeout-s', '1200', '--json'])
    assert.ok(!args.some((a) => a.includes('/') && a !== 'FinTekkers/horizon'), 'Node must not pick the workspace')
    assert.equal(opts.cwd, REPO_ROOT)
    assert.equal(opts.timeoutMs, 20 * 60 * 1000)
    assert.equal(opts.env.FARM_CHECK_TIMEOUT_S, '1200')
  })
})

test('the check run gets an allowlisted env — none of the server\'s secrets or its DB path', async () => {
  const planted = { WA_APPROVAL_SECRET: 'wa', GITHUB_TOKEN: 'gh', FARM_SHARED_SECRET: 'farm', HORIZON_DB: '/prod.db', GOOGLE_CLIENT_SECRET: 'g' }
  const prev = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]))
  Object.assign(process.env, planted)
  try {
    await withRunner(green(), async (calls) => {
      await premerge.runPreMergeChecks(ITEM, { headSha: HEAD, baseSha: BASE, timeoutMs: 60_000 })
      const { env } = calls[0].opts
      for (const name of Object.keys(planted)) assert.equal(Object.hasOwn(env, name), false, `${name} leaked`)
      assert.equal(env.PATH, process.env.PATH)
      assert.equal(env.FARM_CHECK_TIMEOUT_S, '60')
    })
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

const failClosedCases = [
  ['the run timed out', { timedOut: true, code: null }, 'timed_out'],
  ['python is missing', { code: null, error: Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }) }, 'crash'],
  ['exit 0 but ok:false', { code: 0, stdout: JSON.stringify({ ok: false, reason: 'checks_failed', failing_check: 'npm test', tail: 'x' }) }, 'checks_failed'],
  ['exit 1 with ok:true', { code: 1, stdout: JSON.stringify({ ok: true, head_sha: HEAD, base_sha: BASE }) }, 'crash'],
  ['unparseable stdout', { code: 1, stdout: 'Traceback (most recent call last):', stderr: 'boom' }, 'crash'],
  ['empty stdout', { code: 0, stdout: '' }, 'crash'],
  ['a JSON array', { code: 0, stdout: '[true]' }, 'crash'],
  ['a green for other commits', green({ head_sha: 'e'.repeat(40) }), 'crash'],
]

for (const [name, out, reason] of failClosedCases) {
  test(`fails closed when ${name}`, async () => {
    await withRunner(out, async () => {
      const result = await premerge.runPreMergeChecks(ITEM, { headSha: HEAD, baseSha: BASE, timeoutMs: 60_000 })
      assert.equal(result.ok, false)
      assert.equal(result.reason, reason)
    })
  })
}

test('a short or missing sha is refused before anything is spawned', async () => {
  await withRunner(green(), async (calls) => {
    for (const headSha of [undefined, 'abc123', HEAD.toUpperCase()]) {
      const result = await premerge.runPreMergeChecks(ITEM, { headSha, baseSha: BASE, timeoutMs: 60_000 })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'bad_input')
    }
    assert.equal(calls.length, 0)
  })
})

test('a crashed run keeps the last lines of stderr, not the first', async () => {
  const stderr = Array.from({ length: 200 }, (_, i) => `stderr line ${i + 1}`).join('\n')
  await withRunner({ code: 1, stdout: '', stderr }, async () => {
    const result = await premerge.runPreMergeChecks(ITEM, { headSha: HEAD, baseSha: BASE, timeoutMs: 60_000 })
    const lines = result.tail.split('\n')
    assert.ok(lines.includes('stderr line 200'))
    assert.ok(!lines.includes('stderr line 1'))
    assert.match(lines[0], /earlier output trimmed/)
  })
})

test('describeFailure names the failing check and carries its tail', () => {
  const text = premerge.describeFailure({
    ok: false,
    reason: 'checks_failed',
    failing_check: '/usr/bin/python3 -m pytest -q',
    tail: 'FAILED farm/tests/test_one_reply_parser.py::test_no_module_under_farm_parses_a_model_reply_itself\n1 failed, 812 passed',
    base_sha: BASE,
    head_sha: HEAD,
  })
  assert.match(text, /\/usr\/bin\/python3 -m pytest -q/)
  assert.match(text, /test_no_module_under_farm_parses_a_model_reply_itself/)
  assert.match(text, /1 failed, 812 passed/)
})

test('describeFailure tells the human what to do for each fail-closed reason', () => {
  assert.match(premerge.describeFailure({ reason: 'no_checks_detected' }), /add a test script/)
  assert.match(premerge.describeFailure({ reason: 'no_hub' }), /start the farm/)
  assert.match(premerge.describeFailure({ reason: 'timed_out' }), /PREMERGE_CHECK_TIMEOUT_MS/)
  assert.match(premerge.describeFailure({ reason: 'merge_conflict' }), /resolve the conflict/)
  assert.match(premerge.describeFailure({ reason: 'crash', detail: 'KeyError: x' }), /could not run \(crash\): KeyError: x/)
})

// ---- the real runner.spawn, against a stand-in interpreter ----

function fakePython(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'horizon-premerge-'))
  const bin = path.join(dir, 'python')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}

async function withPython(bin, fn) {
  const prev = process.env.PREMERGE_PYTHON
  process.env.PREMERGE_PYTHON = bin
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.PREMERGE_PYTHON
    else process.env.PREMERGE_PYTHON = prev
  }
}

test('the real runner kills a run that outlives the timeout, children included, and reports timedOut', async () => {
  const bin = fakePython('sleep 30 & sleep 30')
  await withPython(bin, async () => {
    const started = Date.now()
    const out = await premerge.runner.spawn(['-m', 'farm.premerge'], { cwd: REPO_ROOT, timeoutMs: 300, env: process.env })
    assert.equal(out.timedOut, true)
    assert.ok(Date.now() - started < 5000)
  })
})

test('the real runner returns the exit code and both streams', async () => {
  const bin = fakePython(`echo '{"ok": false, "reason": "checks_failed"}'; echo progress >&2; exit 1`)
  await withPython(bin, async () => {
    const out = await premerge.runner.spawn([], { cwd: REPO_ROOT, timeoutMs: 5000, env: process.env })
    assert.equal(out.code, 1)
    assert.equal(out.timedOut, false)
    assert.deepEqual(JSON.parse(out.stdout), { ok: false, reason: 'checks_failed' })
    assert.equal(out.stderr.trim(), 'progress')
  })
})

test('the real runner resolves (never rejects) when the interpreter does not exist', async () => {
  await withPython('/nonexistent/python-for-hz-183', async () => {
    const out = await premerge.runner.spawn([], { cwd: REPO_ROOT, timeoutMs: 5000, env: process.env })
    assert.ok(out.error)
    const result = await withRunner(out, () =>
      premerge.runPreMergeChecks(ITEM, { headSha: HEAD, baseSha: BASE, timeoutMs: 5000 }),
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'crash')
  })
})

// HZ-183: server/src/premerge.js — the seam to `python -m farm.premerge`.
// Every outcome that is not a parsed ok:true from a zero exit must come back
// ok:false (fail closed), and Node must never choose where the checks run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import net from 'node:net'
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
  assert.match(
    premerge.describeFailure({ reason: 'no_checks_detected', detail: 'no check commands configured for acme/demo' }),
    /^no check commands configured for acme\/demo — .*Set the repo's check commands in Admin, or mark it 'no checks'$/,
  )
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

// ---- HZ-569: a run past the cap leaves nothing running ----

async function withReaper(run, fn) {
  const real = premerge.reaper.run
  premerge.reaper.run = run
  try {
    return await fn()
  } finally {
    premerge.reaper.run = real
  }
}

test('each run gets its own tag, in the env only', async () => {
  await withRunner(green(), async (calls) => {
    await premerge.runPreMergeChecks(ITEM, { headSha: HEAD, baseSha: BASE, timeoutMs: 60_000 })
    await premerge.runPreMergeChecks(ITEM, { headSha: HEAD, baseSha: BASE, timeoutMs: 60_000 })
    const [a, b] = calls.map((c) => c.opts.env[premerge.RUN_ENV])
    assert.match(a, /^premerge-hz-183-\d+-[0-9a-f]{6}$/)
    assert.notEqual(a, b)
    assert.equal(calls[0].opts.runId, a)
    assert.ok(!calls[0].args.includes(a), 'never on argv')
  })
})

test('the cap reaps the run by its id before the result is reported', async () => {
  const bin = fakePython('sleep 30')
  const reaped = []
  await withPython(bin, () =>
    withReaper(async (runId, opts) => {
      reaped.push({ runId, farmHome: opts.env.FARM_HOME })
      return { code: 0 }
    }, async () => {
      const out = await premerge.runner.spawn([], { cwd: REPO_ROOT, timeoutMs: 300, env: { ...process.env, FARM_HOME: '/farm-home' }, runId: 'premerge-hz-183-1-abcdef' })
      assert.equal(out.timedOut, true)
      assert.deepEqual(reaped, [{ runId: 'premerge-hz-183-1-abcdef', farmHome: '/farm-home' }])
    }),
  )
})

for (const [name, run] of [
  ['rejects', async () => { throw new Error('python exploded') }],
  ['throws at once', () => { throw new Error('spawn failed') }],
  ['exits non-zero', async () => ({ code: 2 })],
  ['never answers in time', async () => ({ code: null, error: new Error('run_reaper did not finish') })],
]) {
  test(`a reap that ${name} leaves the capped result and exit code unchanged`, async () => {
    const bin = fakePython('sleep 30')
    await withPython(bin, async () => {
      const capped = (reaper) =>
        withReaper(reaper, () => premerge.runner.spawn([], { cwd: REPO_ROOT, timeoutMs: 300, env: process.env, runId: 'premerge-x-1-abcdef' }))
      const working = await capped(async () => ({ code: 0 }))
      const failing = await capped(run)
      assert.equal(failing.timedOut, true)
      assert.equal(failing.code, working.code)
      assert.equal(failing.code, null)
      const gate = await withReaper(run, () => withRunner(failing, () => premerge.runPreMergeChecks(ITEM, { headSha: HEAD, baseSha: BASE, timeoutMs: 300 })))
      assert.equal(gate.ok, false)
      assert.equal(gate.reason, 'timed_out')
    })
  })
}

// ---- HZ-598: the cap counts run time, from the slot grant ----

// A stand-in CLI: each step is `event <name>` (a HORIZON_EVENT line on
// stderr) or `sleep <s>`, then a green result for the shas it was given.
function slotRun(steps) {
  const lines = steps.map(([kind, value]) =>
    kind === 'event' ? `echo 'HORIZON_EVENT {"check_slot": "${value}"}' >&2` : `sleep ${value}`,
  )
  return fakePython([...lines, `echo "{\\"ok\\": true, \\"head_sha\\": \\"$5\\", \\"base_sha\\": \\"$7\\"}"`].join('\n'))
}

async function timedPreMerge(bin, timeoutMs) {
  return withReaper(async () => ({ code: 0 }), () =>
    withPython(bin, async () => {
      const started = Date.now()
      const result = await premerge.runPreMergeChecks(ITEM, { headSha: HEAD, baseSha: BASE, timeoutMs })
      return { result, elapsed: Date.now() - started }
    }),
  )
}

async function withSlotWaitMax(value, fn) {
  const prev = process.env.FARM_CHECK_SLOT_WAIT_MAX_S
  if (value === undefined) delete process.env.FARM_CHECK_SLOT_WAIT_MAX_S
  else process.env.FARM_CHECK_SLOT_WAIT_MAX_S = value
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.FARM_CHECK_SLOT_WAIT_MAX_S
    else process.env.FARM_CHECK_SLOT_WAIT_MAX_S = prev
  }
}

// Metric 1, scaled: 15 min queued then 15 min running under a 20 min cap.
test('a run that queues for a slot, then runs, finishes within a cap shorter than both together', async () => {
  const bin = slotRun([['event', 'queued'], ['sleep', 1.5], ['event', 'granted'], ['sleep', 1.5]])
  const { result, elapsed } = await timedPreMerge(bin, 2000)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(elapsed >= 3000, `ran ${elapsed} ms`)
})

// Metric 2: the cap still holds from the grant, and from launch with no wait.
for (const [name, steps] of [
  ['gets its slot straight away', [['event', 'granted'], ['sleep', 30]]],
  ['never waits for a slot', [['sleep', 30]]],
]) {
  test(`a run that ${name} still times out after the cap of running`, async () => {
    const { result, elapsed } = await timedPreMerge(slotRun(steps), 2000)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'timed_out')
    assert.ok(elapsed >= 1900 && elapsed < 5000, `killed after ${elapsed} ms`)
  })
}

test('a run stuck in the queue is killed at the cap plus the slot wait ceiling, counted from its first wait', async () => {
  // memory, then queued a second later: only the first event arms the backstop.
  const bin = slotRun([['event', 'memory'], ['sleep', 1], ['event', 'queued'], ['sleep', 30]])
  const { result, elapsed } = await withSlotWaitMax('1', () => timedPreMerge(bin, 500))
  assert.equal(result.reason, 'timed_out')
  assert.ok(elapsed >= 1400 && elapsed < 2400, `killed after ${elapsed} ms`)
})

test('the slot wait ceiling reaches the run, and a missing, unbounded or bad one is the farm default', async () => {
  await withRunner(green(), (calls) =>
    withSlotWaitMax('45', async () => {
      await premerge.runPreMergeChecks(ITEM, { headSha: HEAD, baseSha: BASE, timeoutMs: 60_000 })
      assert.equal(calls[0].opts.env.FARM_CHECK_SLOT_WAIT_MAX_S, '45')
      assert.equal(premerge.slotWaitMaxMs(), 45_000)
    }),
  )
  for (const value of [undefined, '0', '-5', 'soon', '']) {
    await withSlotWaitMax(value, () => assert.equal(premerge.slotWaitMaxMs(), 1_200_000, String(value)))
  }
})

// /proc: every live process whose starting environment carries the tag.
function taggedPids(runId) {
  const needle = Buffer.from(`${premerge.RUN_ENV}=${runId}\0`)
  const pids = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let environ
    let state
    try {
      environ = readFileSync(`/proc/${entry}/environ`)
      state = readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ').pop().split(' ')[0]
    } catch {
      continue
    }
    if (state !== 'Z' && environ.includes(needle)) pids.push(Number(entry))
  }
  return pids
}

function portBinds(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitFor(what, check, withinMs) {
  const deadline = Date.now() + withinMs
  for (;;) {
    if (await check()) return
    if (Date.now() >= deadline) assert.fail(`gave up after ${withinMs} ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const FAKE_SERVER_JS = `const http = require('node:http')
http.createServer((req, res) => res.end('ok')).listen(Number(process.argv[2]), '127.0.0.1')
`

// A repo hub as the farm keeps it (a clone of an origin), whose one commit
// holds an e2e server and a capture worker for the check to start.
function makeHub(home) {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const origin = path.join(home, 'origin.git')
  git(home, 'init', '-q', '--bare', '-b', 'main', origin)
  const hub = path.join(home, 'workspaces', 'acme__demo')
  mkdirSync(path.dirname(hub), { recursive: true })
  git(home, 'clone', '-q', origin, hub)
  writeFileSync(path.join(hub, 'package.json'), '{"type": "commonjs"}\n')
  mkdirSync(path.join(hub, 'src'))
  writeFileSync(path.join(hub, 'src', 'server.js'), FAKE_SERVER_JS)
  mkdirSync(path.join(hub, 'farm', 'capture'), { recursive: true })
  writeFileSync(path.join(hub, 'farm', 'capture', 'worker.mjs'), 'setInterval(() => {}, 1 << 30)\n')
  git(hub, 'add', '.')
  git(hub, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'fixture')
  git(hub, 'push', '-q', 'origin', 'HEAD:main')
  return git(hub, 'rev-parse', 'HEAD')
}

test('a real pre-merge run past its cap leaves no process of the run within 10 s', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'horizon-premerge-reap-'))
  const sha = makeHub(home)
  const port = await freePort()
  const tagFile = path.join(home, 'run-id')
  // The real `python -m farm.premerge`, with its own deadlines lifted so the
  // server's cap is what ends it — the case the cap exists for. Everything
  // else (the reaper too) runs as-is.
  const bin = fakePython(
    'case "$2" in farm.premerge) exec env FARM_CHECK_TIMEOUT_S=600 python3 "$@" --timeout-s 600 ;; *) exec python3 "$@" ;; esac',
  )
  const check = `echo "$${premerge.RUN_ENV}" > ${tagFile}; setsid node src/server.js ${port} & setsid node farm/capture/worker.mjs & sleep 600`
  const prevHome = process.env.FARM_HOME
  process.env.FARM_HOME = home
  let runId = null
  try {
    await withPython(bin, async () => {
      const result = await premerge.runPreMergeChecks(
        { id: 'HZ-569', repo: 'acme/demo' },
        { headSha: sha, baseSha: sha, timeoutMs: 6000, checkCommands: { test: check } },
      )
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'timed_out')
    })
    assert.ok(existsSync(tagFile), 'the check never started inside the cap')
    runId = readFileSync(tagFile, 'utf8').trim()
    assert.match(runId, /^premerge-hz-569-/)
    await waitFor('every process of the run to be gone', () => taggedPids(runId).length === 0, 10_000)
    await waitFor(`port ${port} to bind again`, () => portBinds(port), 10_000)
    const lease = path.join(home, 'state', 'runs', `${runId}.json`)
    assert.ok(!existsSync(lease), `the reaped run leaves no lease`)
  } finally {
    if (runId) for (const pid of taggedPids(runId)) try { process.kill(pid, 'SIGKILL') } catch {}
    if (prevHome === undefined) delete process.env.FARM_HOME
    else process.env.FARM_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

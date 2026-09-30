// HZ-138: unit tests for test/helpers/farmd.mjs — the interpreter resolver,
// the environment allow-list, and the stale-FARM_HOME sweep.
//
// The sweep gets the most attention here because it is the only code in the
// change that SENDS SIGNALS, and because getting it wrong is worse than not
// having it: `node --test` runs test files in parallel, so a sibling file's
// farmd is alive, is genuinely a test farmd, and sits in a directory with
// exactly the right name. Every sweep case below therefore asserts on a
// process that must SURVIVE. Only the last one is allowed to kill anything.
//
// The decoys are Node processes carrying `farm.farmd` in their argv, not real
// daemons: the sweep's whole contract is about what it decides from /proc, and
// a decoy lets each ownership check be failed in isolation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  FARMD_ENV_KEYS,
  FARMD_ENV_WITHHELD,
  FARM_HOME_PREFIX,
  PIDFILE_NAME,
  PYTHON_OVERRIDE_VAR,
  TEST_SHARED_SECRET,
  buildFarmdEnv,
  farmPythonCandidates,
  freePort,
  procAlive,
  procEnviron,
  procStat,
  resolveFarmPython,
  startTestFarmd,
  sweepStaleTestFarmds,
} from './helpers/farmd.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

// ---------------------------------------------------------------------------
// interpreter resolution (success metric 6)
// ---------------------------------------------------------------------------

test('the resolver picks a farm venv interpreter, never a bare python3', () => {
  const resolved = resolveFarmPython(REPO_ROOT)
  assert.ok(path.isAbsolute(resolved), `${resolved} is not an absolute path`)
  assert.ok(resolved.endsWith('/.venv/bin/python'), `${resolved} is not a venv interpreter`)
  assert.ok(existsSync(resolved))
})

test('the workspace venv is preferred over the deployed one', () => {
  const [workspaceVenv, deployedVenv] = farmPythonCandidates(REPO_ROOT)
  assert.equal(workspaceVenv, path.join(REPO_ROOT, 'farm/.venv/bin/python'))
  assert.equal(deployedVenv, '/opt/horizon/farm/.venv/bin/python')
})

test('FARM_TEST_PYTHON overrides both venv candidates', () => {
  const resolved = resolveFarmPython(REPO_ROOT, { [PYTHON_OVERRIDE_VAR]: process.execPath })
  assert.equal(resolved, process.execPath)
})

test('a FARM_TEST_PYTHON that does not exist throws and names itself', () => {
  assert.throws(() => resolveFarmPython(REPO_ROOT, { [PYTHON_OVERRIDE_VAR]: '/nope/bin/python' }), (err) => {
    assert.match(err.message, /FARM_TEST_PYTHON/)
    assert.match(err.message, /\/nope\/bin\/python/)
    return true
  })
})

test('with no venv anywhere the resolver fails loud instead of falling back', () => {
  assert.throws(() => resolveFarmPython(REPO_ROOT, {}, ['/nope/a/bin/python', '/nope/b/bin/python']), (err) => {
    assert.match(err.message, /refusing to fall back/, 'must not quietly substitute a bare interpreter')
    assert.match(err.message, /farm\/run\.sh/, 'the message must name what creates the venv')
    assert.match(err.message, /FARM_TEST_PYTHON/, 'the message must name the escape hatch')
    return true
  })
})

// The bare interpreter this test used to spawn — `python3` on PATH — is not
// necessarily the same one as the venv's, and that difference is the whole
// point of metric 6.
test('the resolved interpreter is not whatever python3 is on PATH', () => {
  const onPath = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
  if (onPath.status !== 0) return // no system python3 at all — nothing to compare
  assert.notEqual(resolveFarmPython(REPO_ROOT), onPath.stdout.trim())
})

// ---------------------------------------------------------------------------
// the environment allow-list (success metrics 1 and 2)
// ---------------------------------------------------------------------------

// Everything a leaked daemon must never be handed, at once.
const HOSTILE_INHERITED = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/somebody',
  HORIZON_URL: 'http://127.0.0.1:3001',
  FARM_SHARED_SECRET: 'the-real-production-secret',
  HORIZON_DB: '/opt/horizon/server/data/horizon.db',
  GITHUB_TOKEN: 'ghp_realtoken',
  ANTHROPIC_API_KEY: 'sk-ant-real',
  FARM_WA_ENABLED: '1',
  FARM_PROVIDER: 'muse',
  FARM_MUSE_BIN: '/usr/local/bin/muse',
  TMUX: '/tmp/tmux-1000/default,1,0',
  LANG: 'en_GB.UTF-8',
}

function envUnderTest(overrides = {}) {
  return buildFarmdEnv({
    farmPort: 41234,
    farmHome: '/tmp/horizon-farmd-e2e-fixture',
    repoRoot: REPO_ROOT,
    horizonUrl: 'http://127.0.0.1:59999',
    inherited: HOSTILE_INHERITED,
    ...overrides,
  })
}

test('the spawn environment is exactly the allow-list, whatever was inherited', () => {
  assert.deepEqual(Object.keys(envUnderTest()).sort(), [...FARMD_ENV_KEYS].sort())
})

test('nothing on the withheld list survives, even when every one of them is set', () => {
  const env = envUnderTest()
  for (const key of FARMD_ENV_WITHHELD) {
    assert.equal(env[key], undefined, `${key} leaked into the spawn environment`)
    assert.ok(HOSTILE_INHERITED[key] !== undefined, `${key} is on the withheld list but this test never sets it`)
  }
})

test('HORIZON_URL and FARM_SHARED_SECRET are the test-owned values, not the inherited ones', () => {
  const env = envUnderTest()
  assert.equal(env.HORIZON_URL, 'http://127.0.0.1:59999')
  assert.notEqual(env.HORIZON_URL, HOSTILE_INHERITED.HORIZON_URL)
  assert.equal(env.FARM_SHARED_SECRET, TEST_SHARED_SECRET)
  assert.notEqual(env.FARM_SHARED_SECRET, HOSTILE_INHERITED.FARM_SHARED_SECRET)
})

test('buildFarmdEnv refuses to build an environment with no explicit HORIZON_URL', () => {
  // Omitting the key would be no safer than inheriting it: farm/config.py
  // defaults HORIZON_URL to http://localhost:3001, which IS production.
  assert.throws(() => envUnderTest({ horizonUrl: undefined }), /explicit horizonUrl/)
})

test('only PATH, HOME and the tmux socket directory are inherited', () => {
  const env = envUnderTest()
  assert.equal(env.PATH, HOSTILE_INHERITED.PATH, 'farmd shells out to tmux and needs to find it')
  assert.equal(env.HOME, HOSTILE_INHERITED.HOME)
  assert.equal(env.TMUX_TMPDIR, '/tmp', 'not set upstream, so the tmux default')
  // Fixed, not inherited, so the key set above cannot vary by host.
  assert.equal(env.LANG, 'C.UTF-8')
})

test('the background reconcile loop is pushed out past the life of any test', () => {
  assert.equal(envUnderTest().FARM_RECONCILE_INTERVAL_S, '3600')
})

// ---------------------------------------------------------------------------
// the sweep (guardrail 4: never kill by name pattern, never kill production)
// ---------------------------------------------------------------------------

// argv carries `farm.farmd`, so it satisfies the sweep's cmdline check and
// pgrep would find it — which is the point. Detached, so each decoy is its own
// process group and can be reclaimed without touching anything else.
function decoy(t, { farmHome, orphan = false }) {
  const script = 'setTimeout(() => {}, 120000)'
  const env = { PATH: process.env.PATH, HOME: process.env.HOME }
  if (farmHome) env.FARM_HOME = farmHome

  let pid
  if (orphan) {
    // Double-fork: the shell exits at once and the kernel reparents the
    // decoy to pid 1, which is the state every leaked daemon was found in.
    const launched = spawnSync(
      'sh',
      ['-c', `exec "$1" -e "$2" farm.farmd >/dev/null 2>&1 & echo $!`, 'sh', process.execPath, script],
      { env, encoding: 'utf8' },
    )
    assert.equal(launched.status, 0, `could not launch an orphan decoy: ${launched.stderr}`)
    pid = Number(launched.stdout.trim())
  } else {
    const proc = spawn(process.execPath, ['-e', script, 'farm.farmd'], { env, stdio: 'ignore', detached: true })
    proc.unref()
    pid = proc.pid
  }

  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  })
  return pid
}

async function waitForPpid(pid, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (procStat(pid)?.ppid === expected) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return procStat(pid)?.ppid === expected
}

// A scratch root, so no case can see (let alone act on) a real FARM_HOME
// belonging to a test running in parallel. Removed afterwards — a test about
// not leaking temp directories should not leave any.
function scratchRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'horizon-farmd-sweep-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function fakeHome(root, pid) {
  const dir = path.join(root, `${FARM_HOME_PREFIX}${Math.abs(pid)}`)
  mkdirSync(dir, { recursive: true })
  if (pid !== null) writeFileSync(path.join(dir, PIDFILE_NAME), String(pid))
  return dir
}

test('the sweep leaves a pid alone when it is not farmd at all', async (t) => {
  const root = scratchRoot(t)
  const sleeper = spawn('sleep', ['120'], { stdio: 'ignore', detached: true })
  sleeper.unref()
  t.after(() => {
    try {
      process.kill(sleeper.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  })
  const dir = fakeHome(root, sleeper.pid)

  const result = sweepStaleTestFarmds({ root })

  assert.deepEqual(result.killed, [], 'the sweep killed a pid whose cmdline is not farmd')
  assert.ok(procAlive(sleeper.pid))
  assert.ok(existsSync(dir))
  assert.match(result.skipped.find((s) => s.dir === dir).reason, /reused/)
})

test('the sweep leaves a real test farmd alone when its FARM_HOME is a different directory', async (t) => {
  const root = scratchRoot(t)
  const elsewhere = path.join(root, `${FARM_HOME_PREFIX}elsewhere`)
  mkdirSync(elsewhere, { recursive: true })
  const pid = decoy(t, { farmHome: elsewhere })
  // The pidfile is planted in a DIFFERENT directory than the process claims.
  const dir = fakeHome(root, pid)
  assert.equal(procEnviron(pid)?.FARM_HOME, elsewhere)

  const result = sweepStaleTestFarmds({ root })

  assert.deepEqual(result.killed, [], 'the sweep killed a pid that does not own the directory it was named in')
  assert.ok(procAlive(pid))
  assert.match(result.skipped.find((s) => s.dir === dir).reason, /FARM_HOME/)
})

test('the sweep leaves a LIVE sibling test farmd alone — only orphans are stale', async (t) => {
  // The regression test for the architecture review's must-fix. Without the
  // ppid check this is the case that makes the e2e test fail intermittently:
  // `node --test` runs files in parallel, the sibling daemon is a real test
  // farmd, its FARM_HOME matches, and both other ownership checks pass.
  const root = scratchRoot(t)
  const dir = path.join(root, `${FARM_HOME_PREFIX}live`)
  mkdirSync(dir, { recursive: true })
  const pid = decoy(t, { farmHome: dir })
  writeFileSync(path.join(dir, PIDFILE_NAME), String(pid))

  assert.notEqual(procStat(pid).ppid, 1, 'this decoy is supposed to still have a live parent')

  const result = sweepStaleTestFarmds({ root })

  assert.deepEqual(result.killed, [], 'the sweep killed a daemon a running test still owns')
  assert.ok(procAlive(pid), 'a live sibling daemon must survive the sweep')
  assert.ok(existsSync(dir), 'and so must its FARM_HOME')
  assert.match(result.skipped.find((s) => s.dir === dir).reason, /still parented/)
})

test('the sweep does kill an orphaned test farmd and remove its FARM_HOME', async (t) => {
  const root = scratchRoot(t)
  const dir = path.join(root, `${FARM_HOME_PREFIX}orphan`)
  mkdirSync(dir, { recursive: true })
  const pid = decoy(t, { farmHome: dir, orphan: true })
  writeFileSync(path.join(dir, PIDFILE_NAME), String(pid))

  assert.ok(await waitForPpid(pid, 1), `decoy ${pid} never reparented to pid 1`)

  const result = sweepStaleTestFarmds({ root })

  assert.deepEqual(result.killed, [pid])
  assert.equal(existsSync(dir), false)
  // The kill is the positive leg: without it every assertion above would also
  // pass against a sweep that does nothing whatsoever.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && procAlive(pid)) await new Promise((r) => setTimeout(r, 50))
  assert.equal(procAlive(pid), false, `orphan ${pid} survived the sweep`)
})

test('the sweep keeps a fresh directory with no pidfile, and removes an old one', (t) => {
  const root = scratchRoot(t)
  const fresh = path.join(root, `${FARM_HOME_PREFIX}fresh`)
  const old = path.join(root, `${FARM_HOME_PREFIX}old`)
  mkdirSync(fresh, { recursive: true })
  mkdirSync(old, { recursive: true })
  const longAgo = Date.now() / 1000 - 60 * 60 * 24
  utimesSync(old, longAgo, longAgo)

  const result = sweepStaleTestFarmds({ root })

  // A directory with no pidfile may belong to a spawn happening right now, so
  // age is the only safe discriminator.
  assert.ok(existsSync(fresh))
  assert.match(result.skipped.find((s) => s.dir === fresh).reason, /no pidfile/)
  assert.equal(existsSync(old), false)
  assert.deepEqual(result.removed, [old])
})

// ---------------------------------------------------------------------------
// boot diagnostics
// ---------------------------------------------------------------------------

test('a farmd that cannot boot fails fast and says why, rather than timing out', async () => {
  // HZ-138 changed the interpreter AND stripped the environment in one go, so
  // a boot failure that only ever surfaced as "did not become ready within
  // 15000ms" would be near-undebuggable. Holding the port is the cheapest way
  // to make farmd exit during startup: uvicorn cannot bind, so the helper's
  // exit handler has to be what reports it.
  const port = await freePort()
  const squatter = createServer()
  await new Promise((resolve, reject) => {
    squatter.once('error', reject)
    squatter.listen(port, '127.0.0.1', resolve)
  })

  const started = Date.now()
  try {
    await assert.rejects(
      startTestFarmd({ repoRoot: REPO_ROOT, farmPort: port, readyTimeoutMs: 60_000 }),
      (err) => {
        // The fail-fast path, not the deadline — with a 60s timeout, reaching
        // the timeout branch at all would be the bug.
        assert.match(err.message, /exited before becoming ready/)
        // And the captured stderr, which is what actually names the cause.
        assert.match(err.message, new RegExp(String(port)), 'the error does not name the port')
        assert.match(err.message, /farmd\.err/, 'the error does not include the captured stderr')
        return true
      },
    )
  } finally {
    squatter.close()
  }
  assert.ok(Date.now() - started < 30_000, 'the helper burned its whole readiness budget instead of failing fast')
})

test('the sweep ignores directories that are not FARM_HOMEs it created', (t) => {
  const root = scratchRoot(t)
  const unrelated = path.join(root, 'horizon-orch-reconcile-e2e-abc')
  mkdirSync(unrelated, { recursive: true })
  const longAgo = Date.now() / 1000 - 60 * 60 * 24
  utimesSync(unrelated, longAgo, longAgo)

  const result = sweepStaleTestFarmds({ root })

  assert.deepEqual(result.removed, [])
  assert.ok(existsSync(unrelated), 'the sweep is scoped to its own prefix, not to everything old in tmp')
})

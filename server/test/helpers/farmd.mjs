// HZ-138: the ONLY place a Node test may start a real farmd.
//
// orchestrator-reconcile-e2e.test.mjs used to spawn one inline with
// `env: { ...process.env, ... }` and clean it up in a `test.after` hook. Both
// halves of that were wrong:
//
//   * Inheriting the environment handed the daemon the agent's real
//     HORIZON_URL (http://127.0.0.1:3001 — production) and the real
//     FARM_SHARED_SECRET. A leaked test daemon was therefore calling
//     production back on its reconcile loop. Only the fact that test run ids
//     start at 1 while production's are in the hundreds kept those callbacks
//     from landing — luck, not isolation.
//   * An after-hook never runs when the runner is SIGKILLed or dies of EPIPE,
//     which is precisely what farm/checks.py's subprocess timeout does to it.
//
// So: the environment is an explicit allow-list (never a spread of
// process.env), HORIZON_URL points at an in-test recording sink, the secret is
// a literal test value, and the kill link lives in the kernel via
// farmd_launcher.py's PR_SET_PDEATHSIG. The exit/signal handlers and the
// stale-FARM_HOME sweep below are a redundant second layer, not the
// guarantee.
//
// This file is not a test and is not collected: server/package.json globs
// `test/*.test.mjs`, so `test/helpers/` never runs on its own.

import { spawn, spawnSync } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// A literal, so a test can assert on it and so grepping for it finds every
// place the test secret is referenced. Never the inherited value.
export const TEST_SHARED_SECRET = 'hz138-test-only'

// Every FARM_HOME this helper creates carries this prefix — it is what makes
// the sweep and the leaked-daemon check able to recognise a test daemon's
// home without ever matching on a process name.
export const FARM_HOME_PREFIX = 'horizon-farmd-e2e-'

export const PIDFILE_NAME = 'farmd.pid'
export const ERRLOG_NAME = 'farmd.err'

// A directory this old cannot belong to a run still in flight (the whole e2e
// suite takes seconds), so it is safe to delete. Everything younger is left
// alone even when its daemon is already gone, because its farmd.err is the
// only diagnostic a concurrent test has.
const STALE_DIR_AGE_MS = 30 * 60 * 1000

const HELPERS_DIR = import.meta.dirname
const LAUNCHER = path.join(HELPERS_DIR, 'farmd_launcher.py')

// ---------------------------------------------------------------------------
// interpreter resolution
// ---------------------------------------------------------------------------

// Deliberately NOT `FARM_PYTHON`: in farm/run.sh that name means "the
// interpreter used to BUILD the venv" (it is set to a bare `python3.12` in the
// farm's own agent environment), so honouring it here would put the test
// straight back on a bare system interpreter — the thing success metric 6
// forbids. A test-only override gets a test-only name.
export const PYTHON_OVERRIDE_VAR = 'FARM_TEST_PYTHON'

export function farmPythonCandidates(repoRoot) {
  return [
    // The workspace's own venv, when someone has run farm/run.sh here.
    path.join(repoRoot, 'farm', '.venv', 'bin', 'python'),
    // The deployed venv. farm/.venv is gitignored and so is absent from every
    // item worktree, which makes this the candidate that normally wins. Read
    // only: we execute the interpreter and never write under /opt.
    '/opt/horizon/farm/.venv/bin/python',
  ]
}

// `candidates` is a seam for the resolver's own unit tests: both real
// candidates exist on the deploy host, so the not-found branch is otherwise
// unreachable there.
export function resolveFarmPython(repoRoot, env = process.env, candidates = farmPythonCandidates(repoRoot)) {
  const override = env[PYTHON_OVERRIDE_VAR]?.trim()
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`${PYTHON_OVERRIDE_VAR}=${override} does not exist — point it at a farm venv's bin/python.`)
    }
    return override
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Fail loud. Falling back to bare `python3` is what made this test depend
  // on whatever the host interpreter happened to have installed.
  throw new Error(
    [
      'no farm venv interpreter found — refusing to fall back to a bare `python3`.',
      'Looked for:',
      ...candidates.map((c) => `  ${c}`),
      `Create the workspace venv with \`farm/run.sh\`, or set ${PYTHON_OVERRIDE_VAR} to a venv's bin/python.`,
    ].join('\n'),
  )
}

const probed = new Map()

// A stale or half-built venv otherwise shows up only as "did not become ready
// within 15000ms", which says nothing about the cause.
export function assertFarmPythonUsable(python) {
  if (probed.has(python)) {
    // `true` means it passed; anything else is the failure message itself.
    if (probed.get(python) === true) return
    throw new Error(probed.get(python))
  }
  const probe = spawnSync(python, ['-c', 'import uvicorn, fastapi, httpx'], { encoding: 'utf8' })
  if (probe.status === 0) {
    probed.set(python, true)
    return
  }
  const message = [
    `${python} cannot import farmd's dependencies (uvicorn, fastapi, httpx) — the venv is missing or stale.`,
    `Rebuild it with \`farm/run.sh\`, or set ${PYTHON_OVERRIDE_VAR} to a working venv's bin/python.`,
    (probe.stderr || probe.stdout || '').trim(),
  ]
    .filter(Boolean)
    .join('\n')
  probed.set(python, message)
  throw new Error(message)
}

// ---------------------------------------------------------------------------
// the spawn environment — an allow-list, never a spread
// ---------------------------------------------------------------------------

// Fixed key set, so a test can assert the WHOLE set rather than picking at
// individual names: every one of these is always written, none is "inherited
// if present". That is what keeps the assertion host-independent.
export const FARMD_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'TMUX_TMPDIR',
  'HORIZON_URL',
  'FARM_SHARED_SECRET',
  'FARM_PORT',
  'FARM_HOME',
  'FARM_CLAUDE_BIN',
  'FARM_RECONCILE_INTERVAL_S',
  'FARMD_TEST_TTL_S',
]

// Named so the reason each is withheld is on the record. Dropped by omission,
// not by unsetting: HORIZON_URL and FARM_SHARED_SECRET both have production-
// shaped DEFAULTS in farm/config.py (HORIZON_URL falls back to
// http://localhost:3001), so an absent key would be no safer than an
// inherited one. They are overwritten, never removed.
export const FARMD_ENV_WITHHELD = [
  'HORIZON_DB', // the server's DB; farmd has no business opening it
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY', // also keeps farm/providers/claude.py's HZ-5 boot guardrail quiet
  'FARM_WA_ENABLED', // the WhatsApp concierge must not start in a test
  'FARM_PROVIDER',
  'FARM_MUSE_BIN',
  'TMUX', // being inside a pane; `tmux has-session` does not need it
]

export function buildFarmdEnv({
  farmPort,
  farmHome,
  repoRoot,
  horizonUrl,
  sharedSecret = TEST_SHARED_SECRET,
  reconcileIntervalS = 3600,
  ttlS = 900,
  inherited = process.env,
}) {
  if (!horizonUrl) throw new Error('buildFarmdEnv requires an explicit horizonUrl — never let farmd default it')
  return {
    // PATH and HOME are inherited on purpose: farmd shells out to `tmux`,
    // whose binary and default socket directory both come from them. Neither
    // carries a Horizon address or credential.
    PATH: inherited.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: inherited.HOME ?? '/tmp',
    LANG: 'C.UTF-8',
    // Python's tempfile lands inside the FARM_HOME we delete on stop().
    TMPDIR: farmHome,
    // tmux resolves its socket under TMUX_TMPDIR (default /tmp). The test
    // creates sessions with its own inherited environment, so farmd has to
    // look at the same server or `has-session` would answer about nothing.
    TMUX_TMPDIR: inherited.TMUX_TMPDIR ?? '/tmp',
    HORIZON_URL: horizonUrl,
    FARM_SHARED_SECRET: sharedSecret,
    FARM_PORT: String(farmPort),
    FARM_HOME: farmHome,
    FARM_CLAUDE_BIN: path.join(repoRoot, 'farm', 'tests', 'fake_claude'),
    // The boot-time reconcile pass is what these tests want; the background
    // loop firing mid-test is not.
    FARM_RECONCILE_INTERVAL_S: String(reconcileIntervalS),
    FARMD_TEST_TTL_S: String(ttlS),
  }
}

// ---------------------------------------------------------------------------
// /proc readers — used to prove things about a pid, never to search for one
// ---------------------------------------------------------------------------

export function procCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
  } catch {
    return null
  }
}

export function procEnviron(pid) {
  try {
    const out = {}
    for (const entry of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      if (!entry) continue
      const eq = entry.indexOf('=')
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    return out
  } catch {
    return null
  }
}

// An EXACT argv element, not a substring of one: `python -m farm.farmd` has
// `farm.farmd` as its own argument, while a shell whose -c script merely
// mentions the string does not. That distinction keeps both the sweep's
// ownership proof and the leak check's process list free of anything that
// happens to quote the name (`pgrep -f 'farm.farmd'` matches itself, for one).
export function isFarmdCmdline(cmdline) {
  return Array.isArray(cmdline) && cmdline.includes('farm.farmd')
}

// state and ppid together, because every caller wants both and the parse is
// the fiddly bit: comm sits in parentheses and may itself contain spaces, so
// the fields are counted from the LAST ')'.
export function procStat(pid) {
  let raw
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return null
  }
  const close = raw.lastIndexOf(')')
  if (close < 0) return null
  const fields = raw.slice(close + 2).split(' ')
  return { state: fields[0], ppid: Number(fields[1]) }
}

// Zombie-aware: `process.kill(pid, 0)` succeeds against a zombie, so a poll
// built on it can fail purely on a reaping delay.
export function procAlive(pid) {
  const stat = procStat(pid)
  return stat !== null && stat.state !== 'Z'
}

export async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!procAlive(pid)) return true
    await sleep(100)
  }
  return !procAlive(pid)
}

// ---------------------------------------------------------------------------
// the sweep — layer 2, for orphans an earlier run's kernel link never caught
// ---------------------------------------------------------------------------

// Selection is by RECORDED PID, read out of the pidfile in a FARM_HOME this
// helper created. The three /proc reads below are ownership PROOF against pid
// reuse, not a search: nothing here ever matches on a process name, so a
// production farmd can never be a candidate (guardrail 4).
//
// The ppid === 1 condition is load-bearing, not belt-and-braces:
// `node --test` runs test FILES in parallel, so a sibling test's farmd is
// alive, is genuinely a test farmd, and would satisfy both the cmdline and
// FARM_HOME checks. Only an orphan is stale, and an orphan is exactly what
// ppid === 1 means.
export function sweepStaleTestFarmds({ root = tmpdir(), maxDirAgeMs = STALE_DIR_AGE_MS, now = Date.now() } = {}) {
  const killed = []
  const removed = []
  const skipped = []

  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return { killed, removed, skipped }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(FARM_HOME_PREFIX)) continue
    const dir = path.join(root, entry.name)
    const pid = readPidfile(dir)

    if (pid === null) {
      // No pid recorded — either the launcher never got that far, or this dir
      // belongs to a run that is mid-spawn right now. Age is the only safe
      // discriminator.
      if (olderThan(dir, now, maxDirAgeMs)) {
        rmSync(dir, { recursive: true, force: true })
        removed.push(dir)
      } else {
        skipped.push({ dir, reason: 'no pidfile yet' })
      }
      continue
    }

    const cmdline = procCmdline(pid)
    if (cmdline === null) {
      // The daemon is gone. Keep the directory while it is young: its
      // farmd.err may be the error message a running test is about to print.
      if (olderThan(dir, now, maxDirAgeMs)) {
        rmSync(dir, { recursive: true, force: true })
        removed.push(dir)
      } else {
        skipped.push({ dir, pid, reason: 'process already gone, directory still fresh' })
      }
      continue
    }
    if (!isFarmdCmdline(cmdline)) {
      skipped.push({ dir, pid, reason: 'pid has been reused by something that is not farmd' })
      continue
    }
    const environ = procEnviron(pid)
    if (environ?.FARM_HOME !== dir) {
      skipped.push({ dir, pid, reason: `pid's FARM_HOME is ${environ?.FARM_HOME ?? '<unset>'}, not this directory` })
      continue
    }
    const stat = procStat(pid)
    if (stat?.ppid !== 1) {
      skipped.push({ dir, pid, reason: `still parented to ${stat?.ppid} — a live run owns it` })
      continue
    }

    if (!killTestFarmd(pid)) {
      // Another sweep beat us to it, or it is not ours to signal. Either way
      // the directory stays: reporting a kill that did not happen is worse
      // than leaving one directory behind.
      skipped.push({ dir, pid, reason: 'could not be signalled' })
      continue
    }
    killed.push(pid)
    rmSync(dir, { recursive: true, force: true })
    removed.push(dir)
  }

  return { killed, removed, skipped }
}

function readPidfile(dir) {
  try {
    const pid = Number(readFileSync(path.join(dir, PIDFILE_NAME), 'utf8').trim())
    return Number.isInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

function olderThan(dir, now, maxAgeMs) {
  try {
    return now - statSync(dir).mtimeMs > maxAgeMs
  } catch {
    return false
  }
}

// Targets the process GROUP the spawn created (`detached: true` makes the
// daemon its own group leader, so pgid === pid), which reaps anything it
// started without ever widening past our own spawn.
export function killTestFarmd(pid) {
  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'ESRCH') {
      try {
        process.kill(pid, 'SIGKILL')
        return true
      } catch {
        return false
      }
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// the recording sink — where a test farmd's callbacks are allowed to go
// ---------------------------------------------------------------------------

// A real HTTP server on a test-owned port. It answers everything 200
// {"ok": true} so farmd takes its success path and never retries, and records
// what it received — which turns isolation from "production saw nothing" into
// a positive assertion about where the daemon actually called.
async function startSink() {
  const requests = []
  const server = createHttpServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body = raw
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        // keep the raw text — a malformed body is itself worth asserting on
      }
      requests.push({ method: req.method, path: req.url, headers: req.headers, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // `active: true` keeps farmd's _notify_started on the "run is still
      // live" path, so a seeded stale run goes on to the /fail report.
      res.end(JSON.stringify({ ok: true, active: true }))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  server.unref()
  return { url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, requests, server }
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const liveStops = new Set()
let handlersInstalled = false

// Layer 2 only. These cover a clean exit, an uncaught exception (Node still
// runs 'exit' handlers) and Ctrl-C. They CANNOT cover SIGKILL or an EPIPE
// death, which is why farmd_launcher.py exists.
function installHandlers() {
  if (handlersInstalled) return
  handlersInstalled = true
  const stopAll = () => {
    for (const stop of [...liveStops]) {
      try {
        stop()
      } catch {
        // a failed stop must not prevent the others
      }
    }
  }
  process.on('exit', stopAll)
  for (const [signal, number] of [
    ['SIGINT', 2],
    ['SIGHUP', 1],
    ['SIGTERM', 15],
  ]) {
    process.on(signal, () => {
      stopAll()
      process.exit(128 + number)
    })
  }
  // Deliberately no 'uncaughtException' handler: installing one would swallow
  // failures node:test is supposed to report, and 'exit' already covers it.
}

function errTail(errPath, lines = 20) {
  try {
    const text = readFileSync(errPath, 'utf8').trimEnd()
    if (!text) return ''
    return `--- ${ERRLOG_NAME} (last ${lines} lines) ---\n${text.split('\n').slice(-lines).join('\n')}`
  } catch {
    return ''
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Spawns a real farmd that cannot outlive this process and cannot reach
 * production, and resolves once it answers /runs/alive.
 *
 * Returns { pid, url, home, env, python, sinkUrl, sinkRequests, stop }.
 */
export async function startTestFarmd({
  repoRoot,
  farmPort,
  ttlS = 900,
  reconcileIntervalS = 3600,
  seedActiveRuns = [],
  readyTimeoutMs = 15_000,
  sweep = true,
} = {}) {
  if (!repoRoot) throw new Error('startTestFarmd requires repoRoot')

  // Clears orphans an earlier, pre-HZ-138 run may have left behind, so a
  // stale daemon from another worktree cannot fail this run's leak check.
  if (sweep) sweepStaleTestFarmds()

  const python = resolveFarmPython(repoRoot)
  assertFarmPythonUsable(python)

  const home = mkdtempSync(path.join(tmpdir(), FARM_HOME_PREFIX))
  const errPath = path.join(home, ERRLOG_NAME)

  // Seeded BEFORE spawn so farmd's boot-time _reconcile_claimed_runs() pass
  // sees it — that is the code path that called production.
  if (seedActiveRuns.length > 0) {
    const activeDir = path.join(home, 'queue', 'runs', 'active')
    mkdirSync(activeDir, { recursive: true })
    for (const task of seedActiveRuns) {
      writeFileSync(path.join(activeDir, `${task.run_id}.json`), JSON.stringify(task))
    }
  }

  const sink = await startSink()
  const port = farmPort ?? (await freePort())
  const env = buildFarmdEnv({
    farmPort: port,
    farmHome: home,
    repoRoot,
    horizonUrl: sink.url,
    reconcileIntervalS,
    ttlS,
  })
  const url = `http://127.0.0.1:${port}`

  const errFd = openSync(errPath, 'a')
  let proc
  try {
    proc = spawn(python, [LAUNCHER], {
      cwd: repoRoot,
      env,
      // Captured, not discarded: this changes the interpreter AND strips the
      // environment, so a boot failure needs to say what actually broke.
      stdio: ['ignore', errFd, errFd],
      // Its own process group, so stop() can never signal anything outside
      // the subtree this call created.
      detached: true,
    })
  } finally {
    closeSync(errFd)
  }

  // The launcher writes this too, earlier in its own life; both write the
  // same value. Doing it here as well means a dir is sweepable even if the
  // launcher died before its own write.
  try {
    writeFileSync(path.join(home, PIDFILE_NAME), String(proc.pid))
  } catch {
    // a missing pidfile costs us the sweep, not the kernel guarantee
  }

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    liveStops.delete(stop)
    killTestFarmd(proc.pid)
    try {
      sink.server.close()
    } catch {
      // already closed
    }
    rmSync(home, { recursive: true, force: true })
  }

  installHandlers()
  liveStops.add(stop)
  // A detached child still refs the event loop; without this a stop() that
  // raced or threw would hang `node --test` instead of letting it exit.
  proc.unref()

  const farmd = {
    pid: proc.pid,
    url,
    home,
    env,
    python,
    launcher: LAUNCHER,
    errPath,
    sinkUrl: sink.url,
    sinkPort: sink.port,
    sinkRequests: sink.requests,
    stop,
  }

  try {
    await waitUntilReady(url, readyTimeoutMs, proc, errPath)
  } catch (err) {
    stop()
    throw err
  }
  return farmd
}

async function waitUntilReady(url, timeoutMs, proc, errPath) {
  let exited = null
  let spawnError = null
  proc.once('exit', (code, signal) => {
    exited = { code, signal }
  })
  proc.once('error', (err) => {
    spawnError = err
  })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`farmd could not be spawned: ${spawnError.message}`)
    // Fail fast rather than burning the whole timeout on a process that has
    // already given up (a missing dependency, or a port already bound).
    if (exited) {
      throw new Error(
        [
          `farmd exited before becoming ready at ${url} (code=${exited.code} signal=${exited.signal})`,
          errTail(errPath),
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
    try {
      const res = await fetch(`${url}/runs/alive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_ids: [] }),
        // Bounded, because fetch has no default timeout: something else
        // already holding this port can accept the connection and then never
        // answer, which would park this loop past its own deadline forever.
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) return
    } catch {
      // farmd hasn't bound the port yet — keep polling.
    }
    await sleep(100)
  }
  throw new Error(
    [`farmd at ${url} did not become ready within ${timeoutMs}ms`, errTail(errPath)].filter(Boolean).join('\n'),
  )
}

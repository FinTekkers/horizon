// HO-881: the scratch world behind sl-path-e2e.test.mjs — a temp root, the
// fake sl/jf/eden/git/gh on PATH, one ordered call log, and a real farmd
// child whose every spawn is recorded.
//
// Everything lives under one root, made with farmd.mjs's FARM_HOME_PREFIX so
// that helper's stale-daemon sweep can recognise it. farmd's FARM_HOME is the
// root itself:
//
//   <root>/horizon.db        the server's DB (HORIZON_DB)
//   <root>/bin/              shims: sl, jf, eden, git, gh → slPath/fake_vcs.py
//   <root>/fake-vcs.json     the fake remote: master, Phabricator diffs, checkouts
//   <root>/calls.jsonl       the one ordered log: shims, farmd's recorder, the server
//   <root>/push.log          one line per `sl push` that pushed a commit
//   <root>/home/             HOME for farmd and the shims
//   <root>/sl/...            farmd's sl checkouts (farm/vcs/sl.py)
//
// Not a test: server/package.json globs `test/*.test.mjs`, so `test/helpers/`
// never runs on its own.

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  FARMD_ENV_KEYS,
  FARM_HOME_PREFIX,
  PIDFILE_NAME,
  TEST_SHARED_SECRET,
  assertFarmPythonUsable,
  buildFarmdEnv,
  freePort,
  killTestFarmd,
  resolveFarmPython,
} from './farmd.mjs'

const HELPERS_DIR = import.meta.dirname
const SL_PATH_DIR = path.join(HELPERS_DIR, 'slPath')
const FAKE_VCS = path.join(SL_PATH_DIR, 'fake_vcs.py')
const LAUNCHER = path.join(HELPERS_DIR, 'farmd_launcher.py')
export const REPO_ROOT = path.resolve(HELPERS_DIR, '..', '..', '..')

// The farm child's env is farmd.mjs's allow-list plus exactly these keys.
export const SL_PATH_ENV_EXTRA_KEYS = [
  'PYTHONPATH', // slPath/, so sitecustomize.py records every spawn
  'PYTHONDONTWRITEBYTECODE', // no __pycache__ beside sitecustomize.py
  'SL_PATH_CALL_LOG',
  'SL_PATH_PUSH_LOG',
  'SL_PATH_FAKE_STATE',
  'TASK_DRIVER', // 'stub': farm/task_driver.py's in-memory Tasks double
  'FARM_SL_USE_EDEN', // '0': plain `sl clone`, never eden
]
export const SL_PATH_ENV_KEYS = [...FARMD_ENV_KEYS, ...SL_PATH_ENV_EXTRA_KEYS]

const SHIMS = ['sl', 'jf', 'eden', 'git', 'gh']

// The scratch root, its fake bin dir and the fake remote's first commit.
export function makeScratch() {
  const python = resolveFarmPython(REPO_ROOT)
  assertFarmPythonUsable(python)
  const root = mkdtempSync(path.join(tmpdir(), FARM_HOME_PREFIX))
  const binDir = path.join(root, 'bin')
  mkdirSync(binDir)
  mkdirSync(path.join(root, 'home'))
  for (const name of SHIMS) {
    const shim = path.join(binDir, name)
    writeFileSync(shim, `#!/bin/sh\nexec '${python}' -I '${FAKE_VCS}' ${name} "$@"\n`)
    chmodSync(shim, 0o755)
  }
  const statePath = path.join(root, 'fake-vcs.json')
  const base = { node: '0'.repeat(39) + '1', desc: 'scratch base commit', files: {} }
  writeFileSync(statePath, JSON.stringify({ counter: 1, next_diff: 0, master: [base], diffs: {}, checkouts: {} }))
  const callLog = path.join(root, 'calls.jsonl')
  const pushLog = path.join(root, 'push.log')
  writeFileSync(callLog, '')
  writeFileSync(pushLog, '')
  return { root, python, binDir, statePath, callLog, pushLog, dbPath: path.join(root, 'horizon.db') }
}

// One line on the shared ordered log, from this (the server's) process.
export function recordServer(scratch, entry) {
  appendFileSync(scratch.callLog, JSON.stringify({ src: 'server', pid: process.pid, ...entry }) + '\n')
}

export function readCalls(scratch) {
  return readFileSync(scratch.callLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function readPushes(scratch) {
  return readFileSync(scratch.pushLog, 'utf8').split('\n').filter(Boolean)
}

// A Phabricator reviewer's act on the fake remote — the test's own write.
// Whether production then reads it is what the call log shows.
export function setDiffStatus(scratch, diff, status) {
  const state = JSON.parse(readFileSync(scratch.statePath, 'utf8'))
  const n = diff.replace(/^D/, '')
  if (!Object.hasOwn(state.diffs, n)) throw new Error(`the fake has no ${diff}`)
  state.diffs[n].status = status
  writeFileSync(scratch.statePath, JSON.stringify(state, null, 1))
}

// The farm child's env: farmd.mjs's allow-list (never a spread of
// process.env), with PATH and HOME inside the scratch root, plus
// SL_PATH_ENV_EXTRA_KEYS. No token of any kind is in it.
export function farmChildEnv(scratch, { farmPort, horizonUrl }) {
  const base = buildFarmdEnv({ farmPort, farmHome: scratch.root, repoRoot: REPO_ROOT, horizonUrl, sharedSecret: TEST_SHARED_SECRET })
  return {
    ...base,
    PATH: `${scratch.binDir}:/usr/bin:/bin`,
    HOME: path.join(scratch.root, 'home'),
    TMUX_TMPDIR: scratch.root,
    PYTHONPATH: SL_PATH_DIR,
    PYTHONDONTWRITEBYTECODE: '1',
    SL_PATH_CALL_LOG: scratch.callLog,
    SL_PATH_PUSH_LOG: scratch.pushLog,
    SL_PATH_FAKE_STATE: scratch.statePath,
    TASK_DRIVER: 'stub',
    FARM_SL_USE_EDEN: '0',
  }
}

// Where farmd's own calls to HORIZON_URL go: a recording sink, never a real
// server. farmd's /vcs and Task routes make none; its boot loops might.
async function startSink() {
  const requests = []
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.unref()
  return { url: `http://127.0.0.1:${server.address().port}`, requests, server }
}

// A real farmd, running (its saved state names a project, so it adopts it at
// boot), on `farmPort`. It dies with this process (farmd_launcher.py's
// PR_SET_PDEATHSIG) and on stop().
export async function startSlFarmd(scratch, { farmPort, readyTimeoutMs = 20_000 } = {}) {
  const port = farmPort ?? (await freePort())
  const sink = await startSink()
  const env = farmChildEnv(scratch, { farmPort: port, horizonUrl: sink.url })
  mkdirSync(path.join(scratch.root, 'state'), { recursive: true })
  writeFileSync(path.join(scratch.root, 'state', 'farmd-state.json'), JSON.stringify({ project: { id: 1, name: 'sl scratch' }, repos: [] }))
  const errPath = path.join(scratch.root, 'farmd.err')
  const errFd = openSync(errPath, 'a')
  let proc
  try {
    proc = spawn(scratch.python, [LAUNCHER], { cwd: REPO_ROOT, env, stdio: ['ignore', errFd, errFd], detached: true })
  } finally {
    closeSync(errFd)
  }
  writeFileSync(path.join(scratch.root, PIDFILE_NAME), String(proc.pid))
  proc.unref()
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    killTestFarmd(proc.pid)
    sink.server.close()
  }
  process.on('exit', stop)
  const url = `http://127.0.0.1:${port}`
  const errTail = () => (existsSync(errPath) ? readFileSync(errPath, 'utf8').split('\n').slice(-30).join('\n') : '')
  const deadline = Date.now() + readyTimeoutMs
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      stop()
      throw new Error(`farmd exited before it was ready\n${errTail()}`)
    }
    try {
      const res = await fetch(`${url}/farm/status`, { signal: AbortSignal.timeout(2000) })
      if (res.ok && (await res.json()).status === 'running') break
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      stop()
      throw new Error(`farmd was not running within ${readyTimeoutMs}ms\n${errTail()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { pid: proc.pid, url, env, sinkRequests: sink.requests, errTail, stop }
}

// The implement step's farm-side work, which no production code does for an
// sl item yet: farm/vcs/sl.py's own checkout() makes the item's checkout (a
// plain `sl clone` of the fake remote), under the same recording env as
// farmd. Then the "agent" writes one file. Returns the checkout path.
const CHECKOUT_PY = 'import sys\nfrom farm.vcs import sl\nprint(sl.checkout(sys.argv[1], sys.argv[2]))'

export function implementInCheckout(scratch, env, { repo, itemId, file, text }) {
  const res = spawnSync(scratch.python, ['-c', CHECKOUT_PY, repo, itemId], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000 })
  if (res.status !== 0) throw new Error(`sl checkout failed (${res.status ?? res.signal}): ${res.stderr}`)
  const ws = res.stdout.trim()
  writeFileSync(path.join(ws, file), text)
  return ws
}

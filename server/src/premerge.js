// HZ-183: run the repo's checks on a test-merge before Accept the code merges.
//
// Two PRs that were each green have twice merged into a red main (HZ-130 x
// HZ-132, HZ-154 x HZ-156). performGateApproval() in app.js now calls
// runPreMergeChecks() before github.mergePr(), and merges only on ok:true.
//
// Node owns the gate; Python owns git and the checks. This is the only place
// Node knows about `python -m farm.premerge` (farm/premerge.py), which makes
// a scratch worktree under ~/.horizon-farm/workspaces/<repo>__premerge/, merges
// the PR head into the base tip there, and runs farm/checks.py — the one
// definition of which checks a repo has. Node never picks that path: argv
// carries the repo, the item id and two shas, nothing on the filesystem.
//
// FAIL CLOSED. Every outcome that is not a parsed ok:true from a zero exit —
// a red check, a timeout, a crash, a missing interpreter, unparseable output
// — is ok:false, and app.js refuses to merge on it. There is no flag that
// skips this.
//
// The spawn is isolated behind `runner` (like deploy.js) so tests replace it.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const FARM_DIR = process.env.HORIZON_FARM_DIR || path.resolve(import.meta.dirname, '../../farm')
const SHA_RE = /^[0-9a-f]{40}$/
// Matches farm/checks.py's CHECK_TAIL_LINES, for the one tail Node cuts
// itself: a crashed CLI's stderr.
const TAIL_LINES = 40

// The farm's own interpreter (farm/run.sh creates farm/.venv) has the farm's
// dependencies and pytest; plain python3 is the fallback for dev hosts.
function pythonBin() {
  if (process.env.PREMERGE_PYTHON) return process.env.PREMERGE_PYTHON
  const venv = path.join(FARM_DIR, '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : 'python3'
}

// The check run executes the PR's own code (its tests, its npm scripts), so it
// gets a minimal environment, never the server's: that holds
// WA_APPROVAL_SECRET (HZ-140 keeps it out of every agent's reach), the GitHub
// token, session secrets, and HORIZON_DB — a test that forgot to set its own
// DB path would otherwise write to production's. An allowlist, so a secret
// added to server.env later is excluded by default.
const CHILD_ENV_ALLOWED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'FARM_HOME', 'PLAYWRIGHT_BROWSERS_PATH']

export function childEnv(timeoutMs) {
  const env = {}
  for (const name of CHILD_ENV_ALLOWED) {
    if (Object.hasOwn(process.env, name)) env[name] = process.env[name]
  }
  env.FARM_CHECK_TIMEOUT_S = String(Math.floor(timeoutMs / 1000))
  return env
}

function tailLines(text) {
  const lines = String(text || '').trim().split('\n')
  if (lines.length <= TAIL_LINES) return lines.join('\n')
  return [`[earlier output trimmed — last ${TAIL_LINES} lines]`, ...lines.slice(-TAIL_LINES)].join('\n')
}

// HZ-227: a stderr line the CLI writes for the server, not for a human. Must
// match EVENT_PREFIX in farm/premerge.py (stderr_event).
const EVENT_PREFIX = 'HORIZON_EVENT '
const SLOT_EVENTS = ['queued', 'granted']

// 'queued' | 'granted' for a check_slots event line, else null.
export function parseSlotEvent(line) {
  if (typeof line !== 'string' || !line.startsWith(EVENT_PREFIX)) return null
  let event
  try {
    event = JSON.parse(line.slice(EVENT_PREFIX.length))
  } catch {
    return null
  }
  const name = event && typeof event === 'object' && Object.hasOwn(event, 'check_slot') ? event.check_slot : null
  return SLOT_EVENTS.includes(name) ? name : null
}

// HZ-250: the process group of each running check, by item id, so a
// self-deploy can stop exactly the runs it interrupts (interruptRun below).
// The child is spawned detached, so its pid is also its process group id.
const runningChecks = new Map()

export const runner = {
  // Resolves { code, stdout, stderr, timedOut, error } — never rejects. The
  // child leads its own process group so a timeout kills npm's and pytest's
  // descendants too, not just the python parent.
  //
  // onStderrLine (HZ-227), when given, also hears each complete stderr line as
  // it arrives. It is only an observer: `stderr` is accumulated exactly as
  // without it, and a listener that throws is ignored.
  //
  // itemId (HZ-250), when given, registers the run for interruptRun(); a run
  // it stopped resolves with `interrupted: true`.
  spawn(args, { cwd, timeoutMs, env, onStderrLine, itemId }) {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let partial = ''
      // Its own decoder: a multi-byte character split across chunks still
      // reaches the listener whole, and `stderr` is built as it always was.
      const decoder = new StringDecoder('utf8')
      let timedOut = false
      let settled = false
      let tracked = null
      const emitLine = (line) => {
        try {
          onStderrLine(line.endsWith('\r') ? line.slice(0, -1) : line)
        } catch {
          // fire-and-forget
        }
      }
      const splitLines = (chunk) => {
        if (!onStderrLine) return
        partial += decoder.write(chunk)
        const lines = partial.split('\n')
        partial = lines.pop()
        for (const line of lines) emitLine(line)
      }
      const flushLines = () => {
        if (!onStderrLine) return
        partial += decoder.end()
        if (partial === '') return
        const line = partial
        partial = ''
        emitLine(line)
      }
      const done = (out) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (tracked) {
          if (runningChecks.get(itemId) === tracked) runningChecks.delete(itemId)
          tracked.settle()
          if (tracked.interrupted) out = { ...out, interrupted: true }
        }
        resolve({ stdout, stderr, timedOut, ...out })
      }
      const child = spawn(pythonBin(), args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      if (itemId != null && Number.isInteger(child.pid)) {
        tracked = { pgid: child.pid, interrupted: false }
        tracked.settled = new Promise((resolveSettled) => (tracked.settle = resolveSettled))
        runningChecks.set(itemId, tracked)
      }
      const timer = setTimeout(() => {
        timedOut = true
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
        // Resolve now rather than on 'close': a descendant that left the
        // group could hold the pipes open, and the gate must not wait on it.
        child.stdout.destroy()
        child.stderr.destroy()
        done({ code: null })
      }, timeoutMs)
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => {
        stderr += d
        splitLines(d)
      })
      child.on('error', (error) => done({ code: null, error }))
      child.on('close', (code) => {
        flushLines()
        done({ code })
      })
    })
  },
}

// Returns the CLI's parsed result with a guaranteed boolean `ok`, plus
// `reason` on every ok:false. Never throws.
//
// onSlot (HZ-227) hears 'queued' when the run waits for a check slot and
// 'granted' when it gets one; a run that never waits calls it not at all.
// Fire-and-forget: it is never awaited and anything it throws is ignored.
export async function runPreMergeChecks(item, { headSha, baseSha, timeoutMs, onSlot }) {
  const shas = { head_sha: headSha, base_sha: baseSha }
  if (!SHA_RE.test(headSha || '') || !SHA_RE.test(baseSha || '')) {
    return { ok: false, reason: 'bad_input', detail: 'GitHub did not return full commit shas', ...shas }
  }
  const args = [
    '-m', 'farm.premerge', item.repo, item.id, headSha,
    '--base', baseSha,
    '--timeout-s', String(Math.floor(timeoutMs / 1000)),
    '--json',
  ]
  const spawnOpts = { cwd: path.dirname(FARM_DIR), timeoutMs, env: childEnv(timeoutMs), itemId: item.id }
  if (onSlot) {
    spawnOpts.onStderrLine = (line) => {
      const name = parseSlotEvent(line)
      if (!name) return
      try {
        onSlot(name)
      } catch {
        // fire-and-forget
      }
    }
  }
  const out = await runner.spawn(args, spawnOpts)
  if (out.interrupted) {
    return { ok: false, reason: 'interrupted', detail: DEPLOY_INTERRUPTED_DETAIL, ...shas }
  }
  if (out.timedOut) {
    return { ok: false, reason: 'timed_out', detail: `no result within ${Math.round(timeoutMs / 60000)} min`, ...shas }
  }
  if (out.error) {
    return { ok: false, reason: 'crash', detail: `could not start the check run: ${out.error.message}`, ...shas }
  }
  let parsed = null
  try {
    parsed = JSON.parse(String(out.stdout || '').trim())
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'crash', detail: `the check run exited ${out.code} without a result`, tail: tailLines(out.stderr), ...shas }
  }
  if (parsed.ok === true && out.code === 0) {
    // A green for some other pair of commits proves nothing about this one.
    if (parsed.head_sha !== headSha || parsed.base_sha !== baseSha) {
      return { ok: false, reason: 'crash', detail: 'the check run reported different commits than it was given', ...shas }
    }
    return { ...parsed, ok: true }
  }
  return { ...shas, ...parsed, ok: false, reason: parsed.reason || 'crash' }
}

const DEPLOY_INTERRUPTED_DETAIL = 'server restarted for deploy'

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal)
  } catch {
    // already gone
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// HZ-250: stops the item's running check — its whole process group, so npm's
// and pytest's descendants too: SIGTERM, then SIGKILL after graceMs. Only a
// group this module spawned and still tracks is ever signalled, never this
// server or another item's run. Resolves true once the group is gone, after
// the run itself has settled, so the gate's "stopped" event is already
// written; false when no run is tracked for the item.
export async function interruptRun(itemId, { graceMs = 5000 } = {}) {
  const run = runningChecks.get(itemId)
  if (!run || !(run.pgid > 1) || run.pgid === process.pid) return false
  run.interrupted = true
  signalGroup(run.pgid, 'SIGTERM')
  const termDeadline = Date.now() + graceMs
  while (groupAlive(run.pgid) && Date.now() < termDeadline) await sleep(25)
  if (groupAlive(run.pgid)) {
    signalGroup(run.pgid, 'SIGKILL')
    const killDeadline = Date.now() + 2000
    while (groupAlive(run.pgid) && Date.now() < killDeadline) await sleep(25)
  }
  // Let the gate record the outcome (it runs a few ticks after the child closes).
  let settleTimer
  await Promise.race([run.settled, new Promise((resolve) => (settleTimer = setTimeout(resolve, 2000)))])
  clearTimeout(settleTimer)
  await new Promise((resolve) => setImmediate(resolve))
  return !groupAlive(run.pgid)
}

const short = (sha) => String(sha || '').slice(0, 12)

// The activity-log line for an ok:false result. Names the failing check and
// carries the tail of its output — the last lines, where the test names are.
export function describeFailure(result) {
  const on = `the test-merge of ${short(result.base_sha)} + PR head ${short(result.head_sha)}`
  switch (result.reason) {
    case 'checks_failed':
      return `pre-merge checks failed on ${on} — ${result.failing_check} — the gate stays open:\n${result.tail || '(no output)'}`
    case 'timed_out':
      return `pre-merge checks did not finish on ${on}${result.failing_check ? ` (stopped at ${result.failing_check})` : ''}: ${result.detail || 'timed out'}. Raise PREMERGE_CHECK_TIMEOUT_MS or click Accept again on an idle host`
    case 'merge_conflict':
      return `the PR does not merge cleanly into the current base (${short(result.base_sha)}) — resolve the conflict first`
    case 'no_checks_detected':
      return `no repo checks were detected on ${on}, so nothing proves the merge is safe — add a test script (or FARM_CHECK_CMD) for this repo`
    case 'no_hub':
      return 'the farm has no checkout of this repo to test-merge in — start the farm so the repo hub exists, then click Accept again'
    case 'busy':
      return 'pre-merge checks are already running for this item'
    case 'interrupted':
      return `pre-merge checks were stopped: ${result.detail || DEPLOY_INTERRUPTED_DETAIL} — click Accept again once Horizon is back`
    default: {
      const detail = result.detail ? `: ${result.detail}` : ''
      const tail = result.tail ? `\n${result.tail}` : ''
      return `pre-merge checks could not run (${result.reason || 'crash'})${detail}${tail}`
    }
  }
}

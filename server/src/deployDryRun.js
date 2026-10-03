// HZ-258: a deploy target's Dry run — five read-only checks (script, repo dir,
// service, sudo, health) the owner can run from Admin at any time.
//
// Read-only by construction: the deploy script is only ever stat'ed, never
// run, and the only programs spawned are bare `git`, `systemctl` and `sudo`
// (found via PATH) with the read-only verbs in isReadOnly() — anything else
// throws before it spawns. Nothing here writes to the database or the repo
// dir; git runs with GIT_OPTIONAL_LOCKS=0 so it never refreshes .git/index.
//
// Every value probed comes from the target row as stored. The containment
// rule for the script and the sudoers service allow-list are deployTargets.js's
// own helpers, not copies. Each check is bounded by the timeout on its own,
// and the checks run side by side, so one hung probe cannot hold up the rest.
//
// Reasons are fixed wording plus row values and exit codes: a child's stderr,
// the origin URL (it may embed a token) and the environment are never echoed,
// and children get a minimal env, so $GITHUB_TOKEN and friends never reach
// them.

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { DRY_RUN_TIMEOUT_MS } from './config.js'
import {
  scriptInsideScriptsDir,
  scriptPath,
  serviceAllowed,
  serviceNotAllowedReason,
  servicesInSudoersText,
} from './deployTargets.js'

export const DRY_RUN_CHECKS = Object.freeze(['script', 'repo dir', 'service', 'sudo', 'health'])

const HELPERS = Object.freeze({ scriptInsideScriptsDir, serviceAllowed, servicesInSudoersText })

const SYSTEMCTL_VERBS = new Set(['is-active', 'status', 'show', 'cat'])
const MAX_STDOUT = 64 * 1024

function isReadOnly(cmd, args) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return false
  if (cmd === 'sudo') return args.length === 2 && args[0] === '-n' && args[1] === '-l'
  if (cmd === 'systemctl') return SYSTEMCTL_VERBS.has(args[0])
  if (cmd === 'git') {
    const rest = args[0] === '-C' ? args.slice(2) : args
    if (rest[0] === 'rev-parse') return true
    return rest[0] === 'remote' && rest[1] === 'get-url'
  }
  return false
}

function probeEnv() {
  const env = { LANG: 'C', GIT_OPTIONAL_LOCKS: '0' }
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME
  return env
}

// Runs one read-only probe: resolves { code, stdout, timedOut }, never
// rejects. Throws (before spawning) on any command not in isReadOnly(). The
// child gets its own process group so a timeout kills it and anything it
// started, and the promise settles at the deadline even if a grandchild still
// holds stdout.
export function execProbe(cmd, args, timeoutMs) {
  if (!isReadOnly(cmd, args)) throw new Error(`dry run refused a command that is not read-only: ${cmd}`)
  if (!(timeoutMs > 0)) return Promise.resolve({ code: null, stdout: '', timedOut: true })
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    let timer = null
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, timedOut: false, ...result })
    }
    let child
    try {
      child = spawn(cmd, args, { env: probeEnv(), stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    } catch {
      settle({ code: null })
      return
    }
    timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
      settle({ code: null, timedOut: true })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk
    })
    child.on('error', () => settle({ code: null }))
    child.on('close', (code) => settle({ code }))
  })
}

const pass = (reason) => ({ pass: true, reason })
const fail = (reason) => ({ pass: false, reason })

function exitDetail(result) {
  return result.code === null ? 'did not run' : `exit ${result.code}`
}

async function checkScript(target, { helpers }) {
  if (!helpers.scriptInsideScriptsDir(target.script)) return fail('script outside infra/host')
  try {
    await access(scriptPath(target), constants.X_OK)
  } catch {
    return fail('script not executable')
  }
  return pass('script found in infra/host and executable')
}

function originMatches(url, repo) {
  const normalized = url.trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase()
  const wanted = repo.toLowerCase()
  return normalized.endsWith(`/${wanted}`) || normalized.endsWith(`:${wanted}`)
}

async function checkRepoDir(target, { exec, remaining }) {
  const dir = target.repoDir
  if (typeof dir !== 'string' || !isAbsolute(dir)) return fail('bad repo dir')
  try {
    if (!(await stat(dir)).isDirectory()) return fail('repo dir missing')
  } catch {
    return fail('repo dir missing')
  }
  const inside = await exec('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], remaining())
  if (inside.timedOut) return fail(`git rev-parse timed out after ${remaining.total}ms`)
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return fail(`not a git work tree (${exitDetail(inside)})`)
  const origin = await exec('git', ['-C', dir, 'remote', 'get-url', 'origin'], remaining())
  if (origin.timedOut) return fail(`git remote get-url timed out after ${remaining.total}ms`)
  if (origin.code !== 0) return fail(`repo dir has no origin remote (${exitDetail(origin)})`)
  if (typeof target.repo !== 'string' || !originMatches(origin.stdout, target.repo)) {
    return fail(`origin is not ${target.repo}`)
  }
  return pass(`git work tree, origin is ${target.repo}`)
}

function targetServices(target) {
  const extras = target.extraServices ?? []
  return Array.isArray(extras) ? [target.service, ...extras] : null
}

async function checkService(target, { exec, remaining, helpers }) {
  const services = targetServices(target)
  if (!services) return fail('bad extraServices')
  for (const service of services) {
    if (!helpers.serviceAllowed(service)) return fail(serviceNotAllowedReason(service))
  }
  for (const service of services) {
    const result = await exec('systemctl', ['is-active', service], remaining())
    if (result.timedOut) return fail(`systemctl is-active ${service} timed out after ${remaining.total}ms`)
    if (result.code !== 0) return fail(`service ${service} is not active (${exitDetail(result)})`)
  }
  return pass(`${services.join(', ')} active`)
}

async function checkSudo(target, { exec, remaining, helpers }) {
  const services = (targetServices(target) ?? [target.service]).filter((s) => typeof s === 'string')
  const result = await exec('sudo', ['-n', '-l'], remaining())
  if (result.timedOut) return fail(`sudo -n -l timed out after ${remaining.total}ms`)
  if (result.code !== 0) return fail(`sudo would prompt or is denied (${exitDetail(result)})`)
  const allowed = helpers.servicesInSudoersText(result.stdout)
  for (const service of services) {
    if (!allowed.has(service)) return fail(`sudo does not allow restarting ${service}`)
  }
  return pass(`sudo -n allows restarting ${services.join(', ')}`)
}

async function checkHealth(target, { fetchImpl, timeoutMs }) {
  let url
  try {
    url = new URL(target.healthUrl)
  } catch {
    return fail('bad health URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('bad health URL')
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const res = await fetchImpl(url, { signal, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      return fail(`health returned redirect ${res.status} (redirects are not followed)`)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return fail(`health returned ${res.status}`)
    }
    if (target.healthCheckType === 'json-health') {
      let body
      try {
        body = await res.json()
      } catch (err) {
        if (signal.aborted) throw err
        return fail(`health returned ${res.status} but not JSON`)
      }
      if (body?.ok !== true) return fail(`health returned ${res.status} but JSON ok is not true`)
      return pass(`health responded ${res.status}, ok: true`)
    }
    await res.body?.cancel().catch(() => {})
    return pass(`health responded ${res.status}`)
  } catch {
    if (signal.aborted) return fail(`health timed out after ${timeoutMs}ms`)
    return fail('health unreachable')
  }
}

const PROBES = {
  script: checkScript,
  'repo dir': checkRepoDir,
  service: checkService,
  sudo: checkSudo,
  health: checkHealth,
}

// One check, bounded: it settles by the timeout whatever the probe does, and
// never throws.
function bounded(check, probe, timeoutMs) {
  let timer
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fail(`${check} check timed out after ${timeoutMs}ms`)), timeoutMs + 250)
  })
  const run = Promise.resolve()
    .then(probe)
    .catch(() => fail(`${check} check failed unexpectedly`))
  return Promise.race([run, limit]).then((result) => {
    clearTimeout(timer)
    return { check, pass: result.pass, reason: result.reason }
  })
}

// The five results, always in DRY_RUN_CHECKS order. Never throws.
export function runDryRun(
  target,
  { timeoutMs = DRY_RUN_TIMEOUT_MS, exec = execProbe, fetchImpl = globalThis.fetch, helpers = HELPERS } = {},
) {
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(0, deadline - Date.now())
  remaining.total = timeoutMs
  const ctx = { exec, fetchImpl, helpers, timeoutMs, remaining }
  return Promise.all(DRY_RUN_CHECKS.map((check) => bounded(check, () => PROBES[check](target, ctx), timeoutMs)))
}

// One Dry run per target at a time, held in memory only.
const running = new Set()

export function tryBeginDryRun(key) {
  if (running.has(key)) return false
  running.add(key)
  return true
}

export function endDryRun(key) {
  running.delete(key)
}

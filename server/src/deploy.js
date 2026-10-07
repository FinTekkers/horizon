// Self-deploy trigger for the "release published" webhook event
// (server/src/app.js's /api/webhooks/github handler). The guardrail is pure
// and unit-tested directly; the actual process spawn is isolated behind
// `runner` so tests can swap it out without shelling out to a real deploy
// script/systemd.
//
// Deploy targets live in Horizon's database, the deploy_target table (HZ-263,
// server/src/deployTargets.js) — the one source, read on every resolve with
// no cache, so an edited row applies to the next release. Agents run as the
// same unix user that owns horizon.db, so a row is agent-writable and never
// trusted as stored: every resolve re-validates it (script inside infra/host/
// after following symlinks; service and extra services permitted by the
// git-reviewed infra/host/horizon-deploy.sudoers, read from that file and
// never stored in the DB). A row that fails is logged and not deployed. That
// check stops bad rows, but the security boundary is still the sudoers file
// itself; repoDir and healthUrl are checked by format only. The webhook
// payload only ever selects a target by repo (repoFullName) — every
// filesystem path a deploy touches comes from the target, never from the
// payload itself.

import { spawn } from 'node:child_process'
import { readFileSync, existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PORT } from './config.js'
import { listTargets, findTargetByRepo, checkRunnable, scriptPath } from './deployTargets.js'

// Hit only on a release webhook or an Admin page load, both rare. A DB error
// fails closed to no targets rather than throwing and 500ing the webhook.
function loadRegistry() {
  try {
    return listTargets()
  } catch {
    return []
  }
}

export function resolveTarget(repoFullName) {
  if (!repoFullName) return null
  let target
  try {
    target = findTargetByRepo(repoFullName)
  } catch {
    return null
  }
  if (!target) return null
  const check = checkRunnable(target)
  if (!check.ok) {
    console.warn(`self-deploy: target ${target.key} failed validation (${check.reason}); not deploying`)
    return null
  }
  return target
}

export function isDeployableRelease(repoFullName, body) {
  if (!resolveTarget(repoFullName)) return false
  if (!body?.release || body.action !== 'published') return false
  // Drafts aren't published yet by definition; prereleases are deliberately
  // excluded too — the DevOps step never marks its releases as prerelease, so
  // one arriving here means someone/something else is publishing to this
  // repo, and production shouldn't restart on it.
  if (body.release.draft || body.release.prerelease) return false
  return true
}

function stateDirFor(target) {
  return join(homedir(), '.horizon', target.stateKey)
}

// What a deploy script inherits from this server's environment. Never the
// whole of it: server.env holds Horizon's own secrets (admin password, OAuth
// client, webhook and farm secrets), and the scripts build the target repo's
// code. A build tool also lets inherited variables win over the repo's own
// config, which is how ui-service's build picked up Horizon's Google OAuth
// client instead of the one in its .env.
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']

function inheritedEnv() {
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (INHERITED_ENV.includes(name) || name.startsWith('HORIZON_'))) env[name] = value
  }
  return env
}

// The deploy script's environment.
export function spawnEnv(target) {
  const env = {
    ...inheritedEnv(),
    HORIZON_REPO_DIR: target.repoDir,
    HORIZON_STATE_DIR: stateDirFor(target),
    HORIZON_SERVICE_NAME: target.service,
    HORIZON_HEALTH_URL: target.healthUrl,
    // Companion daemons this target must also restart. A long-running
    // process that outlives a deploy keeps running the old code (see
    // the restart stage in the deploy script); the registry names them
    // so the scripts stay service-agnostic.
    HORIZON_EXTRA_SERVICES: (target.extraServices || []).join(' '),
  }
  // HZ-250: only Horizon's own deploy restarts this server, so only it drains
  // this server's running pre-merge/resolve runs first (deploy-horizon.sh's
  // drain stage). Every other target's deploy is untouched.
  if (target.key === 'horizon') {
    env.HORIZON_DEPLOY_DRAIN_URL = `http://127.0.0.1:${PORT}/api/farm/deploy-drain`
    // deploy-drain.mjs authenticates to this server with it.
    if (process.env.FARM_SHARED_SECRET) env.FARM_SHARED_SECRET = process.env.FARM_SHARED_SECRET
  } else {
    delete env.HORIZON_DEPLOY_DRAIN_URL
  }
  return env
}

// Isolated so tests can replace `runner.spawn` instead of shelling out.
export const runner = {
  spawn(target, tag) {
    const child = spawn(scriptPath(target), [tag], {
      detached: true,
      stdio: 'ignore',
      env: spawnEnv(target),
    })
    child.unref()
  },
}

export function runDeploy(repoFullName, tag, log) {
  const target = resolveTarget(repoFullName)
  if (!target) return // isDeployableRelease already gated this; defensive only
  runner.spawn(target, tag)
  log?.info(`self-deploy: triggered ${target.script} for ${target.key} release ${tag}`)
}

// Parses a target's on-disk state (self-deploy.log + last-good-tag) for the
// read-only Admin panel. Never throws: a target that has never deployed
// simply has no state files yet.
function readState(stateDir) {
  const state = { lastTag: null, lastCommit: null, lastResult: 'never', lastAt: null }

  const logFile = join(stateDir, 'self-deploy.log')
  if (existsSync(logFile)) {
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
    const lastLine = lines[lines.length - 1]
    if (lastLine) {
      const [timestamp, ...rest] = lastLine.split(' ')
      state.lastAt = timestamp
      state.lastResult = rest.join(' ').startsWith('DEPLOY OK') ? 'ok' : 'failed'
    }
  }

  const lastGoodFile = join(stateDir, 'last-good-tag')
  if (existsSync(lastGoodFile)) {
    const content = readFileSync(lastGoodFile, 'utf8').trim()
    const sep = content.indexOf(':')
    if (sep !== -1) {
      state.lastTag = content.slice(0, sep)
      state.lastCommit = content.slice(sep + 1)
    }
  }

  return state
}

const LOG_TAIL_BYTES = 256 * 1024
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// HZ-333: where a deploy queue batch's release stands — 'live' once
// last-good-tag names it (the scripts write that file only after their health
// check passes), 'failed' once the log records DEPLOY FAILED for it, else
// 'pending'. Both log tag forms count, `(tag=<tag>)` and
// `(tag=refs/tags/<tag> commit=…)`, and never a neighbour (-b7 vs -b70).
export function deployOutcomeFor(target, tag) {
  const lastGoodFile = join(stateDirFor(target), 'last-good-tag')
  const ref = existsSync(lastGoodFile) ? readFileSync(lastGoodFile, 'utf8').trim().split(':')[0] : ''
  if (ref.replace(/^refs\/tags\//, '') === tag) return 'live'
  const logFile = join(stateDirFor(target), 'self-deploy.log')
  if (!existsSync(logFile)) return 'pending'
  const failed = new RegExp(`DEPLOY FAILED: .*\\(tag=(?:refs/tags/)?${escapeRegExp(tag)}[) ]`)
  return readTail(logFile).split('\n').some((line) => failed.test(line)) ? 'failed' : 'pending'
}

// The log's last LOG_TAIL_BYTES: polled every few seconds, so never the whole file.
function readTail(file) {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, LOG_TAIL_BYTES)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function listTargetStatuses() {
  return loadRegistry().map((target) => ({
    key: target.key,
    repo: target.repo,
    service: target.service,
    ...readState(stateDirFor(target)),
  }))
}

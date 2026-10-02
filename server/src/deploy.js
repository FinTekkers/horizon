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
import { readFileSync, existsSync } from 'node:fs'
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

// The deploy script's environment.
export function spawnEnv(target) {
  const env = {
    ...process.env,
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

export function listTargetStatuses() {
  return loadRegistry().map((target) => ({
    key: target.key,
    repo: target.repo,
    service: target.service,
    ...readState(stateDirFor(target)),
  }))
}

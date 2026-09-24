// Self-deploy trigger for the "release published" webhook event
// (server/src/app.js's /api/webhooks/github handler). The guardrail is pure
// and unit-tested directly; the actual process spawn is isolated behind
// `runner` so tests can swap it out without shelling out to a real deploy
// script/systemd.
//
// Deploy targets live in infra/host/deploy-targets.json (HZ-41) — a
// versioned, git-reviewed file, not a database row and not editable from the
// Admin UI. Agents run as the same unix user that owns horizon.db, so
// anything stored there is agent-writable; a deploy target names a script
// and a service to restart, so an agent-writable target would be arbitrary
// code execution. The webhook payload only ever selects a registry key
// (repoFullName) — every filesystem path a deploy touches comes from the
// registry, never from the payload itself.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REGISTRY_PATH = process.env.HORIZON_DEPLOY_TARGETS_FILE
  ?? fileURLToPath(new URL('../../infra/host/deploy-targets.json', import.meta.url))

// Re-reads the registry on every call instead of caching at import time —
// this is only hit on a release webhook or an Admin page load, both rare,
// and staying hot-reloadable means a merged registry PR takes effect without
// a server restart. Missing or malformed JSON fails closed to an empty
// registry (no targets resolve) rather than throwing and 500ing the webhook.
function loadRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function resolveTarget(repoFullName) {
  if (!repoFullName) return null
  return loadRegistry().find((target) => target.repo === repoFullName) ?? null
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

// Isolated so tests can replace `runner.spawn` instead of shelling out.
export const runner = {
  spawn(target, tag) {
    const scriptPath = fileURLToPath(new URL(`../../infra/host/${target.script}`, import.meta.url))
    const child = spawn(scriptPath, [tag], {
      detached: true,
      stdio: 'ignore',
      env: {
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
      },
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

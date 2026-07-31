// Self-deploy trigger for the "release published" webhook event
// (server/src/app.js's /api/webhooks/github handler). The guardrail is pure
// and unit-tested directly; the actual process spawn is isolated behind
// `runner` so tests can swap it out without shelling out to a real
// deploy.sh/systemd.
//
// The wrong-repo guardrail reads settings.getRepo() — the same repo identity
// the rest of the app uses (UI-configurable via the Admin page, env fallback)
// — rather than a second, independently-configured constant. That keeps the
// guardrail from silently drifting out of sync if the connected repo changes.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getRepo } from './settings.js'

const DEPLOY_SCRIPT = fileURLToPath(new URL('../../infra/host/deploy.sh', import.meta.url))

export function isDeployableRelease(repoFullName, body) {
  const target = getRepo()
  if (!target || !repoFullName || repoFullName !== target) return false
  if (!body?.release || body.action !== 'published') return false
  // Drafts aren't published yet by definition; prereleases are deliberately
  // excluded too — the DevOps step never marks its releases as prerelease, so
  // one arriving here means someone/something else is publishing to this
  // repo, and production shouldn't restart on it.
  if (body.release.draft || body.release.prerelease) return false
  return true
}

// Isolated so tests can replace `runner.spawn` instead of shelling out.
export const runner = {
  spawn(tag) {
    const child = spawn(DEPLOY_SCRIPT, [tag], { detached: true, stdio: 'ignore' })
    child.unref()
  },
}

export function runDeploy(tag, log) {
  runner.spawn(tag)
  log?.info(`self-deploy: triggered deploy.sh for release ${tag}`)
}

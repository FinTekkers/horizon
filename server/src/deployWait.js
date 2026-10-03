// HZ-275: what the farm's Deploy step needs to wait for an item's release to
// go live before its smoke check — the target's state dir (the farm reads
// only last-good-tag and self-deploy.log there) and the wait bound. The wait
// itself runs in the farm (farm/step_agent.py wait_until_release_live), which
// outlives the horizon-server restart a Horizon self-deploy causes.
//
// Read-only: nothing here runs a deploy. The state dir comes from spawnEnv,
// so it is the very HORIZON_STATE_DIR the deploy script writes to.

import { DEPLOY_WAIT_MS } from './config.js'
import { resolveTarget, spawnEnv } from './deploy.js'

// Null when the repo has no deploy target.
export function deployWaitFor(repoFullName) {
  const target = resolveTarget(repoFullName)
  if (!target) return null
  return { state_dir: spawnEnv(target).HORIZON_STATE_DIR, timeout_s: DEPLOY_WAIT_MS / 1000 }
}

// HZ-358: a repo marked 'no deploy' with no deploy target has nothing to
// ship. Step 14 then publishes no release and completes as "not deployed",
// and gate 15 says so. The target wins: a repo with a deploy_target row
// always takes the release path, mark or not, and a repo with neither is
// still refused by readinessFailure() (orchestrator.js) — same two reads.
//
// Read-only, and imports neither orchestrator nor github, so the caretaker
// (read-only by construction) may use it too.

import { getRepoConfig } from './store.js'
import { findTargetByRepo } from './deployTargets.js'

// Why step 14 deploys nothing for this item, or null. Read fresh each call.
export function deploySkipReason(item) {
  if (!item?.repo) return null
  if (!getRepoConfig(item.repo)?.noDeploy) return null
  if (findTargetByRepo(item.repo)) return null
  return `not deployed: ${item.repo} is marked no deploy`
}

// The step 14 artifact for a skipped deploy. Names no release and claims
// nothing is live.
export function deploySkipArtifact(item) {
  return `## Verdict\n**pass** — nothing was deployed: ${item.repo} is marked no deploy and has no deploy target.`
}

// HZ-303: what a missing or mismatched webhook means for a repo, in plain
// words. This module is the only home for that copy; Admin and its tests
// import it from here.
//
// The copy must match real behaviour. A release deploys only on a `release`
// webhook event (server/src/app.js) — there is no polling fallback for it. The
// 60-second poll (POLL_INTERVAL_MS) still picks up issues, comments, PR merges
// and main moves. Fix webhook (server/src/webhooks.js) creates the hook, or
// PATCHes Horizon's own, and never deletes one. The strings are fixed: no
// repo, hook ID, URL, secret or token is ever put into them.

export const WEBHOOK_IMPACT = Object.freeze({
  RELEASES_BLOCKED: 'Releases will not deploy until this webhook is fixed. There is no polling fallback for releases.',
  SYNC_CONTINUES: 'Issues, comments, PR merges and main moves still sync within about a minute.',
  SYNC_DELAY_ONLY: 'Only GitHub changes are delayed. They sync within about a minute and nothing is lost.',
  FIX_HINT:
    "Fix webhook creates the webhook, or repairs Horizon's own, on GitHub after you enter the gate PIN. It never deletes another webhook.",
})

// Whether `repo` has a deploy_target row. `null` while the targets are
// unknown (still loading, or the fetch failed). GitHub names ignore case.
export function repoHasDeployTarget(targets, repo) {
  if (!Array.isArray(targets)) return null
  const wanted = String(repo ?? '').toLowerCase()
  return targets.some((t) => typeof t?.repo === 'string' && t.repo.toLowerCase() === wanted)
}

// The lines to show under a webhook row, or null when there is nothing to
// explain. Only `missing` and `mismatched` break delivery; `ok`, `error` and
// anything else show nothing. An unknown target state shows only the sync
// line — never "nothing is lost" for a repo that might deploy.
export function webhookImpact({ status, hasDeployTarget } = {}) {
  if (status !== 'missing' && status !== 'mismatched') return null
  if (hasDeployTarget === true) return [WEBHOOK_IMPACT.RELEASES_BLOCKED, WEBHOOK_IMPACT.SYNC_CONTINUES]
  if (hasDeployTarget === false) return [WEBHOOK_IMPACT.SYNC_DELAY_ONLY]
  return [WEBHOOK_IMPACT.SYNC_CONTINUES]
}

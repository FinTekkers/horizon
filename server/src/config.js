// Server configuration (all optional — defaults give the offline demo mode).
//
//   HORIZON_REPO           "owner/name" — enables GitHub issue sync
//   GITHUB_TOKEN           token for private repos / higher rate limits
//   GITHUB_WEBHOOK_SECRET  enables POST /api/webhooks/github (HMAC-verified)
//                          — also the secret set on the repo webhooks Horizon creates (HZ-244)
//   POLL_INTERVAL_MS       poll fallback cadence (default 60s; ETag-conditional,
//                          so unchanged polls don't count against rate limits)
//   HORIZON_DB             path to the SQLite file (default server/data/horizon.db)
//   PORT                   HTTP port (default 3001)
//   GOOGLE_CLIENT_ID       OAuth client id (console.cloud.google.com, project fintekkers-422317)
//   GOOGLE_CLIENT_SECRET   OAuth client secret
//   GOOGLE_REDIRECT_URI    OAuth callback URL (default derived from HORIZON_UI_URL)
//   ADMIN_EMAIL/PASSWORD   hardcoded login credential (dev fallback: admin@example.com/admin)
//   ALLOWED_LOGIN_EMAILS   comma-separated Google-login allowlist (deny-by-default: empty/
//                          unset means NO Google logins succeed; the password path is unaffected)
//   WA_APPROVAL_SECRET     credential for POST .../approve-via-whatsapp — held ONLY by the
//                          WhatsApp concierge, never by step/PM agents. No dev fallback:
//                          unset means every WhatsApp approval is refused (503).
//   WA_APPROVER_JIDS       comma-separated WhatsApp approver allowlist (deny-by-default:
//                          empty/unset means NO sender can approve a gate)
//   WA_NOTIFY_ENABLED      "1" turns on the gate-arrival WhatsApp notifier (HZ-141).
//                          Unset/anything else means the sweep never runs at all.
//   WA_BRIDGE_URL          whatsapp-mcp bridge base URL (default http://localhost:8080) —
//                          same env name farm/config.py reads
//   WA_NOTIFY_SWEEP_MS     backstop cadence for the gate-arrival sweep (default 60s, floor 10s)
//   WA_NOTIFY_MAX_ATTEMPTS give-up count per queued notification (default 8)
//   WA_POLL_ENABLED        "0" stops attaching the ✅/↩️ approval poll to gate
//                          notifications (HZ-142). Otherwise on whenever
//                          WA_NOTIFY_ENABLED is — rollback tier 1, no deploy.
//   SESSION_SECRET         unused placeholder — session tokens are random, not signed
//   HORIZON_TEST_HOOKS     "1" registers e2e-only routes (see app.js) — never set in production
//   FIX_PASS_ENABLED       "0" turns off HZ-182's fix-only implement + delta review after a rejection
//   FIX_PASS_TURN_DIVISOR  fix-pass budget = implement budget / this (default 3)
//   FIX_PASS_MAX_LINES     fix diffs larger than this get a full review (default 200)
//   AUTO_RESOLVE_ON_MAIN   "0" stops HZ-235's auto Resolve-conflicts when main moves
//                          (the auto_resolve_on_main setting row, if set, wins — settings.js)
//   AUTO_RESOLVE_DEBOUNCE_MS       how long merges into main coalesce into one scan (default 30s)
//   AUTO_RESOLVE_MERGEABLE_WAIT_MS how long a scan waits for GitHub to compute a PR's
//                                  mergeability before re-checking it next poll (default 60s)
//   DEPLOY_BLOCK_MAX_TTL_S  cap on a self-deploy's block on new pre-merge/resolve runs (default 2h)
//   CARETAKER_HOURLY_LIMIT  most automatic gate actions per project per rolling hour (HZ-271;
//                           default 10, whole numbers >= 1 only)
//   HORIZON_DRY_RUN_TIMEOUT_MS  per-check bound on a deploy-target Dry run (HZ-258; default 5s)

import { agentStepIndexes } from '../../domain/js/lifecycle.js'

export const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || null

// Where the Horizon UI lives — used for deep links in GitHub comments/PRs.
export const UI_URL = (process.env.HORIZON_UI_URL || 'http://localhost:5173').replace(/\/+$/, '')

// HZ-244: where GitHub delivers repo webhooks — derived from HORIZON_UI_URL the
// same way GOOGLE_REDIRECT_URI is, not a new env var. In prod this is
// https://shoreward.ai/horizon/api/webhooks/github (infra/host/DEPLOY.md).
export const WEBHOOK_URL = `${UI_URL}/api/webhooks/github`

// Agent farm (farm/ Python daemon). FARM_URL unset -> mock agents run in-process.
export const FARM_URL = process.env.FARM_URL || null
export const FARM_SHARED_SECRET = process.env.FARM_SHARED_SECRET || 'dev-secret'
// Which step indexes the farm handles. Default: every agent step (HZ-117:
// derived from domain/js/lifecycle.js's STEPS, never a hand-maintained literal),
// including Deploy — HZ-22 wires the DevOps role in for deep post-deploy
// verification. The release publish itself (needs the GitHub token the farm
// doesn't have) still happens here in Node, in dispatchToFarm(), before the
// step is handed to the farm for verification. FARM_STEP_INDEXES remains a
// deliberate operational override on top of that default. HZ-383: the task
// kind's agent steps too — its runner-less rows are never dispatched at all,
// so only the ones on a real lane ever reach this check.
export const FARM_STEP_INDEXES = new Set(
  (process.env.FARM_STEP_INDEXES || [...agentStepIndexes(), ...agentStepIndexes(undefined, 'task')].join(','))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n)),
)
// Execution budget: starts when the farm confirms an agent actually launched
// (POST .../started), not at dispatch — see FARM_QUEUE_TIMEOUT_MS below for
// the queue-wait half of that split (HZ-57).
export const FARM_STEP_TIMEOUT_MS = Number(process.env.FARM_STEP_TIMEOUT_MS || 20 * 60 * 1000)
// HZ-275: how long the Deploy step waits for its own release to go live (the
// target's last-good-tag naming it) before the smoke check. Sent to the farm
// with the step, and added to the Deploy step's execution budget. Anything
// not a positive number means the default, as the farm reads it too.
const deployWaitEnvMs = Number(process.env.HORIZON_DEPLOY_WAIT_MS)
export const DEPLOY_WAIT_MS = deployWaitEnvMs > 0 ? deployWaitEnvMs : 20 * 60 * 1000
// HZ-333: how long a target's deploy queue collects items after the first
// joins before it publishes one release of main for all of them. 0 = no
// window; anything not a number >= 0 means the default.
const deployBatchEnvS = process.env.HORIZON_DEPLOY_BATCH_S?.trim() ? Number(process.env.HORIZON_DEPLOY_BATCH_S) : NaN
export const DEPLOY_BATCH_S = deployBatchEnvS >= 0 ? deployBatchEnvS : 900
// HZ-275 (metric 5): a release deploy that finds another deploy holding
// the lock waits up to 30 min for it, not the scripts' own 5-min default, so
// two releases published close together both deploy, in order. Set in this
// process's env because spawnEnv (deploy.js) passes HORIZON_* to every deploy
// script, and the scripts already read HORIZON_DEPLOY_LOCK_TIMEOUT_S. An
// explicit value in server.env still wins.
// DIVERGES from the gate-5 ruling, which put the 30-min default in
// infra/host/deploy-*.sh: HZ-258's deploy-dry-run.test.mjs requires infra/host/
// to match main and metric 4 forbids editing it. So manual or rollback runs of
// the scripts still default to 5 min. Pending an operator ruling.
export const DEPLOY_LOCK_TIMEOUT_S = process.env.HORIZON_DEPLOY_LOCK_TIMEOUT_S || '1800'
process.env.HORIZON_DEPLOY_LOCK_TIMEOUT_S = DEPLOY_LOCK_TIMEOUT_S
// Queue-wait budget: armed the moment a step is handed to the farm. A step
// that sits queued behind other work longer than this is failed as "never
// picked up" — this must stay well short of FARM_STEP_TIMEOUT_MS so a step
// that's genuinely stuck in queue (farm down, task file lost, queue wedged)
// still fails in a bounded window instead of silently burning its full
// execution budget before ever running.
export const FARM_QUEUE_TIMEOUT_MS = Number(process.env.FARM_QUEUE_TIMEOUT_MS || 10 * 60 * 1000)
export const FARM_START_TIMEOUT_MS = Number(process.env.FARM_START_TIMEOUT_MS || 5 * 60 * 1000)
// HZ-100: how often the durable reconciliation sweep re-checks `step_run`
// rows left `active` with no local watchdog timer (see orchestrator.js's
// reconcileActiveRuns). Must stay ABOVE FARM_QUEUE_TIMEOUT_MS so an armed
// server timer always wins the race against the sweep for a step that is
// genuinely still just queued — the clamp below enforces that regardless of
// how RECONCILE_SWEEP_MS itself is configured.
export const RECONCILE_SWEEP_MS = Math.max(
  Number(process.env.RECONCILE_SWEEP_MS) || 15 * 60 * 1000,
  FARM_QUEUE_TIMEOUT_MS + 60_000,
)
// HZ-92: bounds the one farm call that runs synchronously and genuinely long
// (a real git merge, then the target repo's own test suite) — sized like the
// implement step's own execution budget, since conflict resolution runs the
// same repo checks. A hung farmd (or a test/lint command that never returns)
// must not hang the Accept-gate request forever.
export const FARM_CONFLICT_RESOLVE_TIMEOUT_MS = Number(process.env.FARM_CONFLICT_RESOLVE_TIMEOUT_MS || 50 * 60 * 1000)
// HZ-194: how long a pause lets a running implement attempt checkpoint its
// work before farmd kills it anyway. The single knob: it is sent with every
// pause, so farmd needs no copy of its own. Anything but a positive number
// falls back to 30.
const pauseCheckpointTimeoutS = Number(process.env.HZ_PAUSE_CHECKPOINT_TIMEOUT_S)
export const PAUSE_CHECKPOINT_TIMEOUT_S = pauseCheckpointTimeoutS > 0 ? pauseCheckpointTimeoutS : 30
// HZ-183: bounds the pre-merge check at Accept the code — a test-merge of the
// PR into the current base and the repo's own checks (server/src/premerge.js).
// A run that has not finished by then blocks the merge, fail-closed.
export const PREMERGE_CHECK_TIMEOUT_MS = Number(process.env.PREMERGE_CHECK_TIMEOUT_MS || 20 * 60 * 1000)
// HZ-257: Accept skips the pre-merge run when the farm's own checks already
// passed on exactly the PR head and that head already contains the base tip
// (app.js tryPreMergeSkip). A passing record older than this many hours is
// not used. Anything but a finite positive number — missing, 0, negative,
// unparseable — falls back to 24; it never means "no limit". check_pass rows
// are pruned at max(7 days, this limit), so the limit is never cut short.
export function parseSkipMaxAgeHours(raw) {
  const hours = Number(raw)
  return raw != null && raw !== '' && Number.isFinite(hours) && hours > 0 ? hours : 24
}
export const PREMERGE_SKIP_MAX_AGE_MS = parseSkipMaxAgeHours(process.env.PREMERGE_SKIP_MAX_AGE_HOURS) * 60 * 60 * 1000
// Rollback lever: "off" makes every Accept run pre-merge as before HZ-257.
export const PREMERGE_SKIP_ENABLED = process.env.PREMERGE_SKIP !== 'off'
// HZ-216: a gate action's lease (db.js gate_action) is the run's own timeout
// above — PREMERGE_CHECK_TIMEOUT_MS or FARM_CONFLICT_RESOLVE_TIMEOUT_MS — plus
// this margin, which covers the GitHub reads and merge call around the checks.
// Not a second timeout: nothing is stopped by it, it only bounds how long a
// run nobody finished (a restart, a crash) keeps the gate disabled.
export const GATE_ACTION_MARGIN_MS = Number(process.env.GATE_ACTION_MARGIN_MS || 5 * 60 * 1000)
// HZ-250: the longest a self-deploy's block on new pre-merge and resolve runs
// can last (deployDrain.js), whatever TTL the deploy script asks for — so a
// deploy script that died mid-drain can never hold the block for good.
export const DEPLOY_BLOCK_MAX_TTL_S = Number(process.env.DEPLOY_BLOCK_MAX_TTL_S || 2 * 60 * 60)
// HZ-258: how long each of a deploy-target Dry run's five checks may take
// before it fails (deployDryRun.js). The checks run side by side, so a whole
// Dry run answers within about this long.
export const DRY_RUN_TIMEOUT_MS = Number(process.env.HORIZON_DRY_RUN_TIMEOUT_MS || 5000)
// How often the orchestrator sweeps expired gate-action leases.
export const GATE_ACTION_SWEEP_MS = Number(process.env.GATE_ACTION_SWEEP_MS || 60 * 1000)
// HZ-182: after an automated review rejection, the next implement run is a
// fix-only pass and the review after it sees only the fix's delta. "0" turns
// it off: every cycle is a full implement plus a full review, as before.
export const FIX_PASS_ENABLED = process.env.FIX_PASS_ENABLED !== '0'
// The fix pass gets the implement step's turn and time budget divided by
// this. Whole numbers >= 1 only; anything else falls back to 3.
const fixPassDivisor = Math.floor(Number(process.env.FIX_PASS_TURN_DIVISOR))
export const FIX_PASS_TURN_DIVISOR = fixPassDivisor >= 1 ? fixPassDivisor : 3
// A fix diff over this many changed lines (added + removed) gets a full
// review instead of a delta review.
const fixPassMaxLines = Math.floor(Number(process.env.FIX_PASS_MAX_LINES))
export const FIX_PASS_MAX_LINES = fixPassMaxLines >= 1 ? fixPassMaxLines : 200
// Hard cap on automated review cycles (HZ-30), enforced by the orchestrator
// and read by the Autopilot caretaker (HZ-271), which only stops on it.
// Deliberately NOT read from the environment: nothing may raise it.
export const REVIEW_CYCLE_CAP = 3
// HZ-271: the most automatic gate actions the caretaker takes per project in
// any rolling hour, counted from persisted caretaker_action rows. Whole
// numbers >= 1 only; anything else falls back to 10.
export function parseCaretakerHourlyLimit(raw) {
  const n = Number(raw)
  return raw != null && raw !== '' && Number.isInteger(n) && n >= 1 ? n : 10
}
export const CARETAKER_HOURLY_LIMIT = parseCaretakerHourlyLimit(process.env.CARETAKER_HOURLY_LIMIT)
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000)
// HZ-235 (autoResolve.js): merges into main within this window share one
// scan, and its event text names every one of them.
export const AUTO_RESOLVE_DEBOUNCE_MS = Number(process.env.AUTO_RESOLVE_DEBOUNCE_MS || 30_000)
// GitHub computes `mergeable` lazily after main moves (null meanwhile). The
// scan retries with backoff up to this long, then leaves the item to be
// re-checked on the next poll tick.
export const AUTO_RESOLVE_MERGEABLE_WAIT_MS = Number(process.env.AUTO_RESOLVE_MERGEABLE_WAIT_MS || 60_000)
export const PORT = Number(process.env.PORT || 3001)

// ---- auth (HZ-21) ----
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || null
export const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || `${UI_URL}/api/auth/google/callback`
// Dev-mode fallback credential — always overridden in production via env vars.
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com'
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin'
export const SESSION_COOKIE_NAME = 'horizon_session'
export const SESSION_TTL_DAYS = 30

// Google-login allowlist (HZ-36): a published OAuth consent screen lets ANY
// Google account complete the flow, so this is the only thing standing
// between "authenticated with Google" and "actually allowed into Horizon".
// Deny-by-default — empty/unset means the Set is empty, so no email ever
// matches and no Google login can succeed. The password login path (above)
// is a completely separate check and is never affected by this.
export const ALLOWED_LOGIN_EMAILS = new Set(
  (process.env.ALLOWED_LOGIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

// ---- WhatsApp gate approval (HZ-140) ----
// Until HZ-140, POST .../approve-via-whatsapp was guarded by
// FARM_SHARED_SECRET — which farm/tmux_mgr.py forwarded into every agent
// session — so any agent with Bash could approve its own gate. These two are
// the replacement: a credential that never enters a step/PM agent session,
// and a server-held allowlist so the caller-supplied sender is proved here
// rather than trusted.
//
// Deliberately NO 'dev-secret' fallback (unlike FARM_SHARED_SECRET above):
// an unset value must fail approvals closed, never silently accept them.
export const WA_APPROVAL_SECRET = process.env.WA_APPROVAL_SECRET || null

// HZ-246: signs every PIN-approved rules version (server/src/rulesStore.js).
// Server-only — never in farm.env. No fallback: unset fails saves closed
// (503) and serves only the rules files, never a DB row.
export const RULES_HMAC_SECRET = process.env.RULES_HMAC_SECRET || null
// Raw entries, in whatever form an operator wrote them (a bare number, or a
// jid with a device suffix). waApprovers.js is what interprets them, in the two
// directions they are needed: normalizeJid for "is this sender an approver",
// canonicalJid for "what address does a notification go to".
//
// The FIRST entry is "the owner" (HZ-271 operator ruling): the Autopilot
// caretaker's help pings go to that one jid only, never to the whole list.
export const WA_APPROVER_JIDS = (process.env.WA_APPROVER_JIDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// ---- gate-arrival notification (HZ-141) ----
// Who gets notified is NOT configured here: it is WA_APPROVER_JIDS above, read
// through waApprovers.js's approverJids(). One source of truth for who approves
// a gate and who is told a gate is waiting — a second list would let the two
// drift into "notified someone who cannot approve".
//
// OFF by default, and deliberately not defaulted on by the presence of an
// approver list: this path messages a real human, so turning it on must be an
// explicit ops act (/etc/horizon/server.env), never a side effect of
// configuring HZ-140's approval path. e2e pins it to '0' — see
// e2e/playwright.config.js's demo-mode env block.
export const WA_NOTIFY_ENABLED = process.env.WA_NOTIFY_ENABLED === '1'
// Same env name farm/config.py:59 reads, so one host setting serves both
// processes. Node strips trailing slashes where Python's rstrip("/") happens
// inside BridgeTransport instead — same effective URL either way.
export const WA_BRIDGE_URL = (process.env.WA_BRIDGE_URL || 'http://localhost:8080').replace(/\/+$/, '')
// Backstop only: the sweep also runs on every store.onChange, so this is what
// catches a notification whose enqueue-time send failed, not the arrival itself.
export const WA_NOTIFY_SWEEP_MS = Math.max(Number(process.env.WA_NOTIFY_SWEEP_MS) || 60_000, 10_000)
// Caps a wedged bridge at ~2h of exponential backoff per row rather than
// retrying a dead endpoint forever.
export const WA_NOTIFY_MAX_ATTEMPTS = Math.max(Number(process.env.WA_NOTIFY_MAX_ATTEMPTS) || 8, 1)

// ---- gate-approval poll (HZ-142) ----
// Whether each gate notification also carries a native two-option WhatsApp
// poll (✅ Approve / ↩️ Send back).
//
// ON by default WHEN THE NOTIFIER IS ON, off otherwise. A poll is attached to
// a gate notification, so "notify nobody" has to mean "poll nobody" — and the
// coupling is also what keeps every pre-HZ-142 test that drives sweepGates()
// with WA_NOTIFY_ENABLED unset seeing exactly the rows it saw before.
//
// WA_POLL_ENABLED=0 is rollback tier 1: polls stop being attached with no
// deploy, text notices and the concierge's free-text approval carry on
// untouched. POST /api/wa/poll-vote stays registered either way, so a poll
// already on someone's phone still decides its gate after the flag goes off.
export const WA_POLL_ENABLED = WA_NOTIFY_ENABLED && process.env.WA_POLL_ENABLED !== '0'
// Same give-up rule as the text outbox, deliberately sharing the setting: a
// wedged bridge wedges both paths, and two knobs would only ever be set to the
// same value.
export const WA_POLL_MAX_ATTEMPTS = WA_NOTIFY_MAX_ATTEMPTS

// e2e only (HZ-54): the e2e suite runs with no real farm daemon (FARM_URL
// unset — see e2e/playwright.config.js), so it has no way to make the board
// actually observe a "queued" run through the real polling path. This flag
// gates registration of a tiny test-only route (app.js) that lets a spec set
// the orchestrator's run-state cache directly, mirroring exactly what
// pollRunStates() would have cached from a real farm reply. Unset (the
// default) means the route is never even registered.
export const TEST_HOOKS_ENABLED = process.env.HORIZON_TEST_HOOKS === '1'

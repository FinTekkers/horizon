// Server configuration (all optional — defaults give the offline demo mode).
//
//   HORIZON_REPO           "owner/name" — enables GitHub issue sync
//   GITHUB_TOKEN           token for private repos / higher rate limits
//   GITHUB_WEBHOOK_SECRET  enables POST /api/webhooks/github (HMAC-verified)
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
//   SESSION_SECRET         unused placeholder — session tokens are random, not signed
//   HORIZON_TEST_HOOKS     "1" registers e2e-only routes (see app.js) — never set in production

export const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || null

// Where the Horizon UI lives — used for deep links in GitHub comments/PRs.
export const UI_URL = (process.env.HORIZON_UI_URL || 'http://localhost:5173').replace(/\/+$/, '')

// Agent farm (farm/ Python daemon). FARM_URL unset -> mock agents run in-process.
export const FARM_URL = process.env.FARM_URL || null
export const FARM_SHARED_SECRET = process.env.FARM_SHARED_SECRET || 'dev-secret'
// Which step indexes the farm handles. Default: every agent step, including
// Deploy (14) — HZ-22 wires the DevOps role in for deep post-deploy
// verification. The release publish itself (needs the GitHub token the farm
// doesn't have) still happens here in Node, in dispatchToFarm(), before the
// step is handed to the farm for verification.
export const FARM_STEP_INDEXES = new Set(
  (process.env.FARM_STEP_INDEXES || '0,1,2,4,6,7,8,9,11,12,14')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n)),
)
// Execution budget: starts when the farm confirms an agent actually launched
// (POST .../started), not at dispatch — see FARM_QUEUE_TIMEOUT_MS below for
// the queue-wait half of that split (HZ-57).
export const FARM_STEP_TIMEOUT_MS = Number(process.env.FARM_STEP_TIMEOUT_MS || 20 * 60 * 1000)
// Queue-wait budget: armed the moment a step is handed to the farm. A step
// that sits queued behind other work longer than this is failed as "never
// picked up" — this must stay well short of FARM_STEP_TIMEOUT_MS so a step
// that's genuinely stuck in queue (farm down, task file lost, queue wedged)
// still fails in a bounded window instead of silently burning its full
// execution budget before ever running.
export const FARM_QUEUE_TIMEOUT_MS = Number(process.env.FARM_QUEUE_TIMEOUT_MS || 10 * 60 * 1000)
export const FARM_START_TIMEOUT_MS = Number(process.env.FARM_START_TIMEOUT_MS || 5 * 60 * 1000)
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000)
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

// e2e only (HZ-54): the e2e suite runs with no real farm daemon (FARM_URL
// unset — see e2e/playwright.config.js), so it has no way to make the board
// actually observe a "queued" run through the real polling path. This flag
// gates registration of a tiny test-only route (app.js) that lets a spec set
// the orchestrator's run-state cache directly, mirroring exactly what
// pollRunStates() would have cached from a real farm reply. Unset (the
// default) means the route is never even registered.
export const TEST_HOOKS_ENABLED = process.env.HORIZON_TEST_HOOKS === '1'

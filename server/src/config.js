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
//   SESSION_SECRET         unused placeholder — session tokens are random, not signed

export const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || null

// Where the Horizon UI lives — used for deep links in GitHub comments/PRs.
export const UI_URL = (process.env.HORIZON_UI_URL || 'http://localhost:5173').replace(/\/+$/, '')

// Agent farm (farm/ Python daemon). FARM_URL unset -> mock agents run in-process.
export const FARM_URL = process.env.FARM_URL || null
export const FARM_SHARED_SECRET = process.env.FARM_SHARED_SECRET || 'dev-secret'
// Which step indexes the farm handles. Default: all agent steps except
// Deploy (14), which stays deterministic/script-driven on this side.
export const FARM_STEP_INDEXES = new Set(
  (process.env.FARM_STEP_INDEXES || '0,1,2,4,6,7,8,9,11,12')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n)),
)
export const FARM_STEP_TIMEOUT_MS = Number(process.env.FARM_STEP_TIMEOUT_MS || 20 * 60 * 1000)
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

// Server configuration (all optional — defaults give the offline demo mode).
//
//   HORIZON_REPO           "owner/name" — enables GitHub issue sync
//   GITHUB_TOKEN           token for private repos / higher rate limits
//   GITHUB_WEBHOOK_SECRET  enables POST /api/webhooks/github (HMAC-verified)
//   POLL_INTERVAL_MS       poll fallback cadence (default 60s; ETag-conditional,
//                          so unchanged polls don't count against rate limits)
//   HORIZON_DB             path to the SQLite file (default server/data/horizon.db)
//   PORT                   HTTP port (default 3001)

export const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || null

// Where the Horizon UI lives — used for deep links in GitHub comments/PRs.
export const UI_URL = (process.env.HORIZON_UI_URL || 'http://localhost:5173').replace(/\/+$/, '')

// Agent farm (farm/ Python daemon). FARM_URL unset -> mock agents run in-process.
export const FARM_URL = process.env.FARM_URL || null
export const FARM_SHARED_SECRET = process.env.FARM_SHARED_SECRET || 'dev-secret'
// Which step indexes the farm handles. Default: all agent steps except
// Deploy (12), which stays deterministic/script-driven on this side.
export const FARM_STEP_INDEXES = new Set(
  (process.env.FARM_STEP_INDEXES || '0,1,2,4,6,7,8,10')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n)),
)
export const FARM_STEP_TIMEOUT_MS = Number(process.env.FARM_STEP_TIMEOUT_MS || 20 * 60 * 1000)
export const FARM_START_TIMEOUT_MS = Number(process.env.FARM_START_TIMEOUT_MS || 5 * 60 * 1000)
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000)
export const PORT = Number(process.env.PORT || 3001)

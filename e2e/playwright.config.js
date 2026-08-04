import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private temp DB and non-default ports, isolated from anything a
// developer might have running locally (~/.horizon-farm state, a real dev
// server) — the demo-mode-only guardrail starts here.
//
// This path must be a fixed literal, NOT derived from something like
// process.pid: Playwright re-evaluates this config module once per worker
// process, each with a different pid, so a pid-derived path would silently
// diverge between the process that seeds fixtures and the process that
// reads them. Freshness across runs comes from the `rm -f` in the server's
// webServer command below, not from a unique-per-run path.
const DB_PATH = join(tmpdir(), 'horizon-e2e.db')
const SERVER_PORT = 3057
const UI_PORT = 4351
const BASE_URL = `http://localhost:${UI_PORT}`
// Every /api/* route requires a login session (HZ-21). global-setup.js logs
// in once via the hardcoded dev-mode credential (ADMIN_EMAIL/PASSWORD are
// unset here, so config.js's admin@example.com/admin fallback applies) and
// saves the resulting session cookie here; every spec's browser context
// starts from this file (see `use.storageState` below), so no spec needs its
// own login step.
const STORAGE_STATE_PATH = join(tmpdir(), 'horizon-e2e-storage-state.json')

// Read by global-setup.js, which seeds fixtures directly into the DB and
// waits for the server to come up before any test runs.
process.env.HORIZON_E2E_DB = DB_PATH
process.env.HORIZON_E2E_PORT = String(SERVER_PORT)
process.env.HORIZON_E2E_STORAGE_STATE = STORAGE_STATE_PATH
process.env.HORIZON_E2E_BASE_URL = BASE_URL

export default defineConfig({
  testDir: './tests',
  // One shared server + one shared sqlite DB back every spec file, so
  // specs run one at a time (no parallel workers) to avoid cross-spec
  // state pollution — see fixtures/seed.js for how each spec gets its own
  // inert, orchestrator-untouched rows instead.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  // Automatic enforcement of the 90s runtime budget (leaves margin below it
  // for a slower host) instead of relying on someone re-measuring by hand.
  globalTimeout: 85_000,
  globalSetup: './global-setup.js',
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE_PATH,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Fixed small viewport keeps HZ-18's per-journey screenshots tiny — this
  // must live inside the project's `use` (not the top-level `use` above),
  // since devices['Desktop Chrome'] sets its own 1280x720 viewport and
  // project-level `use` wins per-key over the top-level block.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 640 } } }],
  webServer: [
    {
      // `fuser -k` guarantees the port is actually free before binding: if a
      // prior run's server wasn't fully reaped (teardown timing varies by
      // host), this run's `node` would otherwise fail to bind, exit
      // immediately, and Playwright's port-based readiness check would
      // silently treat the STALE leftover server as "ready" — every test
      // would then run against old, accumulated state instead of a fresh
      // one, which is exactly the kind of cross-run flakiness this suite
      // exists to avoid. Then deletes any DB left over from a prior run, so
      // the fixed, cross-process-stable DB_PATH still starts every run
      // fresh. `exec` on the final command matters too: without it, the
      // intermediate shell doesn't forward Playwright's teardown SIGTERM to
      // the actual `node` process, orphaning it after every run.
      command: `fuser -k ${SERVER_PORT}/tcp >/dev/null 2>&1; sleep 0.3; rm -f "${DB_PATH}" "${DB_PATH}-wal" "${DB_PATH}-shm" && exec node src/server.js`,
      cwd: '../server',
      port: SERVER_PORT,
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        HORIZON_DB: DB_PATH,
        PORT: String(SERVER_PORT),
        // Keeps the mock-agent pipeline (server/src/orchestrator.js) fast
        // enough to fit the whole suite in the runtime budget.
        MOCK_STEP_LATENCY_MS: '50',
        HORIZON_UI_URL: BASE_URL,
        // Force demo mode regardless of whatever the parent shell has set —
        // this suite must never reach real GitHub or a real farm daemon.
        HORIZON_REPO: '',
        GITHUB_TOKEN: '',
        GITHUB_WEBHOOK_SECRET: '',
        FARM_URL: '',
      },
    },
    {
      // Builds the real production bundle and serves it with vite preview,
      // so the suite exercises the same artifact a deploy would ship —
      // not the dev server. Assumes the app is mounted at the root path
      // (HORIZON_BASE unset); a subpath deploy would need this adjusted.
      // Same port-clearing + exec reasoning as the server command above.
      // `exec` goes straight into the vite binary (not `npm run preview`,
      // which would just add another non-exec'd wrapper).
      command: `fuser -k ${UI_PORT}/tcp >/dev/null 2>&1; sleep 0.3; npm run build && exec ./node_modules/.bin/vite preview --port ${UI_PORT} --strictPort`,
      cwd: '../ui',
      port: UI_PORT,
      timeout: 45_000,
      reuseExistingServer: false,
      env: {
        VITE_PROXY_TARGET: `http://localhost:${SERVER_PORT}`,
      },
    },
  ],
})

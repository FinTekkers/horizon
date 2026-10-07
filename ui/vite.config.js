import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const proxy = {
  '/api': {
    target: process.env.VITE_PROXY_TARGET || 'http://localhost:3001',
    // Fail fast when the server is mid-restart instead of hanging the tab
    // (the SSE stream reconnects on its own; page loads should error visibly).
    timeout: 15_000,
    proxyTimeout: 15_000,
  },
}

// HZ-128: the step model lives in domain/ at the repo root, which is OUTSIDE
// this Vite root. `vite build` and `vitest` resolve it by relative path on
// their own; the dev server serves files through a filesystem allowlist and
// would 403 on it, so the parent directory has to be allowed explicitly.
const fs = { allow: ['..'] }

// HZ-327: under a farm check run, vitest also writes JUnit XML into the run's
// report dir, for the repo's test history. Unset, the reporters are vitest's
// defaults, as before.
const reportDir = process.env.HORIZON_TEST_REPORT_DIR
const junitReport = reportDir
  ? { reporters: ['default', 'junit'], outputFile: { junit: `${reportDir}/ui.xml` } }
  : {}

// HORIZON_BASE lets the production build mount under a subpath (e.g.
// HORIZON_BASE=/horizon/ for shoreward.ai/horizon). Dev stays at /.
export default defineConfig({
  base: process.env.HORIZON_BASE || '/',
  plugins: [react()],
  server: { proxy, fs },
  preview: { proxy },
  test: { environment: 'jsdom', ...junitReport },
})

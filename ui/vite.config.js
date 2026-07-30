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

// HORIZON_BASE lets the production build mount under a subpath (e.g.
// HORIZON_BASE=/horizon/ for shoreward.ai/horizon). Dev stays at /.
export default defineConfig({
  base: process.env.HORIZON_BASE || '/',
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
  test: { environment: 'jsdom' },
})

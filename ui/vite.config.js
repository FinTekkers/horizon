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

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
  test: { environment: 'jsdom' },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const proxy = {
  '/api': process.env.VITE_PROXY_TARGET || 'http://localhost:3001',
}

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
})

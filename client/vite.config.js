import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Dev proxy stays in lockstep with the server port: `npm run dev` launches
// both processes from the same shell, so PORT reaches both sides.
const API_PORT = process.env.PORT || 3000

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The simulated agent brain is a single source of truth shared with the server.
    alias: { '@shared': path.resolve(__dirname, '..', 'server') },
  },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(__dirname, '..')] },
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://localhost:${API_PORT}`, ws: true },
    },
  },
  // `vite preview` must NOT inherit the dev proxy — it stands in for the static
  // Vercel deployment, where no API server exists.
  preview: { port: 4173, proxy: {} },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // PDF and font tests are CPU heavy: one worker per core starves them, and 5 s failed without a defect.
  test: { testTimeout: 60_000, maxWorkers: '50%' },
  // Loaded on demand: prebundling it up front avoids a reload in the running dev server.
  optimizeDeps: { include: ['tesseract.js'] },
})

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Loaded on demand: prebundling it up front avoids a reload in the running dev server.
  optimizeDeps: { include: ['tesseract.js'] },
})

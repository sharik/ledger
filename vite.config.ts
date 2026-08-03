/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { devRemote } from './e2e/devRemote'

export default defineConfig({
  // Relative, so the same build works from a GitHub Pages project subpath
  // (`/ledger/`), a custom domain at the root, and `vite preview` alike. The app
  // routes on the hash, so deep links need no server rewrite either.
  base: './',
  plugins: [react(), devRemote()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})

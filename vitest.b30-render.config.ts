import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// B30 — /hq route composition/controller REAL render proof (jsdom + React).
// Kept separate from vitest.component.config.ts so the shared component include
// list stays untouched, and separate from vitest.config.ts (environment:
// 'node', DB-backed suites). Mirrors vitest.b28-render.config.ts.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup/jsdom-storage.ts'],
    include: ['tests/unit/hq/B30/hq-page-render.test.tsx'],
    env: { NODE_ENV: 'test' },
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});

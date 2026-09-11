import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// PRES-021 stale/offline REAL render proof (jsdom + React). Kept separate
// from vitest.component.config.ts so the main component suite never picks up
// this file's fake timers, and separate from vitest.pres020-021.config.ts
// (environment: 'node', DB-backed suites).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/unit/pres021-stepper-stale-render.test.tsx'],
    env: { NODE_ENV: 'test' },
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});

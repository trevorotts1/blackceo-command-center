import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Dedicated config for REAL component render tests (jsdom + React). Kept
// separate from vitest.config.ts (environment: 'node', DB-backed suites) so
// this jsdom + @vitejs/plugin-react setup can never interfere with those.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'tests/unit/u55-company-health-render.test.tsx',
      // A-U5 acceptance (b) — PersonaScopeChips real render proof.
      'tests/unit/a-u5-persona-scope-chips-render.test.tsx',
      // U47 acceptance (a)/(b)/(c)/(e) — HealthIndicator real render proof.
      'tests/unit/u47-health-indicator.test.tsx',
    ],
    env: { NODE_ENV: 'test' },
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});

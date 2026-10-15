import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * CWE-044 gauntlet config (Skill 77): jsdom + React render harness for
 * the client gauntlet's snapshot generation and event-to-UI timing.
 *
 * Kept separate from vitest.component.config.ts (owned by earlier
 * units) so the gauntlet can be re-run unchanged against a future
 * tree: it includes ONLY council-gauntlet-* test files.
 *
 *   npx vitest run --config vitest.council-gauntlet.config.ts
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup/jsdom-storage.ts'],
    include: [
      'tests/unit/council-gauntlet-snapshots.test.tsx',
      'tests/unit/council-gauntlet-eventui.test.tsx',
    ],
    env: { NODE_ENV: 'test' },
    testTimeout: 120000,
    hookTimeout: 120000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});

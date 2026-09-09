import { defineConfig } from 'vitest/config';
import path from 'path';

// PRES-020 + PRES-021 acceptance suites. Dedicated config (same pattern as
// vitest.fix53-both.config.ts) so these DB-backed vitest suites run without
// touching the main vitest.config.ts include list or the tsx --test glob.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    isolate: true,
    include: [
      'tests/unit/pres020-phase-completeness.test.ts',
      'tests/unit/pres021-parent-refresh.test.ts',
    ],
    env: { NODE_ENV: 'test' },
    testTimeout: 30000,
    maxConcurrency: 1,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});

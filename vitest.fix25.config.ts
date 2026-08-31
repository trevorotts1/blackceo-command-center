// FIX 25 proof-only config: mirrors vitest.config.ts alias, narrows include to
// the fix25 suite so the proof run is scope-local. DISABLE_QC_AUTO_SCORER is
// set in `test.env` because qc-scorer.ts freezes it into a module-load const —
// by the time the test file body runs it is too late to set it.
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    isolate: true,
    include: ['tests/unit/fix25-review-artifact-gate.test.ts'],
    env: { NODE_ENV: 'test', DISABLE_QC_AUTO_SCORER: '1' },
    testTimeout: 30000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});

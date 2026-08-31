// FIX 5 proof-only config: mirrors vitest.config.ts alias/env, narrows include
// to the fix5 stage-timings suite so the proof run is scope-local.
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    isolate: true,
    include: ['tests/unit/fix5-stage-timings-ingest.test.ts'],
    env: { NODE_ENV: 'test' },
    testTimeout: 15000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});

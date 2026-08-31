// FIX 14 proof-only config: mirrors vitest.config.ts alias/env, narrows include
// to the fix14 suite so the proof run is scope-local.
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    isolate: true,
    include: ['tests/unit/fix14-profile-judge.test.ts'],
    env: { NODE_ENV: 'test' },
    testTimeout: 15000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
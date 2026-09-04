import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    isolate: true,
    include: [
      'tests/unit/fix53-phases-elapsed.test.ts',
      'tests/unit/fix53-stage-timings-get.test.ts',
    ],
    env: { NODE_ENV: 'test' },
    testTimeout: 20000,
    maxConcurrency: 1,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});

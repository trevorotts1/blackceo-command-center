import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Each test file gets its own module registry so vi.doMock() isolation works.
    isolate: true,
    // B.1 truth-table suites:
    //   deep-health.test.ts   — TypeScript /api/health/deep check functions
    //   cc-probe-pm2.test.ts  — pm2 topology rows 14-19 via pm2-analyze-cc.py
    //
    // Other test files under tests/unit/ use the Node built-in test runner
    // (npm run test:unit via tsx --test) and produce "no test suite found" errors
    // when included here.
    include: [
      'tests/unit/deep-health.test.ts',
      'tests/unit/cc-probe-pm2.test.ts',
    ],
    env: {
      NODE_ENV: 'test',
    },
    // Increase timeout for tests that write temp files
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      // Mirror tsconfig paths so '@/lib/...' resolves correctly under vitest
      '@': path.resolve(__dirname, 'src'),
    },
  },
});

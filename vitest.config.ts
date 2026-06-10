import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Each test file gets its own module registry so vi.doMock() isolation works.
    isolate: true,
    // Only run the B.1 deep-health truth-table suite.
    // Other test files under tests/unit/ use the Node built-in test runner
    // (npm run test:unit via tsx --test) and produce "no test suite found" errors
    // when included here.  The CI qc-cc.yml deep-health-truth-table job targets
    // this suite specifically.
    include: ['tests/unit/deep-health.test.ts'],
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

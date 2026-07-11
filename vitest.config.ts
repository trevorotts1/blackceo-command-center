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
      // Floor invariant: displayed departments == chosen manifest − opt-outs, for
      // the active company (no first-boot staleness / destructive slug collapse /
      // foreign-company leakage / silent cap). DB-backed vitest suite; the Node
      // built-in `npm run test:unit` glob skips it (see below) so it only runs here.
      'tests/unit/floor-department-invariant.test.ts',
      // P3-7: seam <-> onboarding-Python parity harness. Lives under src/ (not
      // tests/unit/) so `npm run test:unit` (tsx --test glob) does NOT also pick it
      // up — it uses vitest globals and only runs here via `npm run test:vitest`.
      'src/lib/interview/__tests__/seam-parity.test.ts',
      // v4.72.0 board-blank fix: middleware auth matrix (same-origin board reads
      // pass through with no CF assertion / bearer; external + ingest/webhook paths
      // still require auth). Uses vitest globals + vi.resetModules re-import, so it
      // only runs here via `npm run test:vitest`, never the tsx --test glob.
      'tests/unit/middleware-same-origin-board.test.ts',
      // FLEET-FIX 2.3 / AUD-71: every 401 `unauthorized()` returns emits one
      // structured log line and increments a counter. Same vi.resetModules
      // re-import pattern as middleware-same-origin-board.test.ts above, so it
      // only runs here via `npm run test:vitest`, never the tsx --test glob.
      'tests/unit/middleware-401-telemetry.test.ts',
      // FLEET-FIX 2.3 / AUD-71: the CONSUMER side — the counter is actually
      // exposed on the health surface (runAllProbes -> /api/system/status), the
      // count is real, the reasons are discriminated, and a misconfiguration 401
      // does not move it. vi.mock of the sibling probes, so vitest-only.
      'tests/unit/unauthorized-401-health-surface.test.ts',
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

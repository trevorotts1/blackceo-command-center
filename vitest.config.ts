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
      // v5.16.2 FIX 4: Command Center resolves a provider key from OpenClaw's
      // SQLite auth_profile_store (where the gateway itself keeps the Ollama Cloud
      // key) — env still wins, the value is never logged, the store is read-only.
      // Uses vi.doMock + dynamic import of an '@/...'-aliased dep tree, so it only
      // runs here via `npm run test:vitest`, never the tsx --test glob.
      'tests/unit/provider-key-auth-store.test.ts',
      // P5-01 — My AI CEO BETA. Upload validation (5GB/executable break-it),
      // the feature flag, the DB-backed chat transcript store (proves migration
      // 101), the ONE-trust-engine-TWO-channels routing (ceo-chat → transcript,
      // telegram → Telegram), and the gateway forwarder graceful-down path. All
      // use vitest globals / vi.mock / the '@' alias, so they run here only —
      // the tsx --test glob (npm run test:unit) skips them (see package.json).
      'tests/unit/ceo-chat-upload-validation.test.ts',
      'tests/unit/ceo-chat-config.test.ts',
      'tests/unit/ceo-chat-store.test.ts',
      'tests/unit/trust-engine-ceo-chat-channel.test.ts',
      'tests/unit/ceo-chat-gateway-forward.test.ts',
      // P5-01 FIX: gatewayTransport.forward() must session-filter the shared
      // gateway 'notification' relay (getOpenClawClient() caches ONE client
      // per target, so concurrent chats share its single notification
      // stream). Drives the REAL gatewayTransport against a mocked
      // '@/lib/openclaw/client', so — like provider-key-auth-store.test.ts —
      // it only runs here via `npm run test:vitest`, never the tsx --test glob.
      'tests/unit/ceo-chat-gateway-session-isolation.test.ts',
      // Same P5-01 area, but drives the REAL gatewayTransport.forward() (queue
      // bridge, extractText() key precedence, completion-method regex,
      // REPLY_TIMEOUT_MS fallback, createSession id extraction, connect-failure
      // gateway_down path) against a fake OpenClawClient EventEmitter, mocked
      // via vi.doMock('@/lib/openclaw/client', ...) — vitest-only, same reason.
      'tests/unit/ceo-chat-gateway-transport.test.ts',
      // U27 / B-U13 — Skill-6 board projection drift (checkSkill6BoardProjection()).
      // Same vi.doMock('@/lib/db', ...) + vi.resetModules() re-import pattern as
      // the anthology_board_projection suite in deep-health.test.ts, kept in its
      // own file to avoid that file's documented shared-mock-registry gotcha —
      // vitest-only, never the tsx --test glob (see package.json).
      'tests/unit/skill6-board-projection.test.ts',
      // U100 — the "mc_board six" + Skill 35 cycle-manifest producer-reconcile
      // advisories (checkMcBoardSixProducerProjection() / checkSkill35CycleProjection()).
      // Same vi.doMock('@/lib/db', ...) + vi.resetModules() re-import pattern as
      // skill6-board-projection.test.ts above, kept in its own file for the same
      // shared-mock-registry reason — vitest-only, never the tsx --test glob.
      'tests/unit/mc-board-producer-projection.test.ts',
      // A-U12 — persona match/grounding observability probe (CC half).
      // checkPersonaGrounding() spawns a subprocess via execFile + a
      // PERSONA_GROUNDING_HEALTH_SCRIPT env override, and the route-level
      // suite uses the same vi.doMock('@/lib/db', ...) + vi.resetModules()
      // re-import pattern as skill6-board-projection.test.ts — kept in its
      // own file for the same shared-mock-registry reason, vitest-only.
      'tests/unit/u12-a-persona-grounding-health.test.ts',
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

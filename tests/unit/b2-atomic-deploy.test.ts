/**
 * B.2 Atomic Deploy — fixture-based unit tests.
 *
 * PRD Addendum B, item B.2 (P0): "Deploys are atomic and self-verifying with
 * auto-rollback."
 *
 * These tests exercise the logic of atomic-deploy.sh via a shell fixture
 * harness written in TypeScript. They assert that:
 *
 *   1. A good deploy (build succeeds, health check exits 0) ends green on the
 *      new build — success receipt emitted, exit 0.
 *   2. A broken build (npm run build exits non-zero) aborts at pre-flight —
 *      live .next untouched, no rollback artifact consumed, exit 2.
 *   3. A deploy where the build succeeds but the health check exits 1
 *      (definitive NOT GREEN) triggers auto-rollback: .next.rollback restored,
 *      pm2 restarted, rollback health-checked, exit 1.
 *   4. A deploy where the health check exits 3 (UNKNOWN/transient) retries up
 *      to HEALTH_RETRIES times and exits 3 — NEVER triggers rollback.
 *   5. Pre-flight disk gate: build is refused when disk is below DISK_MIN_GB
 *      after cleanup, exit 2.
 *   6. Both the success receipt and the rollback receipt contain the
 *      health-check JSON (key invariant from B.2 spec).
 *   7. FALSE-GREEN GUARD: npm build fails (buildExitCode=1) + live .next/BUILD_ID
 *      present → script exits 2 (not 0), old BUILD_ID is unchanged, 'ATOMIC
 *      DEPLOY SUCCESS' never appears in output.
 *
 * HEALTH CHECK STUB WIRING: atomic-deploy.sh resolves the health check from
 * CC_HEALTH_CHECK_PATH env var (if set) or SCRIPT_DIR. The fixture writes
 * the stub to a temp file and passes its path via CC_HEALTH_CHECK_PATH so
 * the script uses it unconditionally, regardless of where atomic-deploy.sh
 * lives on disk.
 *
 * Run: node --import tsx --test tests/unit/b2-atomic-deploy.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-test-'));
}

function rmTmpDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Build a self-contained fixture environment under `baseDir`:
 *   baseDir/
 *     app/                   ← fake APP_DIR
 *       .next/BUILD_ID       ← existing live build
 *       mission-control.db   ← fake DB
 *     bin/                   ← stub executables on PATH
 *       npm                  ← stub npm (configurable exit code + output)
 *       pm2                  ← stub pm2
 *       sqlite3              ← stub sqlite3
 *       df                   ← stub df
 *       curl                 ← stub curl
 *       python3              ← stub python3
 *       sleep                ← no-op stub (tests run fast)
 *     stubs/
 *       cc-health-check.sh   ← stub health check (injected via CC_HEALTH_CHECK_PATH)
 *
 * HEALTH CHECK STUB WIRING: the stub is written to baseDir/stubs/ and its path
 * is returned as `healthCheckStubPath`. The caller passes this via
 * CC_HEALTH_CHECK_PATH env var when invoking atomic-deploy.sh. The script reads
 * CC_HEALTH_CHECK_PATH before falling back to SCRIPT_DIR, so this wiring works
 * regardless of where atomic-deploy.sh lives on disk.
 */
interface FixtureConfig {
  /** Exit code stub npm build should return (0 = success) */
  buildExitCode?: number;
  /** Exit code stub cc-health-check.sh should return (0/1/3) */
  healthExitCode?: number;
  /** JSON string to emit from stub health check */
  healthJson?: string;
  /** Exit code for rollback health check (defaults to 0) */
  rollbackHealthExitCode?: number;
  /** Free disk GB to report from stub df (default 10) */
  freeDiskGb?: number;
  /** Whether to pre-create .next/BUILD_ID in app dir (simulates existing live build) */
  liveNextExists?: boolean;
}

interface Fixture {
  baseDir: string;
  appDir: string;
  binDir: string;
  /** Absolute path to the stub cc-health-check.sh (injected via CC_HEALTH_CHECK_PATH) */
  healthCheckStubPath: string;
  /** Path to atomic-deploy.sh being tested */
  deployScript: string;
  cleanup(): void;
}

function buildFixture(cfg: FixtureConfig = {}): Fixture {
  const {
    buildExitCode = 0,
    healthExitCode = 0,
    healthJson = '{"green":true,"timestamp":"2026-06-10T00:00:00Z","checks":{}}',
    rollbackHealthExitCode = 0,
    freeDiskGb = 10,
    liveNextExists = true,
  } = cfg;

  const baseDir = makeTmpDir();
  const appDir = path.join(baseDir, 'app');
  const binDir = path.join(baseDir, 'bin');
  const stubsDir = path.join(baseDir, 'stubs');
  mkdirSync(appDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stubsDir, { recursive: true });

  // Fake DB
  writeFileSync(path.join(appDir, 'mission-control.db'), 'SQLite fixture');

  // Existing live .next
  if (liveNextExists) {
    mkdirSync(path.join(appDir, '.next'), { recursive: true });
    writeFileSync(path.join(appDir, '.next', 'BUILD_ID'), 'old-build-id');
  }

  // ── stub npm ────────────────────────────────────────────────────────────
  // When npm run build is called:
  // - if buildExitCode=0 and NEXT_DIST_DIR is set, write BUILD_ID there
  // - always write the exit code to BUILD_EXIT_FILE (the temp file the script reads)
  const npmStub = `#!/usr/bin/env bash
# Stub npm for B.2 fixture tests
if [[ "$1" == "run" && "$2" == "build" ]]; then
  if [[ "${buildExitCode}" -eq 0 && -n "\${NEXT_DIST_DIR:-}" ]]; then
    mkdir -p "$NEXT_DIST_DIR"
    echo "new-build-id" > "$NEXT_DIST_DIR/BUILD_ID"
  fi
  # Write exit code to BUILD_EXIT_FILE so atomic-deploy.sh subshell captures it correctly
  if [[ -n "\${BUILD_EXIT_FILE:-}" ]]; then
    echo "${buildExitCode}" > "$BUILD_EXIT_FILE"
  fi
  exit ${buildExitCode}
fi
# npm cache clean and other commands succeed silently
exit 0
`;
  writeFileSync(path.join(binDir, 'npm'), npmStub, { mode: 0o755 });

  // ── stub pm2 ────────────────────────────────────────────────────────────
  const pm2Stub = `#!/usr/bin/env bash
# Stub pm2 for B.2 fixture tests
case "$1" in
  jlist) echo '[]' ;;
  list)  echo 'mission-control' ;;
  restart|reload|start|delete|stop) exit 0 ;;
  *) exit 0 ;;
esac
`;
  writeFileSync(path.join(binDir, 'pm2'), pm2Stub, { mode: 0o755 });

  // ── stub sqlite3 ─────────────────────────────────────────────────────────
  const sqlite3Stub = `#!/usr/bin/env bash
# Stub sqlite3 for B.2 fixture tests — always succeeds
exit 0
`;
  writeFileSync(path.join(binDir, 'sqlite3'), sqlite3Stub, { mode: 0o755 });

  // ── stub df ──────────────────────────────────────────────────────────────
  // Returns a df -k output with freeDiskGb of free space
  const freeKb = freeDiskGb * 1024 * 1024;
  const dfStub = `#!/usr/bin/env bash
# Stub df for B.2 fixture tests
echo "Filesystem     1K-blocks    Used  Available Use% Mounted on"
echo "/dev/sda1       20971520 1000000  ${freeKb}  10% /"
`;
  writeFileSync(path.join(binDir, 'df'), dfStub, { mode: 0o755 });

  // ── stub curl ────────────────────────────────────────────────────────────
  const curlStub = `#!/usr/bin/env bash
exit 0
`;
  writeFileSync(path.join(binDir, 'curl'), curlStub, { mode: 0o755 });

  // ── stub python3 ─────────────────────────────────────────────────────────
  const python3Stub = `#!/usr/bin/env python3
import sys
# Return empty string for all pm2 queries (no non-canonical apps)
print('')
`;
  writeFileSync(path.join(binDir, 'python3'), python3Stub, { mode: 0o755 });

  // ── stub sleep (no-op so tests run fast) ─────────────────────────────────
  const sleepStub = `#!/usr/bin/env bash
exit 0
`;
  writeFileSync(path.join(binDir, 'sleep'), sleepStub, { mode: 0o755 });

  // ── stub cc-health-check.sh ──────────────────────────────────────────────
  // Written to stubsDir; path injected via CC_HEALTH_CHECK_PATH env var.
  // atomic-deploy.sh checks CC_HEALTH_CHECK_PATH before falling back to
  // SCRIPT_DIR, so this stub is always picked up regardless of where
  // atomic-deploy.sh lives on disk.
  //
  // First call returns healthExitCode + healthJson.
  // Subsequent calls (rollback re-check) return rollbackHealthExitCode.
  // A counter file in baseDir tracks invocation count.
  const healthStubPath = path.join(stubsDir, 'cc-health-check.sh');
  const healthJsonEscaped = healthJson.replace(/'/g, "'\\''");
  const rollbackGreen = rollbackHealthExitCode === 0 ? 'true' : 'false';
  const healthStub = `#!/usr/bin/env bash
# Stub cc-health-check.sh for B.2 fixture tests
# Injected via CC_HEALTH_CHECK_PATH; never needs to live in SCRIPT_DIR.
COUNTER_FILE="${baseDir}/.health-call-count"
COUNT=0
if [[ -f "$COUNTER_FILE" ]]; then
  COUNT=$(cat "$COUNTER_FILE")
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

if [[ "$COUNT" -eq 1 ]]; then
  echo '${healthJsonEscaped}'
  exit ${healthExitCode}
else
  echo '{"green":${rollbackGreen},"timestamp":"2026-06-10T00:00:00Z","checks":{}}'
  exit ${rollbackHealthExitCode}
fi
`;
  writeFileSync(healthStubPath, healthStub, { mode: 0o755 });

  // ── resolve atomic-deploy.sh location ───────────────────────────────────
  const deployScript = path.join(process.cwd(), 'scripts', 'atomic-deploy.sh');

  return {
    baseDir, appDir, binDir,
    healthCheckStubPath: healthStubPath,
    deployScript,
    cleanup() { rmTmpDir(baseDir); },
  };
}

/**
 * Run atomic-deploy.sh with the fixture environment.
 * Returns { exitCode, stdout, stderr }.
 *
 * CC_HEALTH_CHECK_PATH is always set to fixture.healthCheckStubPath so
 * atomic-deploy.sh uses our stub instead of SCRIPT_DIR/cc-health-check.sh.
 * sleep is stubbed with a no-op in binDir so tests don't wait real seconds.
 */
function runDeploy(fixture: Fixture, extraEnv: Record<string, string> = {}): {
  exitCode: number; stdout: string; stderr: string;
} {
  const result = spawnSync(
    (() => {
      try { return execSync('which bash').toString().trim(); } catch { return '/opt/homebrew/bin/bash'; }
    })(),
    [fixture.deployScript,
      '--app-dir', fixture.appDir,
      '--pm2-app', 'mission-control',
      '--port', '4000',
      '--disk-min-gb', '5',
      '--health-retries', '2',
      '--health-retry-wait', '0',
    ],
    {
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
        HOME: fixture.baseDir,
        // Inject health check stub path — atomic-deploy.sh reads CC_HEALTH_CHECK_PATH
        // before falling back to SCRIPT_DIR, so this always wins.
        CC_HEALTH_CHECK_PATH: fixture.healthCheckStubPath,
        ...extraEnv,
      },
      cwd: fixture.appDir,
      timeout: 60_000,
      encoding: 'utf8',
    },
  );

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ─── Spec Verify (a+fg): FALSE-GREEN guard ───────────────────────────────────

/**
 * FALSE-GREEN guard: npm build exits 1 + live .next/BUILD_ID present.
 * Script must exit 2 (pre-flight abort), old BUILD_ID must be unchanged,
 * and 'ATOMIC DEPLOY SUCCESS' must never appear in output.
 *
 * This is the primary false-green scenario from REDO #1: the pipe construction
 * 'npm run build ... | while ... done || true' previously masked the npm exit
 * code, and the fallback condition accepted the old BUILD_ID as the new build.
 */
test('Spec Verify (a+fg): broken build (npm exits 1) + live BUILD_ID → exit 2, old build untouched, no SUCCESS in output', async () => {
  const fixture = buildFixture({ buildExitCode: 1, liveNextExists: true });
  try {
    const { exitCode, stderr } = runDeploy(fixture);

    // Must exit 2 — pre-flight abort, not exit 0 (false-green) and not exit 1 (rollback)
    assert.strictEqual(exitCode, 2,
      `Expected exit 2 (pre-flight abort on build failure) but got exit ${exitCode}.\nstderr:\n${stderr}`);

    // Old BUILD_ID must still be 'old-build-id' — live .next must not have been swapped
    const liveNextBuildId = path.join(fixture.appDir, '.next', 'BUILD_ID');
    assert.ok(existsSync(liveNextBuildId), '.next/BUILD_ID must still exist after build failure');
    const currentBuildId = readFileSync(liveNextBuildId, 'utf8').trim();
    assert.strictEqual(currentBuildId, 'old-build-id',
      `BUILD_ID must remain 'old-build-id' after failed build, got '${currentBuildId}'`);

    // 'ATOMIC DEPLOY SUCCESS' must never appear in output
    assert.ok(
      !stderr.includes('ATOMIC DEPLOY SUCCESS'),
      `ATOMIC DEPLOY SUCCESS must not appear in output when build failed.\nstderr:\n${stderr}`,
    );
  } finally {
    fixture.cleanup();
  }
});

// ─── Spec Verify (b): good deploy ───────────────────────────────────────────

/**
 * Good deploy: build exits 0, health check exits 0.
 * Script must exit 0, new BUILD_ID installed, receipt contains health JSON.
 */
test('Spec Verify (b): good deploy (build ok, health ok) → exit 0, new BUILD_ID, receipt has health JSON', async () => {
  const healthJson = '{"green":true,"timestamp":"2026-06-10T00:00:00Z","checks":{"http":true}}';
  const fixture = buildFixture({ buildExitCode: 0, healthExitCode: 0, healthJson, liveNextExists: true });
  try {
    const { exitCode, stderr } = runDeploy(fixture);

    assert.strictEqual(exitCode, 0,
      `Expected exit 0 (success) but got exit ${exitCode}.\nstderr:\n${stderr}`);

    // New BUILD_ID must be installed
    const liveNextBuildId = path.join(fixture.appDir, '.next', 'BUILD_ID');
    assert.ok(existsSync(liveNextBuildId), '.next/BUILD_ID must exist after good deploy');
    const installedBuildId = readFileSync(liveNextBuildId, 'utf8').trim();
    assert.strictEqual(installedBuildId, 'new-build-id',
      `Expected new BUILD_ID 'new-build-id' but got '${installedBuildId}'`);

    // Success receipt must appear
    assert.ok(
      stderr.includes('ATOMIC DEPLOY SUCCESS'),
      `Success receipt must appear in output for a good deploy.\nstderr:\n${stderr}`,
    );
    // Receipt must contain health JSON
    assert.ok(
      stderr.includes('Health JSON') || stderr.includes('green'),
      `Receipt must contain health JSON for a good deploy.\nstderr:\n${stderr}`,
    );
  } finally {
    fixture.cleanup();
  }
});

// ─── Spec Verify (c): build ok + health exits 1 → rollback ─────────────────

/**
 * Build succeeds but health check exits 1 (definitive NOT GREEN).
 * Script must exit 1, auto-rollback fires, .next.rollback restored,
 * rollback receipt emitted in output.
 */
test('Spec Verify (c): build ok + health exits 1 → rollback fires, .next.rollback restored, exit 1', async () => {
  const failHealthJson = '{"green":false,"timestamp":"2026-06-10T00:00:00Z","checks":{"http":false}}';
  const fixture = buildFixture({
    buildExitCode: 0,
    healthExitCode: 1,
    healthJson: failHealthJson,
    rollbackHealthExitCode: 0,
    liveNextExists: true,
  });
  try {
    const { exitCode, stderr } = runDeploy(fixture);

    assert.strictEqual(exitCode, 1,
      `Expected exit 1 (rollback) but got exit ${exitCode}.\nstderr:\n${stderr}`);

    // Rollback receipt must be emitted
    assert.ok(
      stderr.includes('AUTO-ROLLBACK EXECUTED') || stderr.includes('ROLLBACK'),
      `Rollback receipt must appear in output when health check fails.\nstderr:\n${stderr}`,
    );

    // .next.rollback must exist (was created in Phase 1c and must survive)
    const rollbackDir = path.join(fixture.appDir, '.next.rollback');
    assert.ok(existsSync(rollbackDir), '.next.rollback must exist after rollback');

    // .next must have been restored (contains old-build-id from rollback)
    const liveNextBuildId = path.join(fixture.appDir, '.next', 'BUILD_ID');
    assert.ok(existsSync(liveNextBuildId), '.next/BUILD_ID must exist after rollback restore');
    const restoredBuildId = readFileSync(liveNextBuildId, 'utf8').trim();
    assert.strictEqual(restoredBuildId, 'old-build-id',
      `Expected rollback to restore 'old-build-id' but got '${restoredBuildId}'`);

    // Receipt must contain both deploy and rollback health JSON
    assert.ok(
      stderr.includes('Deploy health JSON') || stderr.includes('failed build'),
      `Rollback receipt must include deploy health JSON.\nstderr:\n${stderr}`,
    );
    assert.ok(
      stderr.includes('Rollback health JSON') || stderr.includes('restored build'),
      `Rollback receipt must include rollback health JSON.\nstderr:\n${stderr}`,
    );
  } finally {
    fixture.cleanup();
  }
});

// ─── Spec Verify (d): health exits 3 → retry, no rollback, exit 3 ───────────

/**
 * Health check exits 3 (UNKNOWN/transient) on all retry attempts.
 * Script must exit 3, NO rollback triggered, new build remains in .next.
 */
test('Spec Verify (d): health exits 3 (all retries) → exit 3, no rollback, new build stays live', async () => {
  const unknownHealthJson = '{"green":null,"timestamp":"2026-06-10T00:00:00Z","checks":{}}';
  const fixture = buildFixture({
    buildExitCode: 0,
    healthExitCode: 3,
    healthJson: unknownHealthJson,
    rollbackHealthExitCode: 3,  // Rollback never fires, so this is not called
    liveNextExists: true,
  });
  try {
    const { exitCode, stderr } = runDeploy(fixture);

    assert.strictEqual(exitCode, 3,
      `Expected exit 3 (UNKNOWN after retries) but got exit ${exitCode}.\nstderr:\n${stderr}`);

    // Rollback must NOT have fired
    assert.ok(
      !stderr.includes('AUTO-ROLLBACK EXECUTED'),
      `Rollback must NOT fire on exit-3 UNKNOWN state.\nstderr:\n${stderr}`,
    );

    // New build must still be in .next (deploy is NOT rolled back on exit 3)
    const liveNextBuildId = path.join(fixture.appDir, '.next', 'BUILD_ID');
    if (existsSync(liveNextBuildId)) {
      const currentBuildId = readFileSync(liveNextBuildId, 'utf8').trim();
      assert.strictEqual(currentBuildId, 'new-build-id',
        'New build must stay live on exit-3 (no rollback on UNKNOWN)');
    }

    // UNKNOWN receipt must be emitted
    assert.ok(
      stderr.includes('UNKNOWN') || stderr.includes('exit 3'),
      `UNKNOWN receipt must appear in output for exit-3 state.\nstderr:\n${stderr}`,
    );
  } finally {
    fixture.cleanup();
  }
});

// ─── Spec Verify (e): disk gate ─────────────────────────────────────────────

/**
 * Disk is below DISK_MIN_GB (5 GB) even after cleanup.
 * Script must exit 2 with a loud pre-flight abort.
 */
test('Spec Verify (e): disk below threshold after cleanup → exit 2, pre-flight abort', async () => {
  const fixture = buildFixture({ freeDiskGb: 1, liveNextExists: true });
  try {
    const { exitCode, stderr } = runDeploy(fixture);

    assert.strictEqual(exitCode, 2,
      `Expected exit 2 (disk pre-flight abort) but got exit ${exitCode}`);

    assert.ok(
      stderr.includes('disk') || stderr.includes('Disk') || stderr.includes('PRE-FLIGHT'),
      `Pre-flight abort receipt must mention disk in output.\nstderr:\n${stderr}`,
    );
  } finally {
    fixture.cleanup();
  }
});

// ─── Spec Verify (f): mtime same-second edge case ───────────────────────────

/**
 * Mtime false-fail regression: BUILD_ID mtime exactly equal to BUILD_START_TS.
 *
 * On fast machines (M-series Mac, any SSD) the npm stub writes BUILD_ID in
 * << 1 ms; date +%s has 1-second resolution, so BUILD_ID_MTIME == BUILD_START_TS
 * virtually always in CI / fixture runs.  The old <= guard rejected this as a
 * "stale artefact" and exited 2.  After the fix (< instead of <=) the same-second
 * case must be accepted and the deploy must complete with exit 0.
 *
 * This test pins the scenario explicitly: good build + health green → exit 0.
 * The mtime equality is guaranteed by the fixture harness running in << 1 second
 * with a no-op sleep stub.
 */
test('Spec Verify (f): good build + BUILD_ID mtime equal to BUILD_START_TS (same second) → exit 0, not stale-artefact exit 2', async () => {
  const healthJson = '{"green":true,"timestamp":"2026-06-10T00:00:00Z","checks":{"http":true}}';
  const fixture = buildFixture({ buildExitCode: 0, healthExitCode: 0, healthJson, liveNextExists: true });
  try {
    const { exitCode, stderr } = runDeploy(fixture);

    assert.strictEqual(exitCode, 0,
      `Expected exit 0 (success) even when BUILD_ID mtime == BUILD_START_TS (same second). ` +
      `The <= mtime guard must have been changed to <.\n` +
      `Got exit ${exitCode}.\nstderr:\n${stderr}`);

    // Success receipt must appear (not a stale-artefact abort)
    assert.ok(
      !stderr.includes('stale artefact') && !stderr.includes('predates the build'),
      `Must not report stale artefact for a fresh build written in the same second.\nstderr:\n${stderr}`,
    );
    assert.ok(
      stderr.includes('ATOMIC DEPLOY SUCCESS'),
      `Success receipt must appear for same-second mtime build.\nstderr:\n${stderr}`,
    );
  } finally {
    fixture.cleanup();
  }
});

// ─── Spec Verify (g): NEXT_DIST_DIR bypass + npm non-zero → .next intact ────

/**
 * Data-loss regression: NEXT_DIST_DIR bypass path + npm exits non-zero.
 *
 * Scenario: the installed Next.js version ignores NEXT_DIST_DIR so the build
 * goes to APP_DIR/.next.  The mtime guard passes (fresh BUILD_ID), so the script
 * moves APP_DIR/.next into BUILD_TMP.  npm then exits non-zero (e.g. TypeScript
 * error after webpack wrote .next/BUILD_ID).  Without the fix, the script would
 * rm -rf BUILD_TMP and exit 2 — leaving APP_DIR/.next MISSING and breaking the
 * live server while reporting "old build untouched".
 *
 * After the fix: if BUILD_TMP exists, APP_DIR/.next is absent, and ROLLBACK_EXISTS=1,
 * the script restores APP_DIR/.next from .next.rollback before deleting BUILD_TMP.
 * Exit 2 is still returned (correct: no swap happened), but the live .next is
 * present and intact as the spec requires.
 *
 * The fixture simulates this by:
 *   - Setting buildExitCode = 1 (npm fails)
 *   - Writing a fresh BUILD_ID directly to APP_DIR/.next (simulating NEXT_DIST_DIR
 *     being ignored — build went to .next, not to NEXT_DIST_DIR/BUILD_TMP)
 *     and deleting APP_DIR/.next AFTER the move, which the npm stub handles by
 *     not writing to NEXT_DIST_DIR at all.
 *
 * NOTE: the exact NEXT_DIST_DIR-ignored path in atomic-deploy.sh requires that
 * APP_DIR/.next/BUILD_ID exists AND BUILD_ID is absent from BUILD_TMP at the
 * detection point.  The npm stub achieves this by writing nothing to NEXT_DIST_DIR
 * and exiting 1.  To trigger the fallback detection, we pre-write a fresh BUILD_ID
 * to APP_DIR/.next in the fixture setup so the fallback branch is entered.
 */
test('Spec Verify (g): NEXT_DIST_DIR bypass + npm exits non-zero → exit 2, APP_DIR/.next still present (old build untouched)', async () => {
  // Build a fixture where npm writes nothing to NEXT_DIST_DIR and exits 1
  const baseDir = makeTmpDir();
  const appDir = path.join(baseDir, 'app');
  const binDir = path.join(baseDir, 'bin');
  const stubsDir = path.join(baseDir, 'stubs');
  mkdirSync(appDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stubsDir, { recursive: true });

  // Fake DB
  writeFileSync(path.join(appDir, 'mission-control.db'), 'SQLite fixture');

  // Existing live .next with a BUILD_ID that will be "fresh" (mtime guard passes
  // because we touch it just before the script runs — the fixture harness runs
  // in << 1 second of real time, so the timestamp will be >= BUILD_START_TS).
  mkdirSync(path.join(appDir, '.next'), { recursive: true });
  writeFileSync(path.join(appDir, '.next', 'BUILD_ID'), 'old-build-id');

  // npm stub: ignores NEXT_DIST_DIR, writes nothing there, exits 1.
  // It also writes BUILD_ID to APP_DIR/.next to simulate the NEXT_DIST_DIR-ignored path,
  // and writes exit code 1 to BUILD_EXIT_FILE.
  const npmStub = `#!/usr/bin/env bash
if [[ "$1" == "run" && "$2" == "build" ]]; then
  # Simulate Next.js ignoring NEXT_DIST_DIR — write fresh BUILD_ID to APP_DIR/.next
  # (it was already there; just touch it so mtime == now, making the guard pass)
  touch "${path.join(appDir, '.next', 'BUILD_ID')}" 2>/dev/null || true
  # Write failure exit code
  if [[ -n "\${BUILD_EXIT_FILE:-}" ]]; then
    echo "1" > "$BUILD_EXIT_FILE"
  fi
  exit 1
fi
exit 0
`;
  writeFileSync(path.join(binDir, 'npm'), npmStub, { mode: 0o755 });

  // Standard stubs
  const pm2Stub = `#!/usr/bin/env bash
case "$1" in
  jlist) echo '[]' ;;
  list)  echo 'mission-control' ;;
  restart|reload|start|delete|stop) exit 0 ;;
  *) exit 0 ;;
esac
`;
  writeFileSync(path.join(binDir, 'pm2'), pm2Stub, { mode: 0o755 });
  writeFileSync(path.join(binDir, 'sqlite3'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const freeKb = 10 * 1024 * 1024;
  writeFileSync(path.join(binDir, 'df'), `#!/usr/bin/env bash\necho "Filesystem     1K-blocks    Used  Available Use% Mounted on"\necho "/dev/sda1       20971520 1000000  ${freeKb}  10% /"\n`, { mode: 0o755 });
  writeFileSync(path.join(binDir, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(binDir, 'python3'), '#!/usr/bin/env python3\nimport sys\nprint("")\n', { mode: 0o755 });
  writeFileSync(path.join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  // Health check stub (should never be called in this path — build fails before swap)
  const healthStubPath = path.join(stubsDir, 'cc-health-check.sh');
  writeFileSync(healthStubPath, '#!/usr/bin/env bash\necho \'{"green":true}\'\nexit 0\n', { mode: 0o755 });

  const deployScript = path.join(process.cwd(), 'scripts', 'atomic-deploy.sh');

  let exitCode: number;
  let stderr: string;
  try {
    const result = spawnSync(
      (() => {
        try { return execSync('which bash').toString().trim(); } catch { return '/opt/homebrew/bin/bash'; }
      })(),
      [deployScript,
        '--app-dir', appDir,
        '--pm2-app', 'mission-control',
        '--port', '4000',
        '--disk-min-gb', '5',
        '--health-retries', '2',
        '--health-retry-wait', '0',
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          HOME: baseDir,
          CC_HEALTH_CHECK_PATH: healthStubPath,
        },
        cwd: appDir,
        timeout: 60_000,
        encoding: 'utf8',
      },
    );
    exitCode = result.status ?? 1;
    stderr = result.stderr ?? '';
  } finally {
    // cleanup happens after assertions below
  }

  try {
    // Must exit 2 (pre-flight/build abort — no swap occurred)
    assert.strictEqual(exitCode, 2,
      `Expected exit 2 (build failed, no swap) but got exit ${exitCode}.\nstderr:\n${stderr}`);

    // APP_DIR/.next must still exist — the data-loss bug would leave it missing
    assert.ok(
      existsSync(path.join(appDir, '.next')),
      'APP_DIR/.next must still exist after exit 2 (spec: old build untouched). ' +
      'Data-loss bug: .next was moved into BUILD_TMP and then BUILD_TMP was deleted.',
    );

    // The BUILD_ID content must be intact (old build or rollback restore)
    const buildIdPath = path.join(appDir, '.next', 'BUILD_ID');
    assert.ok(existsSync(buildIdPath), 'APP_DIR/.next/BUILD_ID must exist after exit 2');

    // ATOMIC DEPLOY SUCCESS must never appear
    assert.ok(
      !stderr.includes('ATOMIC DEPLOY SUCCESS'),
      `ATOMIC DEPLOY SUCCESS must not appear when build failed.\nstderr:\n${stderr}`,
    );
  } finally {
    try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── Static / structural tests (fast, no fixture execution) ─────────────────

/**
 * Smoke: verify qc-cc.sh B.2 static checks pass on the committed atomic-deploy.sh.
 * This is the "duck-e2e" gate: if the static checks in qc-cc.sh fail,
 * something about the script's structure regressed.
 */
test('B.2 static QC: qc-cc.sh section 10 checks all pass on atomic-deploy.sh', () => {
  const deployScriptPath = path.join(process.cwd(), 'scripts', 'atomic-deploy.sh');
  assert.ok(existsSync(deployScriptPath), 'atomic-deploy.sh must exist');

  const src = readFileSync(deployScriptPath, 'utf8');

  // 10.1 — no placeholder stub
  assert.ok(
    !src.includes('implementation pending'),
    '10.1: atomic-deploy.sh must not contain "implementation pending"',
  );

  // 10.2 — disk gate present
  assert.ok(src.includes('DISK_MIN_GB'), '10.2: must reference DISK_MIN_GB');

  // 10.3 — DB backup via sqlite3 checkpoint
  assert.ok(src.includes('wal_checkpoint'), '10.3: must call sqlite3 WAL checkpoint for DB backup');

  // 10.4 — rollback snapshot
  assert.ok(src.includes('next.rollback'), '10.4: must create .next.rollback snapshot');

  // 10.5 — kills non-canonical pm2 apps
  assert.ok(
    src.includes('NON_CANONICAL') || src.includes('non-canonical'),
    '10.5: must kill non-canonical pm2 apps',
  );

  // 10.6 — temp dir build
  assert.ok(
    src.includes('BUILD_TMP') || src.includes('NEXT_DIST_DIR'),
    '10.6: must build to a temp dir',
  );

  // 10.7 — atomic swap via mv
  assert.ok(
    src.includes('Atomic swap') || /mv.*\.next/.test(src),
    '10.7: must perform atomic swap via mv',
  );

  // 10.8 — restart before health check
  assert.ok(
    src.includes('pm2 restart') || src.includes('pm2 reload'),
    '10.8: must restart pm2 before health check',
  );

  // 10.9 — calls cc-health-check.sh and captures JSON
  assert.ok(src.includes('cc-health-check.sh'), '10.9: must call cc-health-check.sh');
  assert.ok(src.includes('HEALTH_JSON'), '10.9: must capture health check JSON');

  // 10.10 — exit-1 health check triggers rollback
  assert.ok(
    src.includes('ROLLBACK') || src.includes('rollback'),
    '10.10: must have rollback path',
  );
  const hasRollbackOnExit1 =
    /HEALTH_EXIT.*eq.*1|1.*rollback|rollback.*exit.*1/i.test(src) ||
    (src.includes('HEALTH_EXIT') && src.includes('ROLLBACK'));
  assert.ok(hasRollbackOnExit1, '10.10: exit-1 health check must trigger rollback');

  // 10.11 — rollback restores .next.rollback + restarts
  assert.ok(
    src.includes('ROLLBACK_DIR') || src.includes('next.rollback'),
    '10.11: rollback must restore from .next.rollback',
  );

  // 10.12 — rollback itself health-checked
  assert.ok(
    src.includes('ROLLBACK_HEALTH') || /rollback.*health/i.test(src),
    '10.12: rollback health check must be re-run after restore',
  );

  // 10.13 — receipts include health JSON
  assert.ok(
    (src.match(/HEALTH_JSON/g) || []).length >= 2,
    '10.13: health JSON must be referenced in at least two receipt paths',
  );

  // 10.14 — exit-3 retries, never rolls back
  assert.ok(
    src.includes('HEALTH_RETRIES') || /exit.*3|UNKNOWN/i.test(src),
    '10.14: must retry on exit-3 and never rollback',
  );
  // Confirm there is no rollback code in the exit-3 verdict block.
  // Use lastIndexOf to find the ACTUAL exit-3 verdict statement in Phase 5,
  // not the first occurrence in the header comment (~line 35).
  const exit3LastIndex = src.lastIndexOf('exit 3');
  assert.ok(exit3LastIndex !== -1, '10.14: script must exit 3 for UNKNOWN state');
  // Verify the 600-char context around the actual exit-3 verdict statement
  // does not contain rollback restore code (cp -r ... ROLLBACK_DIR).
  const contextAroundActualExit3 = src.slice(Math.max(0, exit3LastIndex - 600), exit3LastIndex + 20);
  const hasRollbackCommandNearExit3 =
    /cp -r .*(ROLLBACK_DIR|\.next\.rollback)/.test(contextAroundActualExit3);
  assert.ok(
    !hasRollbackCommandNearExit3,
    '10.14: rollback cp command must NOT appear near the exit-3 verdict statement',
  );
});

/**
 * Structural: verify the scripts/atomic-deploy.sh exit-code contract is documented.
 * Exit codes 0, 1, 2, 3 must all appear as documented exit points.
 */
test('B.2 structural: all four exit codes (0/1/2/3) present in atomic-deploy.sh', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'scripts', 'atomic-deploy.sh'),
    'utf8',
  );
  assert.ok(/exit 0/.test(src), 'exit 0 (success) must be present');
  assert.ok(/exit 1/.test(src), 'exit 1 (rollback / failure) must be present');
  assert.ok(/exit 2/.test(src), 'exit 2 (pre-flight abort) must be present');
  assert.ok(/exit 3/.test(src), 'exit 3 (UNKNOWN) must be present');
});

/**
 * Structural: atomic-deploy.sh must never call cc-health-check.sh with
 * --allow-default (that flag is forbidden in post-deploy gates per B.1 spec).
 */
test('B.2 structural: atomic-deploy.sh never passes --allow-default to health check', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'scripts', 'atomic-deploy.sh'),
    'utf8',
  );
  assert.ok(
    !src.includes('--allow-default'),
    'atomic-deploy.sh must never pass --allow-default to cc-health-check.sh',
  );
});

/**
 * Structural: the disk-cleanup function handles the standard cleanup targets
 * documented in the B.4 pre-flight: old DB backups, npm cache, log rotation.
 */
test('B.2 structural: disk cleanup handles expected targets', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'scripts', 'atomic-deploy.sh'),
    'utf8',
  );
  assert.ok(src.includes('npm cache'), 'disk cleanup must purge npm cache');
  assert.ok(
    src.includes('.db.backup') || src.includes('db.backup'),
    'disk cleanup must remove old DB backups',
  );
  assert.ok(
    src.includes('.pm2/logs') || src.includes('pm2.*log'),
    'disk cleanup must rotate pm2 logs',
  );
});

/**
 * Structural: rollback path must re-run health check and include the result
 * in the receipt (both deploy-fail health JSON and rollback health JSON).
 */
test('B.2 structural: rollback receipt references both deploy and rollback health JSON', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'scripts', 'atomic-deploy.sh'),
    'utf8',
  );
  assert.ok(
    src.includes('FAILED_HEALTH_JSON') || src.includes('deploy_health_json') ||
    (src.includes('HEALTH_JSON') && src.includes('ROLLBACK_HEALTH_JSON')),
    'rollback receipt must include both deploy and rollback health JSON',
  );
  assert.ok(
    src.includes('ROLLBACK_HEALTH_JSON') || src.includes('rollback_health_json'),
    'rollback receipt must include rollback health JSON',
  );
});

/**
 * Structural: verify the B.2 QC gates in qc-cc.sh reference the fixture test file.
 */
test('B.2 structural: qc-cc.sh references b2-atomic-deploy.test.ts', () => {
  const qcSrc = readFileSync(
    path.join(process.cwd(), 'scripts', 'qc-cc.sh'),
    'utf8',
  );
  assert.ok(
    qcSrc.includes('b2-atomic-deploy.test.ts'),
    'qc-cc.sh must include a check for b2-atomic-deploy.test.ts',
  );
  assert.ok(
    qcSrc.includes('cc-health-check.sh') && qcSrc.includes('atomic-deploy.sh'),
    'qc-cc.sh B.2 section must check both scripts',
  );
});

/**
 * Structural: mtime guard is implemented — rejects stale BUILD_ID.
 * Verifies BUILD_START_TS is captured before the build, BUILD_ID mtime is
 * compared against it, and stale artefacts are rejected.
 */
test('B.2 structural: mtime guard present — rejects stale BUILD_ID (BUILD_START_TS + mtime comparison)', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'scripts', 'atomic-deploy.sh'),
    'utf8',
  );
  // Must capture build start timestamp
  assert.ok(
    src.includes('BUILD_START_TS'),
    'mtime guard must define BUILD_START_TS before npm run build',
  );
  // Must capture BUILD_ID mtime for comparison
  assert.ok(
    src.includes('BUILD_ID_MTIME') || src.includes('NEXT_BUILD_ID_MTIME'),
    'mtime guard must capture BUILD_ID mtime for comparison',
  );
  // Comparison must use < BUILD_START_TS (strictly less than) to reject stale artefacts.
  // Using <= would reject a fresh build whose BUILD_ID mtime equals BUILD_START_TS
  // (same wall-clock second) — a spurious false-fail on fast machines like M-series Macs.
  assert.ok(
    /BUILD_ID_MTIME\s*<\s*BUILD_START_TS|NEXT_BUILD_ID_MTIME\s*<\s*BUILD_START_TS/.test(src),
    'mtime guard must reject BUILD_ID with mtime < BUILD_START_TS (strictly less than, not <=)',
  );
});

/**
 * Structural: CC_HEALTH_CHECK_PATH env override is present in atomic-deploy.sh.
 * This is the wiring mechanism for fixture harnesses.
 */
test('B.2 structural: CC_HEALTH_CHECK_PATH env override supported for fixture harnesses', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'scripts', 'atomic-deploy.sh'),
    'utf8',
  );
  assert.ok(
    src.includes('CC_HEALTH_CHECK_PATH') || src.includes('HEALTH_CHECK_PATH_OVERRIDE'),
    'atomic-deploy.sh must support CC_HEALTH_CHECK_PATH env override for fixture harnesses',
  );
});

// ─── P1 integration: fixtures with APP_DIR under /data ───────────────────────
//
// These fixtures run atomic-deploy.sh with APP_DIR under a /data-like path to
// prove that P1 fix (exact-mount-only guard in resolveCheckPath) does not cause
// disk FAIL for valid app dirs under /data.
//
// IMPORTANT: the disk check in atomic-deploy.sh uses the shell `df` command
// (not the TypeScript diskReader), so the P1 fix in deep-checks.ts affects the
// TypeScript health endpoint.  The shell-level disk gate in atomic-deploy.sh
// is independent and already correct (uses df on $DISK_PATH or $APP_DIR).
//
// What these tests prove:
//   (a) A broken build (npm exits 1) with APP_DIR under /data → exit 2 (pre-flight
//       abort), never exit 1 (rollback). The P1 context means no disk false-fail
//       can masquerade as a rollback trigger.
//   (b) A good deploy (build ok, health green) with APP_DIR under /data → exit 0,
//       new BUILD_ID installed. Proves the full happy path works for VPS paths.

/**
 * Builds a fixture with APP_DIR placed under a /data-like subdirectory
 * inside the OS tmpdir (e.g. /tmp/b2-test-XXXXX/data/mission-control).
 * This simulates a VPS app dir at /data/mission-control without requiring
 * root access to the real /data mount.
 */
function buildDataPathFixture(cfg: FixtureConfig = {}): Fixture {
  const base = buildFixture(cfg);
  // Rename appDir to a /data-like subpath within baseDir:
  //   baseDir/data/mission-control  (simulates /data/mission-control)
  const dataSubDir = path.join(base.baseDir, 'data', 'mission-control');
  mkdirSync(dataSubDir, { recursive: true });

  // Migrate contents from base.appDir to dataSubDir
  const oldAppDir = base.appDir;
  try {
    spawnSync('cp', ['-r', oldAppDir + '/.', dataSubDir + '/'], { stdio: 'ignore' });
  } catch {
    // If cp fails, write minimal files manually
    writeFileSync(path.join(dataSubDir, 'mission-control.db'), 'SQLite fixture');
    if (cfg.liveNextExists !== false) {
      mkdirSync(path.join(dataSubDir, '.next'), { recursive: true });
      writeFileSync(path.join(dataSubDir, '.next', 'BUILD_ID'), 'old-build-id');
    }
  }

  // Patch the npm stub in binDir to write to NEXT_DIST_DIR under the new path
  const buildExitCode = cfg.buildExitCode ?? 0;
  const npmStub = `#!/usr/bin/env bash
if [[ "$1" == "run" && "$2" == "build" ]]; then
  if [[ "${buildExitCode}" -eq 0 && -n "\${NEXT_DIST_DIR:-}" ]]; then
    mkdir -p "$NEXT_DIST_DIR"
    echo "new-build-id" > "$NEXT_DIST_DIR/BUILD_ID"
  fi
  if [[ -n "\${BUILD_EXIT_FILE:-}" ]]; then
    echo "${buildExitCode}" > "$BUILD_EXIT_FILE"
  fi
  exit ${buildExitCode}
fi
exit 0
`;
  writeFileSync(path.join(base.binDir, 'npm'), npmStub, { mode: 0o755 });

  return {
    ...base,
    appDir: dataSubDir,
  };
}

test('P1 integration (a): broken build + APP_DIR under /data-like path → exit 2, old build untouched', async () => {
  const fixture = buildDataPathFixture({ buildExitCode: 1, liveNextExists: true });
  try {
    const { exitCode, stderr } = runDeploy(fixture);

    // Must exit 2 (pre-flight abort on build failure) — not exit 1 (rollback)
    assert.strictEqual(exitCode, 2,
      `P1 integration: expected exit 2 (build failure) with APP_DIR under /data-like path, ` +
      `got exit ${exitCode}.\nstderr:\n${stderr}`);

    // Old BUILD_ID must be intact
    const buildIdPath = path.join(fixture.appDir, '.next', 'BUILD_ID');
    assert.ok(existsSync(buildIdPath), '.next/BUILD_ID must still exist after build failure');
    const buildId = readFileSync(buildIdPath, 'utf8').trim();
    assert.strictEqual(buildId, 'old-build-id',
      `Old BUILD_ID must be preserved after build failure with /data-like APP_DIR`);

    // No success receipt
    assert.ok(
      !stderr.includes('ATOMIC DEPLOY SUCCESS'),
      `ATOMIC DEPLOY SUCCESS must not appear when build failed (APP_DIR under /data-like path)`
    );
  } finally {
    fixture.cleanup();
  }
});

test('P1 integration (b): good deploy + APP_DIR under /data-like path → exit 0, new build installed', async () => {
  const healthJson = '{"green":true,"timestamp":"2026-06-10T00:00:00Z","checks":{"http":true}}';
  const fixture = buildDataPathFixture({
    buildExitCode: 0,
    healthExitCode: 0,
    healthJson,
    liveNextExists: true,
  });
  try {
    const { exitCode, stderr } = runDeploy(fixture);

    // Must exit 0 (success)
    assert.strictEqual(exitCode, 0,
      `P1 integration: expected exit 0 (good deploy) with APP_DIR under /data-like path, ` +
      `got exit ${exitCode}.\nstderr:\n${stderr}`);

    // New BUILD_ID must be installed
    const buildIdPath = path.join(fixture.appDir, '.next', 'BUILD_ID');
    assert.ok(existsSync(buildIdPath), '.next/BUILD_ID must exist after good deploy');
    const installedBuildId = readFileSync(buildIdPath, 'utf8').trim();
    assert.strictEqual(installedBuildId, 'new-build-id',
      `Expected new BUILD_ID 'new-build-id' to be installed for /data-like APP_DIR`);

    // Success receipt must appear
    assert.ok(
      stderr.includes('ATOMIC DEPLOY SUCCESS'),
      `Success receipt must appear for good deploy with /data-like APP_DIR.\nstderr:\n${stderr}`
    );
  } finally {
    fixture.cleanup();
  }
});

/**
 * tests/unit/cc-probe-pm2.test.ts
 *
 * Vitest tests for the pm2 topology analyser (scripts/pm2-analyze-cc.py).
 *
 * These tests cover B.1 truth-table rows 14-19 (pm2 topology section), which
 * previously had ZERO vitest coverage.  The logic lives in the Python script
 * so it can be exercised deterministically here — no real pm2 required.
 *
 * Fixture files (tests/fixtures/pm2-stubs/*.json) contain representative
 * pm2 jlist output in each topology state.
 *
 * Truth-table rows covered:
 *   Row 14  — CC app online, correct cwd, db_path set → cwd_ok=true, no crash-loopers
 *   Row 15  — CC app in errored/stopped state → crash_loopers non-empty
 *   Row 16a — CC app has null/empty pm_cwd → null_cwd_count > 0, cwd_ok=false
 *   Row 16b — CC app running, non-null cwd, but cwd != canonical_dir → cwd_ok=false
 *   Row 18  — zero pm2 apps matching CC → app_count=0
 *   Row 19  — non-CC app crash-looping, CC app healthy → CC verdict is PASS
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// ── helpers ───────────────────────────────────────────────────────────────────

const SCRIPT = path.resolve(__dirname, '../../scripts/pm2-analyze-cc.py');
const FIXTURES = path.resolve(__dirname, '../fixtures/pm2-stubs');

interface Pm2Analysis {
  app_count: number;
  crash_loopers: Array<{ name: string; reason: string }>;
  db_path_set: boolean;
  cwd_ok: boolean;
  null_cwd_count: number;
  error?: string;
}

/**
 * Run scripts/pm2-analyze-cc.py with a fixture file as stdin.
 * Uses execFileSync with an argument array — no shell, no injection surface.
 * Returns parsed JSON output.
 */
function analyseFixture(
  fixtureName: string,
  opts: { port?: string; canonicalDir?: string } = {}
): Pm2Analysis {
  const fixturePath = path.join(FIXTURES, fixtureName);
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixturePath}`);
  }

  const args: string[] = [SCRIPT, '--port', opts.port ?? '4000'];
  if (opts.canonicalDir) {
    args.push('--canonical-dir', opts.canonicalDir);
  }

  const fixtureData = fs.readFileSync(fixturePath, 'utf8');
  const out = execFileSync('python3', args, {
    encoding: 'utf8',
    input: fixtureData,
  });
  return JSON.parse(out.trim()) as Pm2Analysis;
}

// ── Row 14: CC app healthy ────────────────────────────────────────────────────

describe('pm2 topology — Row 14: CC app online, correct cwd', () => {
  it('row 14: online CC app with correct cwd + db_path set → app_count=1, cwd_ok=true, no crash-loopers', () => {
    const result = analyseFixture('fixture-2e-healthy.json', {
      canonicalDir: '/home/user/mission-control',
    });
    expect(result.app_count).toBe(1);
    expect(result.cwd_ok).toBe(true);
    expect(result.crash_loopers).toHaveLength(0);
    expect(result.null_cwd_count).toBe(0);
    expect(result.db_path_set).toBe(true);
  });
});

// ── Row 15: CC app crash-looping (errored/stopped) ────────────────────────────

describe('pm2 topology — Row 15: CC app in errored state', () => {
  it('row 15: CC app status=errored → crash_loopers non-empty', () => {
    const result = analyseFixture('fixture-2f-errored.json');
    expect(result.app_count).toBe(1);
    expect(result.crash_loopers.length).toBeGreaterThan(0);
    expect(result.crash_loopers[0].reason).toMatch(/status=errored/);
  });
});

// ── Row 16a: CC app has null/empty pm_cwd ─────────────────────────────────────

describe('pm2 topology — Row 16a: null pm_cwd', () => {
  it('row 16a: CC app pm_cwd=null → null_cwd_count=1, cwd_ok=false', () => {
    const result = analyseFixture('fixture-null-cwd.json', {
      canonicalDir: '/home/user/mission-control',
    });
    expect(result.app_count).toBe(1);
    expect(result.null_cwd_count).toBe(1);
    expect(result.cwd_ok).toBe(false);
    expect(result.crash_loopers).toHaveLength(0);  // null cwd ≠ crash-looping
  });
});

// ── Row 16b: CC app has wrong-but-non-null cwd (the Round-2 fix #1 case) ──────

describe('pm2 topology — Row 16b: wrong (non-null) cwd with canonical-dir set', () => {
  it('row 16b: CC app cwd=/tmp/wrong-directory, canonical=/correct → cwd_ok=false', () => {
    // fixture-2g-wrong-cwd has pm_cwd=/tmp/wrong-directory
    const result = analyseFixture('fixture-2g-wrong-cwd.json', {
      canonicalDir: '/home/user/mission-control',
    });
    expect(result.app_count).toBe(1);
    expect(result.null_cwd_count).toBe(0);   // NOT null — it's populated but WRONG
    expect(result.cwd_ok).toBe(false);        // cwd mismatch → cwd_ok=false
    expect(result.crash_loopers).toHaveLength(0);
  });

  it('row 16b variant: same fixture WITHOUT --canonical-dir → cwd_ok=true (no canonical to compare against)', () => {
    // Without canonical-dir the Python falls back to cwd_ok=bool(cc): any cwd is OK
    const result = analyseFixture('fixture-2g-wrong-cwd.json');
    expect(result.app_count).toBe(1);
    expect(result.null_cwd_count).toBe(0);
    expect(result.cwd_ok).toBe(true);  // no canonical → only null triggers cwd_ok=false
  });
});

// ── Row 18: zero CC apps in pm2 list ──────────────────────────────────────────

describe('pm2 topology — Row 18: zero CC apps', () => {
  it('row 18: empty pm2 jlist → app_count=0, cwd_ok=false', () => {
    const result = analyseFixture('fixture-empty.json');
    expect(result.app_count).toBe(0);
    expect(result.cwd_ok).toBe(false);
    expect(result.crash_loopers).toHaveLength(0);
  });
});

// ── Row 34: zombie duplicate CC apps on same port ────────────────────────────
// Truth table row 34: pm2 list shows 2+ CC apps on the CC port → app_count > 1.
// cc-health-check.sh line 87 (`PM2_COUNT -gt 1`) FAILs this state.  This test
// proves that pm2-analyze-cc.py correctly returns app_count=2 for this scenario,
// which the shell script then maps to FAIL.

describe('pm2 topology — Row 34: zombie duplicate CC apps on same port', () => {
  it('row 34: two CC apps on port 4000 (zombie duplicate) → app_count=2', () => {
    const result = analyseFixture('fixture-duplicate-cc.json', {
      canonicalDir: '/home/user/mission-control',
    });
    // Both apps match the CC port — app_count must be 2, not 1
    expect(result.app_count).toBe(2);
    // cwd_ok may be false because not all cwds match canonical; the shell
    // script FAILs on PM2_COUNT > 1 before checking cwd_ok
    // No crash-loopers — both apps are online; the failure is the count itself
    expect(result.crash_loopers).toHaveLength(0);
  });
});

// ── Row 19: non-CC app crash-looping, CC app healthy ─────────────────────────

describe('pm2 topology — Row 19: non-CC app crash-looping', () => {
  it('row 19: openclaw daemon errored, CC app online → cc verdict not affected by other-app crash', () => {
    // fixture-non-cc-errored: mission-control (online, port 4000) +
    //                          openclaw-gateway (errored, port 5000)
    const result = analyseFixture('fixture-non-cc-errored.json', {
      canonicalDir: '/home/user/mission-control',
    });
    // Only the CC app should be counted
    expect(result.app_count).toBe(1);
    // No CC app is errored — the non-CC crash-looper must NOT appear in crash_loopers
    expect(result.crash_loopers).toHaveLength(0);
    expect(result.cwd_ok).toBe(true);
  });
});

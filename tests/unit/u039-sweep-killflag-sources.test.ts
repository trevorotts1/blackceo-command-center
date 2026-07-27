/**
 * u039-sweep-killflag-sources.test.ts — U039 REGRESSION SUITE.
 *
 * THE DEFECT
 * ----------
 * The boot banner announces only one of the two rescue sweeps. The
 * stuck-in-progress-sweep can be switched off with no signal at all — the
 * exact failure mode the F6 banner was built to end for the stale sweep.
 *
 * WHAT THIS SUITE PINS
 * --------------------
 *  1. resolveEnvOnlyStuckSweepKillFlag() is env-only — never consults the
 *     durable file. Only '1' and 'true' are truthy (copied from the sweep),
 *     so a banner that disagrees with the sweep code is impossible.
 *  2. The durable file CANNOT disable the stuck sweep (NOT in HONORED_FLAGS).
 *  3. logKillFlagBanner() announces BOTH sweeps in all four flag states.
 *  4. The historical stale-sweep strings from F6 are unchanged.
 *  5. scripts/operator-flag.sh still refuses the stuck flag (exit 2).
 *  6. scripts/sweep-kill-flag-report.sh exits 0, prints SUMMARY, leaks no value.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OPERATOR_FLAG_SH = path.join(process.cwd(), 'scripts', 'operator-flag.sh');
const REPORT_SH = path.join(process.cwd(), 'scripts', 'sweep-kill-flag-report.sh');

// ── helpers ───────────────────────────────────────────────────────────────────

/** Save the original env values we will mutate, and restore them after each test. */
function saveEnv(): Record<string, string | undefined> {
  return {
    DISABLE_STALE_TASK_SWEEP: process.env.DISABLE_STALE_TASK_SWEEP,
    DISABLE_STUCK_IN_PROGRESS_SWEEP: process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP,
    CC_OPERATOR_OVERRIDES_FILE: process.env.CC_OPERATOR_OVERRIDES_FILE,
    HOME: process.env.HOME,
  };
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function makeScratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'u039-'));
}

// ── 1. resolveEnvOnlyStuckSweepKillFlag() truth table ──────────────────────────

describe('U039.1 — resolveEnvOnlyStuckSweepKillFlag truth table', () => {
  it('unset → disabled=false, sources=[], overrideFile=null', async () => {
    const saved = saveEnv();
    delete process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP;
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const r = mod.resolveEnvOnlyStuckSweepKillFlag();
    expect(r.disabled).toBe(false);
    expect(r.sources).toEqual([]);
    expect(r.overrideFile).toBeNull();
    expect(r.fileError).toBeNull();
    expect(r.name).toBe('DISABLE_STUCK_IN_PROGRESS_SWEEP');

    restoreEnv(saved);
  });

  it("= '1' → disabled=true, sources=['env']", async () => {
    const saved = saveEnv();
    process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP = '1';
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const r = mod.resolveEnvOnlyStuckSweepKillFlag();
    expect(r.disabled).toBe(true);
    expect(r.sources).toEqual(['env']);

    restoreEnv(saved);
  });

  it("= 'true' → disabled=true", async () => {
    const saved = saveEnv();
    process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP = 'true';
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const r = mod.resolveEnvOnlyStuckSweepKillFlag();
    expect(r.disabled).toBe(true);
    expect(r.sources).toEqual(['env']);

    restoreEnv(saved);
  });

  it("= 'yes' → disabled=false (matches stuck-in-progress-sweep.ts, NOT isTruthyFlagValue)", async () => {
    const saved = saveEnv();
    process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP = 'yes';
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const r = mod.resolveEnvOnlyStuckSweepKillFlag();
    expect(r.disabled).toBe(false);
    expect(r.sources).toEqual([]);

    restoreEnv(saved);
  });

  it("= 'on' → disabled=false", async () => {
    const saved = saveEnv();
    process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP = 'on';
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const r = mod.resolveEnvOnlyStuckSweepKillFlag();
    expect(r.disabled).toBe(false);

    restoreEnv(saved);
  });

  it("= 'TRUE' (uppercase) → disabled=false", async () => {
    const saved = saveEnv();
    process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP = 'TRUE';
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const r = mod.resolveEnvOnlyStuckSweepKillFlag();
    expect(r.disabled).toBe(false);

    restoreEnv(saved);
  });

  it("= ' 1' (leading space) → disabled=false", async () => {
    const saved = saveEnv();
    process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP = ' 1';
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const r = mod.resolveEnvOnlyStuckSweepKillFlag();
    expect(r.disabled).toBe(false);

    restoreEnv(saved);
  });
});

// ── 2. The durable file CANNOT disable the stuck sweep ─────────────────────────

describe('U039.2 — durable file cannot disable stuck sweep', () => {
  it('DISABLE_STUCK_IN_PROGRESS_SWEEP=1 in durable file → resolveEnvOnlyStuckSweepKillFlag still disabled=false', async () => {
    const saved = saveEnv();
    delete process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP;
    delete process.env.DISABLE_STALE_TASK_SWEEP;

    const boxDir = makeScratchDir();
    const homeDir = path.join(boxDir, '.blackceo', 'command-center');
    fs.mkdirSync(homeDir, { recursive: true });
    const durableFile = path.join(homeDir, 'operator-overrides.env');
    fs.writeFileSync(durableFile, 'DISABLE_STUCK_IN_PROGRESS_SWEEP=1\n', 'utf-8');

    process.env.CC_OPERATOR_OVERRIDES_FILE = durableFile;
    process.env.HOME = boxDir;

    const mod = await import('../../src/lib/ops/operator-kill-flags');

    const r = mod.resolveEnvOnlyStuckSweepKillFlag();
    expect(r.disabled).toBe(false);

    const f = mod.readOperatorOverrides();
    expect(f.ignoredKeys).toContain('DISABLE_STUCK_IN_PROGRESS_SWEEP');
    expect(Object.prototype.hasOwnProperty.call(f.values, 'DISABLE_STUCK_IN_PROGRESS_SWEEP')).toBe(false);

    fs.rmSync(boxDir, { recursive: true, force: true });
    restoreEnv(saved);
  });
});

// ── 3. logKillFlagBanner() announces BOTH sweeps in all four states ────────────

describe('U039.3 — banner announces both sweeps', () => {
  it('neither flag set → both ENABLED', async () => {
    const saved = saveEnv();
    delete process.env.DISABLE_STALE_TASK_SWEEP;
    delete process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP;
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const lines: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));

    mod.logKillFlagBanner();

    console.log = origLog;
    console.warn = origWarn;

    const staleLines = lines.filter(s => /stale-task-sweep is (ENABLED|DISABLED)/.test(s));
    const stuckLines = lines.filter(s => /stuck-in-progress-sweep is (ENABLED|DISABLED)/.test(s));

    expect(staleLines.length).toBe(1);
    expect(stuckLines.length).toBe(1);
    expect(staleLines[0]).toMatch(/ENABLED/);
    expect(stuckLines[0]).toMatch(/ENABLED/);

    restoreEnv(saved);
  });

  it('only stale set → stale DISABLED, stuck ENABLED', async () => {
    const saved = saveEnv();
    process.env.DISABLE_STALE_TASK_SWEEP = '1';
    delete process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP;
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const lines: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));

    mod.logKillFlagBanner();

    console.log = origLog;
    console.warn = origWarn;

    const staleLines = lines.filter(s => /stale-task-sweep is (ENABLED|DISABLED)/.test(s));
    const stuckLines = lines.filter(s => /stuck-in-progress-sweep is (ENABLED|DISABLED)/.test(s));

    expect(staleLines.length).toBe(1);
    expect(stuckLines.length).toBe(1);
    expect(staleLines[0]).toMatch(/DISABLED/);
    expect(stuckLines[0]).toMatch(/ENABLED/);

    restoreEnv(saved);
  });

  it('only stuck set → stale ENABLED, stuck DISABLED', async () => {
    const saved = saveEnv();
    delete process.env.DISABLE_STALE_TASK_SWEEP;
    process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP = '1';
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const lines: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));

    mod.logKillFlagBanner();

    console.log = origLog;
    console.warn = origWarn;

    const staleLines = lines.filter(s => /stale-task-sweep is (ENABLED|DISABLED)/.test(s));
    const stuckLines = lines.filter(s => /stuck-in-progress-sweep is (ENABLED|DISABLED)/.test(s));

    expect(staleLines.length).toBe(1);
    expect(stuckLines.length).toBe(1);
    expect(staleLines[0]).toMatch(/ENABLED/);
    expect(stuckLines[0]).toMatch(/DISABLED/);

    restoreEnv(saved);
  });

  it('both flags set → both DISABLED', async () => {
    const saved = saveEnv();
    process.env.DISABLE_STALE_TASK_SWEEP = '1';
    process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP = '1';
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const lines: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));

    mod.logKillFlagBanner();

    console.log = origLog;
    console.warn = origWarn;

    const staleLines = lines.filter(s => /stale-task-sweep is (ENABLED|DISABLED)/.test(s));
    const stuckLines = lines.filter(s => /stuck-in-progress-sweep is (ENABLED|DISABLED)/.test(s));

    expect(staleLines.length).toBe(1);
    expect(stuckLines.length).toBe(1);
    expect(staleLines[0]).toMatch(/DISABLED/);
    expect(stuckLines[0]).toMatch(/DISABLED/);

    restoreEnv(saved);
  });
});

// ── 4. Historical F6 strings are unchanged ─────────────────────────────────────

describe('U039.4 — historical F6 strings preserved', () => {
  it('killFlagSkipReason returns "DISABLE_STALE_TASK_SWEEP set (source: …)"', async () => {
    const saved = saveEnv();
    process.env.DISABLE_STALE_TASK_SWEEP = '1';
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    const r = mod.resolveStaleTaskSweepKillFlag();
    const reason = mod.killFlagSkipReason(r);

    expect(reason).toMatch(/DISABLE_STALE_TASK_SWEEP set/);
    expect(reason).toMatch(/source: env/);

    restoreEnv(saved);
  });
});

// ── 5. operator-flag.sh still refuses the stuck flag ───────────────────────────

describe('U039.5 — operator-flag.sh refuses stuck flag', () => {
  it('set DISABLE_STUCK_IN_PROGRESS_SWEEP → exit 2', () => {
    const saved = saveEnv();
    const boxDir = makeScratchDir();
    const durableFile = path.join(boxDir, 'overrides.env');

    let exitCode = 0;
    let stderr = '';
    try {
      execFileSync('bash', [OPERATOR_FLAG_SH, 'set', 'DISABLE_STUCK_IN_PROGRESS_SWEEP', '1'], {
        env: { ...process.env, CC_OPERATOR_OVERRIDES_FILE: durableFile, HOME: boxDir },
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string; message?: string };
      exitCode = e.status ?? 0;
      stderr = (e.stderr || e.message || '');
    }

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/is not a flag this app honours/);

    fs.rmSync(boxDir, { recursive: true, force: true });
    restoreEnv(saved);
  });
});

// ── 6. sweep-kill-flag-report.sh runs, exits 0, prints SUMMARY, leaks no value ──

describe('U039.6 — report script smoke test', () => {
  it('exits 0 and prints SUMMARY line', () => {
    const saved = saveEnv();
    const boxDir = makeScratchDir();
    fs.writeFileSync(path.join(boxDir, '.env.local'), 'DISABLE_STALE_TASK_SWEEP=sentinel-value-do-not-print\n', 'utf-8');

    const env: Record<string, string | undefined> = { ...process.env, CC_OPERATOR_OVERRIDES_FILE: '' };
    delete env.DISABLE_STALE_TASK_SWEEP;
    delete env.DISABLE_STUCK_IN_PROGRESS_SWEEP;

    const out = execFileSync('bash', [REPORT_SH, '--root', boxDir], { env: env as Record<string, string>, encoding: 'utf-8', timeout: 30000 });

    expect(out).toMatch(/SUMMARY: stale=/);
    expect(out).toMatch(/stuck=/);
    expect(out.includes('sentinel-value-do-not-print')).toBe(false);

    fs.rmSync(boxDir, { recursive: true, force: true });
    restoreEnv(saved);
  });

  it('exits with code 0', () => {
    const saved = saveEnv();
    const boxDir = makeScratchDir();

    const env: Record<string, string | undefined> = { ...process.env, CC_OPERATOR_OVERRIDES_FILE: '' };
    delete env.DISABLE_STALE_TASK_SWEEP;
    delete env.DISABLE_STUCK_IN_PROGRESS_SWEEP;

    execFileSync('bash', [REPORT_SH, '--root', boxDir], { env: env as Record<string, string>, encoding: 'utf-8', timeout: 30000 });

    fs.rmSync(boxDir, { recursive: true, force: true });
    restoreEnv(saved);
  });

  it('reports .env.local.bak-* as HAZARD', () => {
    const saved = saveEnv();
    const boxDir = makeScratchDir();
    fs.writeFileSync(path.join(boxDir, '.env.local.bak-2025'), 'DISABLE_STALE_TASK_SWEEP=1\n', 'utf-8');
    fs.writeFileSync(path.join(boxDir, '.env.local.bak-2026'), 'OTHER_KEY=value\n', 'utf-8');

    const env: Record<string, string | undefined> = { ...process.env, CC_OPERATOR_OVERRIDES_FILE: '' };
    delete env.DISABLE_STALE_TASK_SWEEP;
    delete env.DISABLE_STUCK_IN_PROGRESS_SWEEP;

    const out = execFileSync('bash', [REPORT_SH, '--root', boxDir], { env: env as Record<string, string>, encoding: 'utf-8', timeout: 30000 });

    expect(out).toMatch(/HAZARD:.*\.env\.local\.bak-2025/);
    expect(out).toMatch(/HAZARD:.*\.env\.local\.bak-2026/);

    fs.rmSync(boxDir, { recursive: true, force: true });
    restoreEnv(saved);
  });
});

// ── 7. HONORED_FLAGS still has exactly ONE element ─────────────────────────────

describe('U039.7 — HONORED_FLAGS invariant', () => {
  it('length === 1 and stuck is NOT in it', async () => {
    const saved = saveEnv();
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    expect(mod.HONORED_FLAGS.length).toBe(1);
    expect(mod.HONORED_FLAGS[0]).toBe('DISABLE_STALE_TASK_SWEEP');
    expect((mod.HONORED_FLAGS as readonly string[]).includes('DISABLE_STUCK_IN_PROGRESS_SWEEP')).toBe(false);

    restoreEnv(saved);
  });
});

// ── 8. STUCK_IN_PROGRESS_SWEEP_KILL_FLAG constant exists ───────────────────────

describe('U039.8 — constant exists', () => {
  it('STUCK_IN_PROGRESS_SWEEP_KILL_FLAG === "DISABLE_STUCK_IN_PROGRESS_SWEEP"', async () => {
    const saved = saveEnv();
    process.env.CC_OPERATOR_OVERRIDES_FILE = '';

    const mod = await import('../../src/lib/ops/operator-kill-flags');
    expect(mod.STUCK_IN_PROGRESS_SWEEP_KILL_FLAG).toBe('DISABLE_STUCK_IN_PROGRESS_SWEEP');

    restoreEnv(saved);
  });
});

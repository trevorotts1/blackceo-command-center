/**
 * CLI probe — verifies that every CLI registered in cli_install_registry can
 * still be invoked. Runs `<binary> --version` for each entry with a per-CLI
 * timeout. Aggregation:
 *   - every CLI exits 0           -> live
 *   - some succeed, some fail     -> degraded
 *   - every CLI fails (or empty)  -> offline
 *
 * Per-CLI breakdown lands in the details string so the System Status Panel
 * can show the operator which binary went sideways.
 */

import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '@/lib/db';
import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

interface RegistryRow {
  cli_name: string;
  binary_path: string | null;
  version: string | null;
  last_verified_at: string | null;
}

interface PerCliResult {
  name: string;
  binaryPath: string | null;
  ok: boolean;
  exitCode: number | null;
  error?: string;
  durationMs: number;
}

const PER_CLI_TIMEOUT_MS = 2000;

/**
 * QR-008: the login-shell PATH, harvested ONCE per process by asking the
 * user's own interactive login shell to print $PATH. The static directory list
 * alone was the reviewed defect: a CLI living anywhere else on the login PATH
 * (~/bin, ~/.bun/bin, /opt/pmk/env/global/bin, …) was reported absent, because
 * a probe inside a pm2/Next process never sees the operator's PATH — pm2
 * pins a minimal one (see ecosystem.cc-prod.config.cjs).
 *
 * Cached because resolveCliBinary is called once per registered CLI; spawning
 * a shell per call would put ~20 redundant forks inside a 3s probe budget.
 * The cache is a Map so a failed harvest (shell missing, spawn error) memoizes
 * the empty result rather than re-spawning for every remaining CLI.
 *
 * This is the ONLY place a shell is ever spawned here, it takes no arguments,
 * and its output is treated purely as a list of directory strings — the
 * caller's `spawn` of the resolved binary remains argument-static.
 */
const loginPathDirs = (() => {
  let cached: string[] | null = null;
  return (): string[] => {
    if (cached) return cached;
    cached = [];
    const shell = process.env.SHELL || '/bin/sh';
    try {
      // -lic: interactive+login, so the user's rc files (which is where the
      // PATH exports live) are sourced exactly as they are at a real prompt.
      // 1000ms: the measured interactive shell on this box answers in ~90ms,
      // so this is a 10x ceiling. It has to stay well under PROBE_TIMEOUT_MS
      // (3000): the harvest is blocking-synchronous and runs inside the probe,
      // and a shell that hangs must not eat the budget the CLIs need.
      const out = execFileSync(shell, ['-lic', 'printf %s "$PATH"'], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // QR-012: rc banners precede the PATH, so take the last line.
      cached = out
        .trim()
        .split(/\r?\n/)
        .pop()!
        .split(path.delimiter)
        .filter((dir) => dir.length > 0 && path.isAbsolute(dir));
    } catch {
      // No usable shell / it hung: the fixed list still works, so this stays a
      // silently degraded lookup rather than a probe failure.
    }
    return cached;
  };
})();

/**
 * HEA-001: PATH fallback for a registered binary. The registry stores the
 * absolute path captured at install time (`/opt/homebrew/bin/claude`); when
 * the entry's stored path is missing, stale, or not executable (reinstall to
 * a new prefix, `~/.local/bin` vs brew drift), we retry by bare name before
 * calling it a failure.
 * QR-002: that lookup must cover the npm global prefix too — `pm2` (and other
 * `npm install -g` tools) live in `~/.npm-global/bin` on this box, so a tool
 * that was both installed and running was reported absent.
 * QR-008: the lookup now walks the REAL PATH, not only a frozen list. Search
 * order is: the four fixed directories FIRST (so every QR-002 verdict is
 * byte-identical to before — `pm2` still resolves to `~/.npm-global/bin/pm2`
 * even if some other directory on PATH also holds a `pm2`), then process.env.PATH,
 * then the login shell's PATH. Adds directories only; removes none, and no
 * candidate that resolved before resolves differently now.
 *
 * A registered path that still EXISTS is returned verbatim before any of this
 * runs — a stale registration is never silently swapped for a same-named
 * binary found elsewhere, because that substitution would need evidence this
 * function does not have. Returns the resolved path, or null when the binary
 * is genuinely absent. Every candidate is checked statically with
 * `fs.accessSync(..., X_OK)`. Exported for tests.
 */
export function resolveCliBinary(
  binaryPath: string | null,
  cliName: string
): string | null {
  if (binaryPath) {
    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
      return binaryPath;
    } catch {
      // Stored path stale — fall through to PATH lookup.
    }
  }
  const home = os.homedir();
  const bare = binaryPath ? path.basename(binaryPath) : cliName;

  const dirs: string[] = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    // Last of the fixed four: strictly additive. A tool found in one of the
    // three directories above resolves exactly as it did before, so this
    // cannot change an existing verdict; it only rescues `npm install -g`
    // tools (pm2 and friends) that live nowhere else.
    path.join(home, '.npm-global', 'bin'),
    // QR-008: then the PATHs the process actually has — the inherited env
    // first (a caller may pass a richer one), then the login shell's.
    ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
    ...loginPathDirs(),
  ];

  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);

    // Skip directory entries that are not absolute — a relative PATH entry
    // would resolve against the server's cwd and turn this into a different
    // question ("what is in my cwd") than the one being asked.
    const candidate = path.isAbsolute(dir) ? path.join(dir, bare) : null;
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here — keep looking.
    }
  }
  return null;
}

async function runVersion(name: string, binaryPath: string | null): Promise<PerCliResult> {
  const started = Date.now();
  const resolved = resolveCliBinary(binaryPath, name);
  if (!resolved) {
    return {
      name,
      binaryPath,
      ok: false,
      exitCode: null,
      error: binaryPath
        ? `registered path missing and ${path.basename(binaryPath)} not found on PATH`
        : 'no binary path registered',
      durationMs: 0,
    };
  }

  return new Promise<PerCliResult>((resolve) => {
    let settled = false;
    const child = spawn(resolved, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve({
        name,
        binaryPath,
        ok: false,
        exitCode: null,
        error: 'timed out after 2s',
        durationMs: Date.now() - started,
      });
    }, PER_CLI_TIMEOUT_MS);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name,
        binaryPath,
        ok: false,
        exitCode: null,
        error: err.message,
        durationMs: Date.now() - started,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name,
        binaryPath,
        ok: code === 0,
        exitCode: code,
        error: code === 0 ? undefined : `exit ${code}`,
        durationMs: Date.now() - started,
      });
    });
  });
}

export async function probeCli(): Promise<ProbeResult> {
  const start = Date.now();

  return withTimeout<ProbeResult>(
    async () => {
      let rows: RegistryRow[] = [];
      try {
        const db = getDb();
        rows = db
          .prepare(
            `SELECT cli_name, binary_path, version, last_verified_at
             FROM cli_install_registry`
          )
          .all() as RegistryRow[];
      } catch (err) {
        return offline(
          start,
          `cli_install_registry read failed, ${err instanceof Error ? err.message : String(err)}`,
          []
        );
      }

      if (rows.length === 0) {
        // HEA-001: empty registry is an INSTALLATION fault (nothing ever
        // seeded this box — bootstrap/repair never wrote here), not a
        // repository defect. Report `unknown` (never `offline`): the probe
        // cannot distinguish "box has no CLIs" from "registry write never
        // ran", so it must not certify either. `detail.next` names the heal.
        return {
          component: 'cli',
          label: 'Operator CLIs',
          status: 'unknown',
          latencyMs: Date.now() - start,
          error: 'no CLIs registered in cli_install_registry (registry never seeded on this box)',
          detail: {
            registered: 0,
            breakdown: [],
            cause: 'installation-fault',
            next: 'cli_install_registry has no in-repo seeder — scripts/install/mac-mini-bootstrap.sh installs the CLIs but never writes this table, and repair-command-center.sh only seeds SOPs; seed the registry explicitly before this probe can report CLI health',
          },
          probedAt: new Date().toISOString(),
        };
      }

      const results = await Promise.all(
        rows.map((r) => runVersion(r.cli_name, r.binary_path))
      );

      const okCount = results.filter((r) => r.ok).length;
      const total = results.length;

      const status =
        okCount === total
          ? ('live' as const)
          : okCount === 0
            ? ('offline' as const)
            : ('degraded' as const);

      const breakdownLines = results.map((r) =>
        r.ok ? `${r.name} ok` : `${r.name} fail (${r.error || 'unknown'})`
      );
      const details = `${okCount}/${total} CLIs healthy. ${breakdownLines.join(', ')}`;

      return {
        component: 'cli',
        label: 'Operator CLIs',
        status,
        latencyMs: Date.now() - start,
        error: status === 'live' ? undefined : details,
        detail: {
          registered: total,
          healthy: okCount,
          breakdown: results.map((r) => ({
            name: r.name,
            binaryPath: r.binaryPath,
            ok: r.ok,
            exitCode: r.exitCode,
            error: r.error,
            durationMs: r.durationMs,
          })),
          summary: details,
        },
        probedAt: new Date().toISOString(),
      };
    },
    PROBE_TIMEOUT_MS,
    () => offline(start, 'probe timed out', [])
  );
}

function offline(
  start: number,
  message: string,
  breakdown: PerCliResult[]
): ProbeResult {
  return {
    component: 'cli',
    label: 'Operator CLIs',
    status: 'offline',
    latencyMs: Date.now() - start,
    error: message,
    detail: { breakdown },
    probedAt: new Date().toISOString(),
  };
}

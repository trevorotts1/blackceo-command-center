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

import { spawn } from 'child_process';
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

async function runVersion(name: string, binaryPath: string | null): Promise<PerCliResult> {
  const started = Date.now();
  if (!binaryPath) {
    return {
      name,
      binaryPath: null,
      ok: false,
      exitCode: null,
      error: 'no binary path registered',
      durationMs: 0,
    };
  }

  return new Promise<PerCliResult>((resolve) => {
    let settled = false;
    const child = spawn(binaryPath, ['--version'], {
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
        return {
          component: 'cli',
          label: 'Operator CLIs',
          status: 'offline',
          latencyMs: Date.now() - start,
          error: 'no CLIs registered in cli_install_registry',
          detail: { registered: 0, breakdown: [] },
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

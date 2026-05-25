/**
 * Cloudflare Tunnel probe — verifies the `cloudflared` process is up so the
 * Mac Mini or VPS Docker container can keep serving Cloudflare Access traffic.
 *
 * Mac Mini      : `pm2 jlist`, look for a `cloudflared` entry with
 *                 `pm2_env.status === 'online'`.
 * VPS Docker    : `systemctl status cloudflared` (exit 0 = live). If
 *                 systemctl is not available we fall back to `pm2 jlist`
 *                 inside the container.
 *
 * Implementation note, we use execFile (not exec) so no shell is spawned. All
 * arguments are static, but execFile is the right primitive regardless.
 */

import { execFile } from 'child_process';
import { detectPlatform } from '@/lib/platform';
import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

const EXEC_TIMEOUT_MS = 2500;

function runFile(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const codeRaw = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          const exitCode = typeof codeRaw === 'number' ? codeRaw : null;
          resolve({
            stdout: stdout?.toString() || '',
            stderr: stderr?.toString() || '',
            exitCode,
            error: err.message,
          });
          return;
        }
        resolve({
          stdout: stdout?.toString() || '',
          stderr: stderr?.toString() || '',
          exitCode: 0,
        });
      }
    );
  });
}

interface PmEntry {
  name?: string;
  pm2_env?: { status?: string };
}

function parsePm2Cloudflared(stdout: string): { found: boolean; online: boolean; raw: PmEntry | null } {
  try {
    const trimmed = stdout.trim();
    if (!trimmed) return { found: false, online: false, raw: null };
    const parsed = JSON.parse(trimmed) as PmEntry[];
    if (!Array.isArray(parsed)) return { found: false, online: false, raw: null };
    const entry = parsed.find(
      (e) => typeof e.name === 'string' && e.name.toLowerCase().includes('cloudflared')
    );
    if (!entry) return { found: false, online: false, raw: null };
    return {
      found: true,
      online: entry.pm2_env?.status === 'online',
      raw: entry,
    };
  } catch {
    return { found: false, online: false, raw: null };
  }
}

async function probeMacMini(): Promise<{ status: 'live' | 'degraded' | 'offline'; details: string; detail: Record<string, unknown> }> {
  const outcome = await runFile('pm2', ['jlist'], EXEC_TIMEOUT_MS);
  if (outcome.exitCode !== 0) {
    return {
      status: 'offline',
      details: `pm2 jlist failed, ${outcome.error || outcome.stderr || 'no output'}`,
      detail: { exitCode: outcome.exitCode, stderr: outcome.stderr },
    };
  }
  const parsed = parsePm2Cloudflared(outcome.stdout);
  if (!parsed.found) {
    return {
      status: 'offline',
      details: 'cloudflared not registered with PM2',
      detail: { found: false },
    };
  }
  if (!parsed.online) {
    return {
      status: 'degraded',
      details: `cloudflared PM2 status is ${parsed.raw?.pm2_env?.status || 'unknown'}, expected online`,
      detail: { found: true, online: false, pm2Status: parsed.raw?.pm2_env?.status },
    };
  }
  return {
    status: 'live',
    details: 'cloudflared online under PM2',
    detail: { found: true, online: true, pm2Status: 'online' },
  };
}

async function probeVpsDocker(): Promise<{ status: 'live' | 'degraded' | 'offline'; details: string; detail: Record<string, unknown> }> {
  const sys = await runFile('systemctl', ['status', 'cloudflared'], EXEC_TIMEOUT_MS);
  if (sys.exitCode === 0) {
    return {
      status: 'live',
      details: 'cloudflared active under systemd',
      detail: { source: 'systemctl', exitCode: 0 },
    };
  }

  const pm = await runFile('pm2', ['jlist'], EXEC_TIMEOUT_MS);
  if (pm.exitCode === 0) {
    const parsed = parsePm2Cloudflared(pm.stdout);
    if (parsed.found && parsed.online) {
      return {
        status: 'live',
        details: 'cloudflared online under PM2 in container',
        detail: { source: 'pm2', online: true },
      };
    }
    if (parsed.found && !parsed.online) {
      return {
        status: 'degraded',
        details: `cloudflared PM2 status is ${parsed.raw?.pm2_env?.status || 'unknown'}, expected online`,
        detail: { source: 'pm2', online: false, pm2Status: parsed.raw?.pm2_env?.status },
      };
    }
  }

  return {
    status: 'offline',
    details: 'neither systemctl nor pm2 reported cloudflared running',
    detail: {
      systemctlExit: sys.exitCode,
      systemctlError: sys.error,
      pm2Exit: pm.exitCode,
      pm2Error: pm.error,
    },
  };
}

export async function probeCloudflareTunnel(): Promise<ProbeResult> {
  const start = Date.now();
  const platform = detectPlatform();

  return withTimeout<ProbeResult>(
    async () => {
      const result =
        platform === 'vps-docker' ? await probeVpsDocker() : await probeMacMini();

      return {
        component: 'cloudflare_tunnel',
        label: 'Cloudflare Tunnel',
        status: result.status,
        latencyMs: Date.now() - start,
        error: result.status === 'live' ? undefined : result.details,
        detail: { platform, summary: result.details, ...result.detail },
        probedAt: new Date().toISOString(),
      };
    },
    PROBE_TIMEOUT_MS,
    () => ({
      component: 'cloudflare_tunnel',
      label: 'Cloudflare Tunnel',
      status: 'offline',
      latencyMs: Date.now() - start,
      error: 'probe timed out',
      detail: { platform },
      probedAt: new Date().toISOString(),
    })
  );
}

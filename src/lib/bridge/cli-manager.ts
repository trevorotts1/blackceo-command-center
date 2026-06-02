/**
 * Per-client CLI manager (E16).
 *
 * Detects the operator-level agent CLIs — Claude Code, Codex, Antigravity,
 * Hermes, Gemini, and OpenClaw — on the SELECTED client's box, CAPTURING THE
 * VERSION of each, and offers "install if missing" and "auto-update" actions.
 *
 * Where the box lives:
 *   - self  → run the binary locally with `execFile` (no shell).
 *   - remote → run over the Cloudflare Access SSH tunnel via `runClientSsh`,
 *     wrapped in a login shell so brew/npm-installed binaries are on PATH.
 *
 * This is the client-aware counterpart to `src/lib/probes/cli-probe.ts` (which
 * verifies the command center's OWN registered CLIs). It does NOT touch that
 * registry; it queries the SELECTED client tenant directly so the Bridge can
 * show, per client, which agents are installed and at what version, and let the
 * operator install/update a missing or stale one.
 *
 * Every path fails soft: a down tunnel, a missing ssh_target, or a non-zero
 * exit returns a structured `{ installed:false, ... }` row plus a reason. We
 * never throw into the Bridge UI.
 */

import { execFile } from 'child_process';
import {
  getClientContext,
  type Client,
} from '@/lib/clients';
import { runClientSsh } from '@/lib/operator/client-fs';

/** The CLIs E16 manages, with their binary name and how to install/update them. */
export interface ManagedCli {
  id: string;
  label: string;
  /** Binary invoked for detection + `--version`. */
  bin: string;
  /** Args that print a version (most accept `--version`). */
  versionArgs: string[];
  /**
   * Install command run on the target box (login shell). Kept declarative so the
   * UI can show it before running. `null` for CLIs with no scripted installer
   * (the operator installs them manually — we still detect + report).
   */
  install: string | null;
  /** Update command run on the target box. Falls back to `install` when null. */
  update: string | null;
}

/**
 * Source of truth for the six agents E16 covers. Bins mirror
 * `BRIDGE_AGENTS` in `./agents.ts`; install/update reflect each tool's
 * published install path. OpenClaw is included because the brief lists it.
 */
export const MANAGED_CLIS: readonly ManagedCli[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    versionArgs: ['--version'],
    install: 'npm install -g @anthropic-ai/claude-code',
    update: 'npm install -g @anthropic-ai/claude-code@latest',
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    versionArgs: ['--version'],
    install: 'npm install -g @openai/codex',
    update: 'npm install -g @openai/codex@latest',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    bin: 'agy',
    versionArgs: ['--version'],
    install: null,
    update: null,
  },
  {
    id: 'hermes',
    label: 'Hermes',
    bin: 'hermes',
    versionArgs: ['--version'],
    install: null,
    update: null,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    bin: 'gemini',
    versionArgs: ['--version'],
    install: 'npm install -g @google/gemini-cli',
    update: 'npm install -g @google/gemini-cli@latest',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    bin: 'openclaw',
    versionArgs: ['--version'],
    install: 'npm install -g openclaw',
    update: 'openclaw update',
  },
] as const;

const MANAGED_BY_ID = new Map<string, ManagedCli>(MANAGED_CLIS.map((c) => [c.id, c]));

export function getManagedCli(id: string): ManagedCli | null {
  return MANAGED_BY_ID.get(id) ?? null;
}

export interface CliStatus {
  id: string;
  label: string;
  bin: string;
  installed: boolean;
  /** Captured version string (trimmed first line of `--version`), when installed. */
  version: string | null;
  /** Resolved absolute path on the box (best-effort; null when unknown). */
  path: string | null;
  /** True when the detection ran on a remote client over the tunnel. */
  remote: boolean;
  /** Set when detection could not run (tunnel down, no ssh target). */
  error: string | null;
  /** Whether a scripted install/update exists for this CLI. */
  canInstall: boolean;
  canUpdate: boolean;
}

const DETECT_TIMEOUT_MS = 8000;

/** Run a local binary's `--version`, capturing stdout/exit. Never throws. */
function localVersion(bin: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: DETECT_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, out: stdout?.toString() ?? '', err: stderr?.toString() || err.message });
        return;
      }
      resolve({ ok: true, out: stdout?.toString() ?? '', err: stderr?.toString() ?? '' });
    });
  });
}

/** Resolve a local binary's absolute path with `which`. Best-effort. */
function localWhich(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('which', [bin], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      const p = stdout?.toString().trim();
      resolve(!err && p ? p.split('\n')[0] : null);
    });
  });
}

function firstLine(s: string): string {
  return (s || '').trim().split('\n')[0]?.trim() ?? '';
}

/**
 * Detect ONE managed CLI on the SELECTED (or supplied) client's box, capturing
 * its version. Never throws.
 */
export async function detectCli(id: string, client?: Client | null): Promise<CliStatus> {
  const cli = getManagedCli(id);
  const c = client ?? getClientContext();
  const base = (cli && {
    id: cli.id,
    label: cli.label,
    bin: cli.bin,
    canInstall: !!cli.install,
    canUpdate: !!(cli.update || cli.install),
  }) || { id, label: id, bin: id, canInstall: false, canUpdate: false };

  if (!cli) {
    return { ...base, installed: false, version: null, path: null, remote: !!c && !c.is_self, error: 'unknown cli id' };
  }
  if (!c) {
    return { ...base, installed: false, version: null, path: null, remote: false, error: 'no client selected' };
  }

  if (c.is_self) {
    const [ver, where] = await Promise.all([
      localVersion(cli.bin, cli.versionArgs),
      localWhich(cli.bin),
    ]);
    if (!ver.ok && !where) {
      return { ...base, installed: false, version: null, path: null, remote: false, error: null };
    }
    return {
      ...base,
      installed: true,
      version: firstLine(ver.out) || firstLine(ver.err) || null,
      path: where,
      remote: false,
      error: null,
    };
  }

  // Remote client over the tunnel. One round-trip: which + version.
  const cmd =
    `command -v ${cli.bin} >/dev/null 2>&1 || { echo "__BCC_MISSING__"; exit 0; }; ` +
    `command -v ${cli.bin}; ${cli.bin} ${cli.versionArgs.join(' ')} 2>&1 | head -n 1`;
  const res = await runClientSsh(c, cmd);
  if (!res.ok) {
    return {
      ...base,
      installed: false,
      version: null,
      path: null,
      remote: true,
      error: c.ssh_target ? `remote detection failed (${res.reason})` : 'no SSH target configured for this client',
    };
  }
  if (res.stdout.includes('__BCC_MISSING__')) {
    return { ...base, installed: false, version: null, path: null, remote: true, error: null };
  }
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  const path = lines[0]?.trim() || null;
  const version = lines.length > 1 ? lines[1]?.trim() : null;
  return { ...base, installed: true, version: version || null, path, remote: true, error: null };
}

/** Detect every managed CLI on the selected client in parallel. */
export async function detectAllClis(client?: Client | null): Promise<CliStatus[]> {
  const c = client ?? getClientContext();
  return Promise.all(MANAGED_CLIS.map((cli) => detectCli(cli.id, c)));
}

export interface CliActionResult {
  ok: boolean;
  id: string;
  action: 'install' | 'update';
  /** Captured stdout/stderr tail (UI-safe; never secrets). */
  output: string;
  reason?: string;
}

/**
 * Run the install (or update) command for a managed CLI on the SELECTED
 * client's box. `install-if-missing` + `auto-update` from E16. Local self runs
 * the command in a login shell via `execFile('zsh', ['-lc', cmd])`; a remote
 * client runs it over the tunnel. Never throws.
 */
export async function runCliAction(
  id: string,
  action: 'install' | 'update',
  client?: Client | null
): Promise<CliActionResult> {
  const cli = getManagedCli(id);
  const c = client ?? getClientContext();
  if (!cli) return { ok: false, id, action, output: '', reason: 'unknown cli id' };
  if (!c) return { ok: false, id, action, output: '', reason: 'no client selected' };

  const cmd = action === 'update' ? cli.update || cli.install : cli.install;
  if (!cmd) {
    return {
      ok: false,
      id,
      action,
      output: '',
      reason: `${cli.label} has no scripted ${action}; install it manually on the target box`,
    };
  }

  if (c.is_self) {
    return new Promise<CliActionResult>((resolve) => {
      execFile('zsh', ['-lc', cmd], { timeout: 5 * 60_000, windowsHide: true }, (err, stdout, stderr) => {
        const output = `${stdout?.toString() ?? ''}${stderr?.toString() ?? ''}`.trim().slice(-4000);
        if (err) {
          resolve({ ok: false, id, action, output, reason: err.message });
          return;
        }
        resolve({ ok: true, id, action, output });
      });
    });
  }

  const res = await runClientSsh(c, cmd);
  return {
    ok: res.ok,
    id,
    action,
    output: `${res.stdout}${res.stderr}`.trim().slice(-4000),
    reason: res.ok ? undefined : res.reason || `remote ${action} failed`,
  };
}

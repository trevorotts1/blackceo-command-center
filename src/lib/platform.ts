/**
 * Platform detection and per-platform path resolution.
 *
 * BlackCEO Command Center ships to two deployment targets:
 *   - `mac-mini`   (operator's Mac Mini, native macOS install)
 *   - `vps-docker` (Hostinger VPS Docker container)
 *
 * Every code path that needs to read OpenClaw config, the operator's vault,
 * or a per-agent scratch directory MUST go through these helpers instead of
 * hardcoding a path. See PRD Section 3.6 (Fix #6) for the motivation.
 *
 * Detection order (highest precedence first):
 *   1. `OPENCLAW_PLATFORM` environment variable, when set to `mac-mini` or
 *      `vps-docker`. Lets the operator force a platform for tests, CI, or
 *      atypical hosts (for example, running the VPS container locally on a
 *      Mac for debugging).
 *   2. Presence of the `/data/.openclaw` directory. Hostinger's Docker
 *      template mounts `/data` as the persistent volume, so this directory
 *      reliably exists on every VPS install.
 *   3. Default to `mac-mini`. The Mac is the historical baseline and the
 *      safer fallback for any host that does not match the VPS marker.
 */

import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Client } from './clients';
import { safeReaddirNames, safeStatSync } from './fs/safe-fs';

export type Platform = 'mac-mini' | 'vps-docker';

const VPS_MARKER = '/data/.openclaw';

/**
 * Returns the platform this process is running on.
 *
 * Result is NOT cached, so callers that hit this on a hot path should cache
 * the result themselves. Detection is cheap (one env read plus at most one
 * `existsSync`) so this is safe to call on each request when convenient.
 */
export function detectPlatform(): Platform {
  const envOverride = process.env.OPENCLAW_PLATFORM;
  if (envOverride === 'mac-mini' || envOverride === 'vps-docker') {
    return envOverride;
  }

  if (existsSync(VPS_MARKER)) {
    return 'vps-docker';
  }

  return 'mac-mini';
}

/**
 * Absolute path to `openclaw.json` for the current platform.
 *
 * Mac Mini:   `~/.openclaw/openclaw.json`
 * VPS Docker: `/data/.openclaw/openclaw.json`
 */
export function openclawConfigPath(): string {
  if (detectPlatform() === 'vps-docker') {
    return '/data/.openclaw/openclaw.json';
  }
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

/**
 * Root directory for the operator's vault (Goals, Journal, Memory notes,
 * Studio outputs, Research results, Web Agent results).
 *
 * Mac Mini:   `~/clawd/`
 * VPS Docker: `/data/.openclaw/workspace/`
 */
export function vaultRoot(): string {
  if (detectPlatform() === 'vps-docker') {
    return '/data/.openclaw/workspace/';
  }
  return path.join(os.homedir(), 'clawd') + path.sep;
}

/**
 * Root directory for per-agent scratch space (Bridge chat working
 * directories, Workspace sub-module file storage).
 *
 * Mac Mini:   `~/clawd/scratch/`
 * VPS Docker: `/data/.openclaw/scratch/`
 *
 * Per-agent subdirectories live underneath this root, one directory per CLI
 * agent slug (claude, codex, antigravity, hermes, gemini, fcc, openclaw).
 * Callers typically do `path.join(operatorScratchRoot(), agentSlug)`.
 */
export function operatorScratchRoot(): string {
  if (detectPlatform() === 'vps-docker') {
    return '/data/.openclaw/scratch/';
  }
  return path.join(os.homedir(), 'clawd', 'scratch') + path.sep;
}

/**
 * Directory that holds the command center's OpenClaw Bridge device identity
 * (the ed25519 keypair the gateway pairs with). This MUST live on a path that
 * survives a container `docker compose up -d --force-recreate` / redeploy, or
 * the keypair regenerates on every boot, the `deviceId` changes, and the
 * gateway rejects the now-unknown device — the v4.1.1 connect-failure bug.
 *
 * Resolution order (highest precedence first):
 *   1. `BCC_DEVICE_IDENTITY_DIR` env var, when set. Lets an installer pin an
 *      arbitrary persistent location (e.g. a custom bind mount).
 *   2. VPS Docker: `/data/.openclaw/mission-control/identity`. `/data` is the
 *      Hostinger persistent volume (same volume `detectPlatform()` keys off),
 *      so the keypair survives force-recreate.
 *   3. Mac Mini (default): `~/.mission-control/identity`. The Mac home survives
 *      across restarts, so this path was already stable there.
 *
 * NOTE: the previous implementation hardcoded `~/.mission-control/identity` on
 * BOTH platforms. On VPS Docker the container home is NOT under `/data`, so the
 * identity was wiped on every redeploy. This helper fixes that while preserving
 * the Mac path (see `loadOrCreateDeviceIdentity` for the one-time migration of
 * a pre-existing legacy file forward onto the persistent path).
 */
export function deviceIdentityDir(): string {
  const override = process.env.BCC_DEVICE_IDENTITY_DIR;
  if (override && override.trim()) {
    return override.trim();
  }
  if (detectPlatform() === 'vps-docker') {
    return '/data/.openclaw/mission-control/identity';
  }
  return path.join(os.homedir(), '.mission-control', 'identity');
}

/**
 * The legacy device-identity directory, hardcoded to `~/.mission-control/...`
 * on every platform before v4.1.2. Used only by the one-time forward migration
 * so a VPS that was manually paired before the fix does not have to re-pair.
 */
export function legacyDeviceIdentityDir(): string {
  return path.join(os.homedir(), '.mission-control', 'identity');
}

/**
 * Ordered list of base directories that may hold a client's Zero-Human-Company
 * library (org chart, persona matrix, per-department governing-personas, role
 * folders). Skill 23 (`build-workforce.py`) writes this library; the dashboard
 * READS it. The two must agree on the layout or the dashboard shows "not built
 * yet" against a fully built workforce.
 *
 * The single source of truth is Skill 23's path resolution. Since v9.6.0 the
 * canonical company root is:
 *
 *     <vaultRoot>/zero-human-company/<company-slug>/
 *
 * with `ORG-CHART.md` + `persona-matrix.md`* + `departments.json` at the company
 * root and `departments/<dept-id>/governing-personas.md` underneath. (Older
 * pre-v9.6.0 builds wrote a flat `<vaultRoot>/departments/<dept-id>/` layout and
 * top-level `<vaultRoot>/ORG-CHART.md`; we keep those as fallbacks so a legacy
 * box is never regressed.)
 *
 * *Skill 23 currently writes `persona-matrix.md` into the per-company
 * `departments/` subfolder, so that location is included below.
 *
 * Resolution precedence (highest first):
 *   1. `OPENCLAW_COMPANY_ROOT` env var — an installer can pin the exact company
 *      folder. Used as-is (it already points AT `<...>/zero-human-company/<slug>`).
 *   2. Every `<root>/zero-human-company/<slug>/` discovered under each ZHC root,
 *      most-recently-modified first (matches sync-departments-from-build-state.py).
 *   3. Legacy flat `<root>/` (pre-v9.6.0) so old installs still resolve.
 *
 * ZHC roots, per platform (mirrors Skill 23 `WORKSPACE_ROOT` + VPS workspace):
 *   - Mac Mini:   `~/clawd`
 *   - VPS Docker: `/data/.openclaw/workspace`  (plus `~/clawd` as a safety net)
 *
 * `WORKSPACE_BASE_PATH` (when set) is honored as an additional explicit root.
 *
 * Returns absolute directory paths; callers append the file they want and probe
 * each in order (first existing wins).
 */
export function zhcLibraryBaseDirs(): string[] {
  const homedir = process.env.HOME || process.env.USERPROFILE || os.homedir();

  // ZHC roots that may contain a `zero-human-company/<slug>` tree.
  const zhcRoots: string[] = [];
  if (detectPlatform() === 'vps-docker') {
    zhcRoots.push('/data/.openclaw/workspace');
  }
  zhcRoots.push(path.join(homedir, 'clawd'));
  zhcRoots.push(path.join(homedir, '.openclaw', 'workspace'));
  if (process.env.WORKSPACE_BASE_PATH && process.env.WORKSPACE_BASE_PATH.trim()) {
    zhcRoots.unshift(
      path.resolve(process.env.WORKSPACE_BASE_PATH.replace(/^~/, homedir))
    );
  }

  const dirs: string[] = [];
  const push = (d: string) => {
    if (d && !dirs.includes(d)) dirs.push(d);
  };

  // 1. Explicit company-root override (already points at the <slug> folder).
  const companyRoot = process.env.OPENCLAW_COMPANY_ROOT;
  if (companyRoot && companyRoot.trim()) {
    push(path.resolve(companyRoot.trim()));
  }

  // 2. Canonical v9.6.0+ per-company folders, most-recently-modified first.
  type Found = { dir: string; mtime: number };
  const found: Found[] = [];
  for (const root of zhcRoots) {
    for (const containerName of ['zero-human-company', 'zhc']) {
      const container = path.join(root, containerName);
      // safeReaddirNames NEVER blocks the event loop: WORKSPACE_BASE_PATH may be
      // ~/Documents/Shared (TCC-protected), where a raw opendir would hang the
      // whole process forever. On a protected/network container the opendir runs
      // in a hard-timeout child and returns [] instead of freezing. Absent dir
      // → [] too, so the prior existsSync pre-check is folded in.
      for (const slug of safeReaddirNames(container)) {
        if (slug.startsWith('.')) continue;
        const companyDir = path.join(container, slug);
        const st = safeStatSync(companyDir);
        if (st && st.isDirectory()) found.push({ dir: companyDir, mtime: st.mtimeMs });
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  for (const f of found) push(f.dir);

  // 3. Legacy pre-v9.6.0 flat layout: the ZHC root itself.
  for (const root of zhcRoots) push(root);

  return dirs;
}

// ============================================================================
// PER-CLIENT path resolution (SINGLE-TENANT → PER-CLIENT foundation).
//
// The existing helpers above (openclawConfigPath / vaultRoot /
// operatorScratchRoot / zhcLibraryBaseDirs) resolve LOCAL paths for the box the
// Command Center runs on. They remain the correct answer for the operator's own
// box (is_self).
//
// For a REMOTE client the filesystem lives on a different machine, reached over
// the Cloudflare Access SSH tunnel. We do NOT do SSH I/O here — that belongs to
// the feature clusters. Instead `resolveClientPath` returns either a LOCAL
// absolute path (self) or a REMOTE DESCRIPTOR ({ remote: true, sshTarget, path })
// that a feature cluster wires up to a tunneled read.
// ============================================================================

/** The kinds of root a feature cluster may need to read for a client. */
export type ClientPathKind =
  | 'openclaw-config'
  | 'vault-root'
  | 'scratch-root';

/** A path on the local box — read it directly with `fs`. */
export interface LocalClientPath {
  remote: false;
  path: string;
}

/**
 * A path on a remote client's box. The feature cluster reads it over the
 * Cloudflare Access SSH tunnel using `sshTarget` (user@host or ssh alias).
 * `path` is the absolute path ON THE REMOTE BOX.
 */
export interface RemoteClientPath {
  remote: true;
  sshTarget: string | null;
  path: string;
}

export type ResolvedClientPath = LocalClientPath | RemoteClientPath;

/**
 * The default absolute root for a given kind, computed for a remote client.
 * Remote clients may pin an explicit `workspace_root`; otherwise we assume the
 * canonical Mac-mini layout under the SSH user's home (the common remote-client
 * shape in this fleet). `~` is left literal so the remote shell expands it.
 */
function remoteDefaultPath(kind: ClientPathKind, workspaceRoot: string | null): string {
  // An explicit workspace_root anchors vault/scratch; openclaw-config is keyed
  // off the OpenClaw home, not the vault, so it is computed independently.
  switch (kind) {
    case 'openclaw-config':
      return '~/.openclaw/openclaw.json';
    case 'vault-root':
      return workspaceRoot && workspaceRoot.trim() ? workspaceRoot : '~/clawd';
    case 'scratch-root':
      return workspaceRoot && workspaceRoot.trim()
        ? path.posix.join(workspaceRoot, 'scratch')
        : '~/clawd/scratch';
  }
}

/**
 * Resolve a root path for a specific client + kind.
 *
 * - `client.is_self === true`  → a LOCAL path using the existing platform
 *   helpers (fully backward compatible — same paths the app uses today).
 * - remote client → a REMOTE DESCRIPTOR carrying the ssh target and the path on
 *   the remote box. Callers MUST check `remote` and route remote reads over the
 *   tunnel; they must NOT pass a remote `path` to local `fs`.
 *
 * Never throws.
 */
export function resolveClientPath(client: Client, kind: ClientPathKind): ResolvedClientPath {
  if (client.is_self) {
    let localPath: string;
    switch (kind) {
      case 'openclaw-config':
        localPath = openclawConfigPath();
        break;
      case 'vault-root':
        localPath = client.workspace_root && client.workspace_root.trim()
          ? client.workspace_root
          : vaultRoot();
        break;
      case 'scratch-root':
        localPath = operatorScratchRoot();
        break;
    }
    return { remote: false, path: localPath };
  }

  return {
    remote: true,
    sshTarget: client.ssh_target,
    path: remoteDefaultPath(kind, client.workspace_root),
  };
}

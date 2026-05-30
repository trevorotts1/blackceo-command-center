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

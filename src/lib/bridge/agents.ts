/**
 * Bridge agent catalogue.
 *
 * The Operator Console Bridge sub-module (PRD 4.3) chats with seven
 * operator-level surfaces:
 *
 *   1. Claude Code  (Anthropic CLI)
 *   2. Codex        (OpenAI Codex CLI, >= 0.125 supports `exec --json`)
 *   3. Antigravity  (Google's experimental CLI, single-shot, slow)
 *   4. Hermes       (Nous Research portal, single-shot)
 *   5. Gemini       (Google Gemini CLI, streams NDJSON)
 *   6. FCC          (Free Claude Code, spawns the `claude` binary with the
 *                    local fcc-server proxy env injected)
 *   7. OpenClaw     (does NOT shell out; the chat panel calls the running
 *                    Gateway via `getOpenClawClient`)
 *
 * Each entry holds:
 *   - `id`           stable kebab-case key used in URLs, DB rows, and SSE topic
 *   - `label`        human-readable name shown in the picker
 *   - `accent`       hex accent color reused by the avatar bubble and the
 *                    send button gradient
 *   - `transport`    `cli` (spawn a child process) or `gateway` (OpenClaw WS)
 *   - `bin`          the CLI binary name to invoke when transport === `cli`
 *   - `envBin`       optional env var that overrides the binary path
 *                    (the auto-install scripts in Section 6 populate these
 *                    on first boot, so the Bridge does NOT have to know
 *                    every install location in advance)
 *   - `streams`      true when the CLI streams tokens (currently claude,
 *                    codex, gemini, fcc); false for single-shot agents
 *                    (antigravity, hermes). The send route still emits SSE
 *                    deltas for single-shot agents (one big chunk + done).
 *   - `expectedLatency` short hint string shown under the composer so the
 *                       operator does not assume a slow agent is broken.
 *
 * Section 6 of the PRD says the install scripts write each CLI's resolved
 * path into the `provider_credentials` table OR an env var. Until those
 * scripts run, we fall back to plain PATH lookup of `bin`. If the binary
 * is missing the send route returns a friendly error explaining how to
 * install it.
 */

import type { Platform } from '../platform';

export type AgentTransport = 'cli' | 'gateway';

export interface BridgeAgent {
  id: string;
  label: string;
  accent: string;
  description: string;
  transport: AgentTransport;
  bin?: string;
  envBin?: string;
  streams: boolean;
  expectedLatency: string;
  /**
   * Which platforms this agent is available on. The six desktop CLIs
   * (Claude Code, Codex, Antigravity, Hermes, Gemini, Free Claude Code) are
   * installed on the operator's Mac Mini, NOT inside the Hostinger VPS Docker
   * container, so they are `['mac-mini']`-only and the Bridge hides them on a
   * VPS install. OpenClaw is the one transport that exists on BOTH (it talks
   * to the in-container gateway over WebSocket), so it has no `platforms`
   * restriction. Omit `platforms` to mean "available everywhere".
   */
  platforms?: Platform[];
}

export const BRIDGE_AGENTS: readonly BridgeAgent[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    accent: '#D97757',
    description: "Anthropic's terminal CLI. Streams tokens. Best for coding and long-form reasoning.",
    transport: 'cli',
    bin: 'claude',
    envBin: 'BCC_CLAUDE_BIN',
    streams: true,
    expectedLatency: 'streams immediately',
    platforms: ['mac-mini'],
  },
  {
    id: 'codex',
    label: 'Codex',
    accent: '#10A37F',
    description: "OpenAI's Codex CLI. Streams via `codex exec --json`.",
    transport: 'cli',
    bin: 'codex',
    envBin: 'BCC_CODEX_BIN',
    streams: true,
    expectedLatency: 'streams in 2 to 6s',
    platforms: ['mac-mini'],
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    accent: '#7C3AED',
    description: "Google's Antigravity. Single-shot harness, 10 to 90s per task.",
    transport: 'cli',
    bin: 'agy',
    envBin: 'BCC_ANTIGRAVITY_BIN',
    streams: false,
    expectedLatency: '10 to 90s (no streaming)',
    platforms: ['mac-mini'],
  },
  {
    id: 'hermes',
    label: 'Hermes',
    accent: '#22D3EE',
    description: 'Nous Research portal. Single-shot, 5 to 15s.',
    transport: 'cli',
    bin: 'hermes',
    envBin: 'BCC_HERMES_BIN',
    streams: false,
    expectedLatency: '5 to 15s (Nous Portal)',
    platforms: ['mac-mini'],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    accent: '#F59E0B',
    description: "Google's Gemini CLI. Streams NDJSON, 4 to 10s.",
    transport: 'cli',
    bin: 'gemini',
    envBin: 'BCC_GEMINI_BIN',
    streams: true,
    expectedLatency: 'streams in 4 to 10s',
    platforms: ['mac-mini'],
  },
  {
    id: 'fcc',
    label: 'Free Claude Code',
    accent: '#A3E635',
    description: 'Spawns the `claude` binary with the local fcc-server proxy injected. Routes through OpenRouter and other providers.',
    transport: 'cli',
    bin: 'claude',
    envBin: 'BCC_CLAUDE_BIN',
    streams: true,
    expectedLatency: 'streams (proxy adds 1 to 2s)',
    platforms: ['mac-mini'],
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    accent: '#3B82F6',
    description: 'Routes through the OpenClaw Gateway over WebSocket. No CLI shell-out.',
    transport: 'gateway',
    streams: true,
    expectedLatency: '20 to 40s (gateway dispatch)',
  },
] as const;

/**
 * Build a lookup by `id`. Defined as a Map so callers do not pay a linear
 * scan on every send.
 */
const AGENTS_BY_ID = new Map<string, BridgeAgent>(
  BRIDGE_AGENTS.map((a) => [a.id, a]),
);

export function getBridgeAgent(id: string): BridgeAgent | null {
  return AGENTS_BY_ID.get(id) ?? null;
}

/**
 * Resolve the install type used to filter the pill strip.
 *
 * Precedence:
 *   1. `BCC_INSTALL_TYPE` env flag (`vps` | `mac`) — the explicit knob the
 *      installer can set when the filesystem probe is not authoritative.
 *   2. `detectPlatform()` — auto-detect (`OPENCLAW_PLATFORM` env, then the
 *      `/data/.openclaw` VPS marker, else `mac-mini`).
 *
 * Kept tiny and pure so it can run server-side in a Server Component and be
 * unit-tested without a filesystem.
 */
export function resolveInstallPlatform(detect: () => Platform): Platform {
  const flag = (process.env.BCC_INSTALL_TYPE ?? '').trim().toLowerCase();
  if (flag === 'vps' || flag === 'vps-docker') return 'vps-docker';
  if (flag === 'mac' || flag === 'mac-mini') return 'mac-mini';
  return detect();
}

/**
 * Agents visible on a given platform. An agent shows when it has no
 * `platforms` restriction OR the current platform is listed. On VPS Docker
 * this drops the six Mac-desktop CLIs and leaves OpenClaw (the only transport
 * that exists inside the container). On Mac Mini every agent shows, unchanged.
 *
 * Pure (platform passed in) so it is trivially unit-testable and safe to call
 * from a Server Component.
 */
export function visibleBridgeAgents(platform: Platform): BridgeAgent[] {
  return BRIDGE_AGENTS.filter(
    (a) => !a.platforms || a.platforms.includes(platform),
  );
}

/**
 * Resolve the CLI binary path for an agent.
 *
 * Order:
 *   1. The env var named by `envBin` (set by the Section 6 install scripts)
 *   2. The bare `bin` name (resolved by the child process spawn against the
 *      caller's PATH)
 *
 * Returns null for gateway agents (OpenClaw) since they do not spawn a CLI.
 */
export function resolveAgentBin(agent: BridgeAgent): string | null {
  if (agent.transport === 'gateway') return null;
  if (agent.envBin && process.env[agent.envBin]) {
    return process.env[agent.envBin] as string;
  }
  return agent.bin ?? null;
}

/**
 * The Free Claude Code agent runs the real `claude` binary with the
 * local fcc-server proxy env vars injected. The proxy address is
 * configurable so VPS Docker containers can point at the host service.
 */
export function fccProxyEnv(): Record<string, string> {
  const base = process.env.FCC_SERVER_URL || 'http://127.0.0.1:8082';
  return {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: process.env.FCC_API_KEY || 'fcc-proxy',
  };
}

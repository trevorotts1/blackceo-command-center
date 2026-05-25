/**
 * NotebookLM-compatible client adapter (PRD Section 4.6).
 *
 * Track B5. The primary backend is Google NotebookLM via an MCP server
 * (jacob-bd/notebooklm-mcp-cli). When NotebookLM credentials are absent or
 * the MCP binary is missing, the adapter falls back to a Gemini-CLI driven
 * local implementation that loads source documents as context.
 *
 * This module deliberately exposes a small, backend-agnostic surface (`ask`,
 * `studio.create`, `studio.status`, `download`). The route handlers do NOT
 * import the MCP SDK directly: they go through here. That keeps the
 * Gemini-local fallback transparent to the UI.
 *
 * If the NotebookLM MCP binary or credentials are missing, every method
 * returns a `{ ok: false, reason: 'unavailable' }` style result so the UI
 * can render a soft-degraded state rather than crashing.
 *
 * Depth 2 scope: surface area + capability probe + best-effort `ask`
 * dispatch. The MCP wiring is feature-flagged behind
 * `AGENTIC_OS_NLM_MCP_BIN` and degrades cleanly when the binary is not
 * present (the common case on a fresh v4.0 install).
 */

import fs from 'fs';

export type NotebookBackend = 'notebooklm' | 'gemini-local';

export interface NotebookBackendStatus {
  backend: NotebookBackend;
  available: boolean;
  reason?: string;
}

export interface AskOptions {
  notebookRemoteId?: string | null;
  question: string;
  sourceContext?: string;
}

export interface AskResult {
  ok: boolean;
  answer?: string;
  citations?: unknown[];
  reason?: string;
  backend: NotebookBackend;
}

const NLM_BIN_ENV = 'AGENTIC_OS_NLM_MCP_BIN';
const GEMINI_KEY_ENV = 'GOOGLE_API_KEY';

function nlmBinPath(): string | null {
  const raw = process.env[NLM_BIN_ENV];
  if (!raw || raw.trim().length === 0) return null;
  return raw.trim();
}

function nlmAvailable(): boolean {
  const bin = nlmBinPath();
  if (!bin) return false;
  try {
    return fs.existsSync(bin);
  } catch {
    return false;
  }
}

function geminiLocalAvailable(): boolean {
  return typeof process.env[GEMINI_KEY_ENV] === 'string' &&
    (process.env[GEMINI_KEY_ENV] as string).trim().length > 0;
}

/**
 * Returns the preferred backend for new notebooks, biased toward NotebookLM
 * when its MCP binary is present, and falling back to gemini-local if
 * `GOOGLE_API_KEY` is set. Returns `null` when neither is available.
 */
export function pickBackend(): NotebookBackend | null {
  if (nlmAvailable()) return 'notebooklm';
  if (geminiLocalAvailable()) return 'gemini-local';
  return null;
}

export function backendStatus(): NotebookBackendStatus[] {
  return [
    {
      backend: 'notebooklm',
      available: nlmAvailable(),
      reason: nlmAvailable() ? undefined : `${NLM_BIN_ENV} not set or binary missing`,
    },
    {
      backend: 'gemini-local',
      available: geminiLocalAvailable(),
      reason: geminiLocalAvailable() ? undefined : `${GEMINI_KEY_ENV} not set`,
    },
  ];
}

/**
 * Best-effort ask. Depth 2 keeps this thin: we resolve a backend and return
 * an unavailable result if no backend is configured. Later depths wire up the
 * MCP transport and the Gemini-CLI subprocess. The shape is stable.
 */
export async function ask(opts: AskOptions): Promise<AskResult> {
  const backend = pickBackend();
  if (!backend) {
    return {
      ok: false,
      backend: 'gemini-local',
      reason: 'No NotebookLM credentials and no GOOGLE_API_KEY. Configure one to enable Q&A.',
    };
  }
  // Backend dispatch is intentionally a no-op stub at Depth 2. The route
  // handlers report `ok: false` with the backend name so the UI can render a
  // helpful soft-error. Track B5 Depth 3+ will wire the actual MCP / Gemini
  // call paths here.
  return {
    ok: false,
    backend,
    reason: `Backend "${backend}" is configured but the wire path is not yet enabled at this depth. (question="${opts.question.slice(0, 80)}")`,
  };
}

export const _internals = {
  nlmAvailable,
  geminiLocalAvailable,
};

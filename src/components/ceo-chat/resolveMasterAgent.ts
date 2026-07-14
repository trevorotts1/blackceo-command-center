/**
 * resolveMasterAgent (U56 follow-up — AgentPicker envelope-safe resolution)
 *
 * PURE, framework-free — same precedent as `filterModels.ts` (U60 /
 * JM-U63f) — so a fixture test can assert the resolution logic directly,
 * without mounting the component.
 *
 * `GET /api/agents` now returns the enveloped `{ agents: [...] }` shape
 * (U56, E.2 / JM-U52) instead of a bare array. AgentPicker used to assume a
 * bare array (`Array.isArray(rows)` guard) and would silently bail — never
 * calling `onResolved` at all — the moment the route enveloped. Routing the
 * payload through `unwrapAgents()` (which accepts either shape and never
 * throws, defaulting to `[]`) keeps agent resolution working post-envelope.
 */
import { unwrapAgents } from '@/lib/api-envelope';
import type { AgentOption } from './types';

/** Picks the master agent (or the first row, or `null` on an empty/
 *  malformed payload) from a raw `GET /api/agents` response body. */
export function resolveMasterAgent(payload: unknown): AgentOption | null {
  const rows = unwrapAgents<AgentOption>(payload);
  return rows.find((a) => a.is_master) || rows[0] || null;
}

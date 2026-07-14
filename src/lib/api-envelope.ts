/**
 * Pure, never-throws unwrap helpers for the `{ agents: [...] }` /
 * `{ recommendations: [...] }` envelopes `GET /api/agents` and
 * `GET /api/recommendations` return (U56, E.2 / JM-U52).
 *
 * Both routes used to return a BARE array; every client-side consumer read
 * `await res.json()` directly as the list. The department-detail page
 * (`/ceo-board/[dept]`) was written against the correct enveloped contract
 * from the start (`agentData.agents`, `recData.recommendations`) — it was the
 * ROUTES that were wrong, which is why those two sections rendered
 * permanently empty. Now that the routes always envelope, every OTHER
 * consumer (dashboards, sidebars, strips) is updated to unwrap here instead
 * of assuming a bare array.
 *
 * Extracted into a pure module (no React/DOM) so the unwrap logic itself is
 * unit-testable, matching the `dashboard-workspaces.ts` precedent — and
 * tolerant of a stale/bare-array response (a rolling deploy where an old
 * client hits a mixed-version box, or a malformed/error payload) so a
 * consumer degrades to an empty list instead of throwing.
 */

/** Unwrap a `GET /api/agents` payload to its `agents` array. Accepts a bare
 *  array too (defensive backward-compat); anything else yields `[]`. */
export function unwrapAgents<T = unknown>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const agents = (data as { agents?: unknown } | null | undefined)?.agents;
  return Array.isArray(agents) ? (agents as T[]) : [];
}

/** Unwrap a `GET /api/recommendations` payload to its `recommendations`
 *  array. Accepts a bare array too (defensive backward-compat); anything
 *  else yields `[]`. */
export function unwrapRecommendations<T = unknown>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const recommendations = (data as { recommendations?: unknown } | null | undefined)?.recommendations;
  return Array.isArray(recommendations) ? (recommendations as T[]) : [];
}

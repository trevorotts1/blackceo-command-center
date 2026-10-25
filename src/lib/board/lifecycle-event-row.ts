/**
 * PBB-073 / T-35 — lifecycle event row shape + event-time parsing (pure half).
 *
 * WHAT THIS IS
 * ------------
 * `lifecycle-projection.ts` is SERVER-ONLY — it reads better-sqlite3 through
 * `@/lib/db`, which reaches `fs` / `child_process`. Two of its primitives are
 * dependency-free, though, and the campaign approval contract needs them too.
 * Sharing them through the server module dragged `fs` and `child_process` into
 * the browser bundle (via the client component `CampaignApprovalBoard.tsx`)
 * and the build died at "Module not found: Can't resolve 'fs'".
 *
 * So these two live here, where the boundary is structural instead of
 * accidental: this module has NO runtime import of anything. It may be reached
 * from a client component's module graph; `lifecycle-projection.ts` may not.
 *
 * PURE. No node builtins, no `@/lib/db`, no `fs` / `child_process`.
 */

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** One `task_events` row (src/lib/db/schema.ts §3). */
export interface LifecycleEventRow {
  id: string;
  task_id: string;
  from_status: string;
  to_status: string;
  actor?: string | null;
  reason?: string | null;
  created_at: string;
}

// ─── Time parsing ───────────────────────────────────────────────────────────
/**
 * `task_events.created_at` reaches us in TWO shapes: SQLite's
 * `datetime('now')` → `YYYY-MM-DD HH:MM:SS` (UTC, no zone) and the
 * transition() path's `new Date().toISOString()` → `YYYY-MM-DDTHH:mm:ss.sssZ`.
 * `Date.parse` treats the first as LOCAL time, which would shift the stall
 * window by the box's UTC offset — so normalise the space form to UTC first.
 */
export function parseEventTime(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const normalised = trimmed.includes(' ') ? trimmed.replace(' ', 'T') : trimmed;
  const ms = Date.parse(hasZone ? normalised : `${normalised}Z`);
  return Number.isFinite(ms) ? ms : null;
}

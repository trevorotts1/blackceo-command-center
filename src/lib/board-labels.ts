/**
 * P2-01 — BACKLOG vs. TO-DO: THE DETERMINATION.
 *
 * The board keeps BOTH waiting columns — they encode a real, server-enforced
 * gate (the Triad Rule in src/lib/sops.ts) and are not duplicates. What was
 * confusing was the LABELS, not the mechanism, so this module is the single
 * source of the renamed client-facing vocabulary:
 *
 *   Backlog -> "Being Prepared"  (landed, not yet groomed: missing
 *                                 description, SOP, or persona)
 *   To-Do   -> "Ready to Start"  (groomed + ready, queued but not started)
 *
 * Consumers:
 *   - src/components/MissionQueue.tsx — the column header pill labels + the
 *     hover subtitle (`title=`) + the per-card "why is this here?" pill.
 *   - src/lib/jobs/trust-engine.ts    — the honest "queued for grooming" ACK
 *     copy for a task still parked in Backlog, so the client hears the SAME
 *     explanation on the board and in the trust-engine message (P2-01 step 3).
 *
 * IMPORTANT: no `TaskStatus` values change here and nothing in this file
 * touches the API contract — this is display vocabulary only. The real gate
 * stays in src/lib/sops.ts (`checkTriad`), which also verifies the sop_id
 * row hasn't been soft-deleted (a DB read this module deliberately cannot
 * do, since it is imported from a 'use client' component). The
 * `triadMissingFields` presence check below mirrors ONLY the field-presence
 * half of `checkTriad` — the same local-mirror pattern already used by
 * `sop-learning.ts`'s `isValidTriadPersona` to avoid pulling a DB-backed
 * module into a layer that must not import it. The server's
 * `PATCH /api/tasks/[id]` gate remains the sole source of truth for whether
 * a task may actually leave Backlog.
 */

export const BACKLOG_COLUMN_LABEL = 'Being Prepared';
export const TODO_COLUMN_LABEL = 'Ready to Start';

/** Verbatim hover subtitle for the Backlog ("Being Prepared") column pill. */
export const BACKLOG_COLUMN_SUBTITLE =
  "We're gathering what this task needs — a description, a playbook, and the right persona";

// Sentinel persona-id values that mean "not really a persona" — mirrors
// sops.ts's PERSONA_SENTINELS / isValidPersonaId (server) and
// sop-learning.ts's isValidTriadPersona (the same local-mirror comment
// pattern: "mirroring sops.ts ... without importing the route-layer module").
const PERSONA_SENTINELS = new Set(['schemaversion', 'schema_version', 'null', 'none', 'undefined', '']);

function hasRealPersona(personaId: string | null | undefined): boolean {
  if (!personaId) return false;
  return !PERSONA_SENTINELS.has(personaId.toLowerCase().trim());
}

export type TriadMissingKey = 'description' | 'sop_id' | 'persona_id';

export interface TriadFieldsInput {
  description?: string | null;
  sop_id?: string | null;
  persona_id?: string | null;
}

/**
 * Client-safe (no DB) mirror of the PRESENCE half of `checkTriad`
 * (src/lib/sops.ts). Returns the missing keys in the SAME order/shape the
 * server's 400 `{"error":"Triad incomplete","missing":[...]}` uses, so a
 * Backlog card's pill and TaskModal's Triad-error banner never disagree on
 * vocabulary.
 */
export function triadMissingFields(task: TriadFieldsInput): TriadMissingKey[] {
  const missing: TriadMissingKey[] = [];
  if (!task.description || !task.description.trim()) missing.push('description');
  if (!task.sop_id) missing.push('sop_id');
  if (!hasRealPersona(task.persona_id)) missing.push('persona_id');
  return missing;
}

const TRIAD_MISSING_LABELS: Record<TriadMissingKey, string> = {
  description: 'description',
  sop_id: 'SOP',
  persona_id: 'persona',
};

/** "Missing: description, SOP" style text for the Backlog card pill. */
export function triadMissingPillText(missing: TriadMissingKey[]): string {
  return `Missing: ${missing.map((key) => TRIAD_MISSING_LABELS[key]).join(', ')}`;
}

/**
 * A41 — the ONE list of fields that decide whether two task rows AGREE, plus
 * the comparator that decides it. Pure, dependency-free, and safe to import
 * from a 'use client' module.
 *
 * WHY THIS EXISTS
 * ---------------
 * A41: "UI live update, refresh, reconnect, and task detail agree about
 * preparation/execution state and provider provenance." Reconnect was the
 * weakest surface: two separate catch-up call sites compared only `status`
 * (src/app/workspace/[slug]/page.tsx) or only `status` + `updated_at`
 * (src/hooks/useSSE.ts) before deciding to reconcile — so a REAL change to a
 * computed field with no status/updated_at write (a persona-mismatch landing,
 * a dispatch hold clearing, a provider swap) left the stale card on screen and
 * the operator reading it as current.
 *
 * Both call sites now ask this module, and so does the four-surface probe: one
 * field list, one comparator, no second copy to drift.
 *
 * The list is deliberately the A41 CLASSES rather than every column: provider
 * provenance (model_*), the prepared/committed/used bundle, the mismatch and
 * hold surfaces, and the runtime execution provenance. A row whose `title`
 * changed still differs via `updated_at`, so nothing rendered is missed.
 */

import type { Task } from '@/lib/types';

/** Exactly the fields A41 requires the four surfaces to agree on. */
export const A41_ROW_FIELDS = [
  // provider provenance (intended, resolved through the model_registry join)
  'model_id',
  'model_label',
  'model_provider',
  // prepared / committed / used, and runtime execution provenance
  'provider_truth',
  'subtask_personas',
  'persona_bundle_scopes',
  'blend_confirm_state',
  // selection state that must never pretend assignment equals execution
  'persona_mismatch',
  'dispatch_hold',
] as const;

export type A41RowField = (typeof A41_ROW_FIELDS)[number];

/**
 * Stable stringify: object keys are sorted so two rows built by different code
 * paths compare on VALUE, not on the order their properties happened to be
 * assigned. Arrays keep their order (the plan rows are seq-ordered and
 * reordering them IS a change).
 */
function stable(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(rec[k])}`).join(',')}}`;
}

/** The A41 subset of a row, as a stable string. Used by the comparator and the probe. */
export function a41Fingerprint(task: unknown): string {
  if (!task || typeof task !== 'object') return 'null';
  const rec = task as Record<string, unknown>;
  return stable(A41_ROW_FIELDS.map((f) => [f, rec[f]]));
}

/** Which A41 fields differ between two rows — empty when they agree. */
export function a41DifferingFields(a: unknown, b: unknown): A41RowField[] {
  const ra = (a ?? {}) as Record<string, unknown>;
  const rb = (b ?? {}) as Record<string, unknown>;
  return A41_ROW_FIELDS.filter((f) => stable(ra[f]) !== stable(rb[f]));
}

/**
 * Does the fresh row disagree with the row already on screen? True when the
 * row is new to the store, when status or updated_at moved (the historical
 * predicate), or when ANY A41 field changed. A missing row is a disagreement
 * (the card appeared or disappeared).
 */
export function taskRowDisagrees(fresh: unknown, current: unknown): boolean {
  if (!current) return true;
  const f = fresh as Partial<Task> | null;
  const c = current as Partial<Task> | null;
  if (!f || !c) return true;
  if (f.status !== c.status) return true;
  if (f.updated_at !== c.updated_at) return true;
  return a41DifferingFields(f, c).length > 0;
}

/**
 * Would a reconnect refetch reconcile? Same rule the two catch-up call sites
 * apply, in one place: any length change reconciles, and any row the store does
 * not already hold in its fresh form reconciles.
 */
export function boardStateDisagrees(fresh: unknown[], current: unknown[]): boolean {
  if (fresh.length !== current.length) return true;
  return fresh.some((t) => {
    const id = (t as Partial<Task> | null)?.id;
    const c = current.find((ct) => (ct as Partial<Task> | null)?.id === id);
    return taskRowDisagrees(t, c);
  });
}

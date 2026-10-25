/**
 * PBB-128 / T-32 — calendar cell resolution (the browser-safe half).
 *
 * WHAT THIS IS
 * ------------
 * `CampaignApprovalBoard.tsx` is a CLIENT component, so every module it
 * imports at runtime is shipped to the browser. `approval-contract.ts` is the
 * pure read-model, but it hashes with `node:crypto` and parses event time, so
 * it must never be a *runtime* edge of the client graph.
 *
 * This module is the one runtime edge the client is allowed: it resolves a
 * placement to its calendar cell and re-exports the render types. The types are
 * `import type` / `export type` only, so they are erased before bundling — the
 * client graph therefore reaches NO server code at all.
 *
 * PURE. No node builtins, no `@/lib/db`, no `fs` / `child_process`.
 */
import type {
  CampaignApprovalView,
  CalendarCellState,
  PlacementView,
  PublicationState,
} from './approval-contract';

export type { CampaignApprovalView, CalendarCellState, PublicationState };

/** The calendar cell a placement lands in. Publication only with a receipt. */
export function cellStateOf(placement: PlacementView): CalendarCellState {
  // A dated provider completion receipt is the strongest evidence there is;
  // freshness still rides the row for the operator to see.
  if (placement.publication_state === 'CURRENT') return 'published';
  if (placement.freshness === 'stale') return 'stale';
  if (placement.freshness === 'unknown') return 'unknown';
  if (placement.approval_state === 'HELD') return 'held';
  if (placement.approval_state === 'APPROVED') return 'scheduled';
  if (placement.approval_state === 'UNKNOWN') return 'unknown';
  return 'unapproved';
}

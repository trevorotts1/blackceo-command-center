import { canonicalDeptSlug } from './canonical-slug';

/**
 * Workspace ids that are structural to every box's schema — never a chosen
 * department and never the catch-all — no matter what they are named. Mirrors
 * onboarding's STRUCTURAL_WORKSPACES
 * (32-command-center-setup/scripts/seed-dashboard-content.py). 'default' is
 * seed.ts's own DEFAULT target (seed.ts:137-140, name 'General', a
 * housekeeping bucket), not the General Task catch-all lane.
 */
export const STRUCTURAL_WORKSPACE_IDS = ['default'] as const;

/** Durable marker shared by routing, assignment and dispatch authorization. */
export function isCatchAllRoutingReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith('[catch-all]');
}

/** Reason text the router stamps when the owner themself asked for General Task. */
export const EXPLICIT_GENERAL_REASON = 'Explicit General Task request';

/**
 * Reason text for a card ingest PARKED in General Task because it could not be
 * routed at capture (box not provisioned, or no confident route). It is not a
 * request for General Task, so a re-route is allowed once the box can route.
 * Stored as `[catch-all] <this>...`: the `[catch-all]` prefix keeps execution
 * authorization unchanged.
 */
export const CAPTURE_FALLBACK_REASON = 'Fallback at capture, not an explicit General Task request';

/** Ingest's provenance block header, and the line it writes only for a caller-supplied department. */
export const INGEST_PROVENANCE_HEADER = '— Captured via task-ingest —';
export const REQUESTED_DEPARTMENT_LINE = 'Requested department:';

/**
 * True for a card that sits in General Task only because capture fell back.
 *
 * New rows carry CAPTURE_FALLBACK_REASON. LEGACY rows (before that reason
 * existed) were stamped EXPLICIT_GENERAL_REASON by the same fallback, because
 * ingest backfilled `department` from the fallback General workspace and the
 * router read it as an explicit tag. The two are told apart by provenance:
 * ingest writes a `Requested department:` line only when the caller supplied a
 * department_slug. A legacy row is a fallback only if it has the ingest
 * provenance block and no such line. A card without the block (UI, CEO chat,
 * other producers) or with the line is treated as a real request and is left alone.
 */
export function isCaptureFallbackTask(task: {
  routing_reason?: string | null;
  department?: string | null;
  description?: string | null;
}): boolean {
  const reason = task.routing_reason ?? '';
  if (reason.startsWith(`[catch-all] ${CAPTURE_FALLBACK_REASON}`)) return true;
  if (!reason.startsWith(`[catch-all] ${EXPLICIT_GENERAL_REASON}`)) return false;
  if (!['general', 'general-task'].includes(canonicalDeptSlug(task.department ?? ''))) return false;
  const description = task.description ?? '';
  const at = description.lastIndexOf(INGEST_PROVENANCE_HEADER);
  return at >= 0 && !description.slice(at).split('\n').some((line) => line.startsWith(REQUESTED_DEPARTMENT_LINE));
}

/** Recognition never establishes ownership; callers must also verify company scope. */
export function isCatchAllWorkspace(workspace: { slug?: string | null; name?: string | null }): boolean {
  const rawSlug = (workspace.slug ?? '').trim().toLowerCase();
  const slug = canonicalDeptSlug(workspace.slug ?? '');
  // Structural check first: the schema's 'default' bucket is never a
  // catch-all, regardless of what it happens to be named.
  if ((STRUCTURAL_WORKSPACE_IDS as readonly string[]).includes(rawSlug) ||
      (STRUCTURAL_WORKSPACE_IDS as readonly string[]).includes(slug)) {
    return false;
  }
  return ['general', 'general-task', 'master-orchestrator', 'ceo'].includes(slug)
    || ['general', 'general task', 'ceo', 'master orchestrator'].includes((workspace.name ?? '').trim().toLowerCase());
}

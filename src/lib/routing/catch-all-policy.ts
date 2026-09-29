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

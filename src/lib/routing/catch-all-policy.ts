import { canonicalDeptSlug } from './canonical-slug';

/** Durable marker shared by routing, assignment and dispatch authorization. */
export function isCatchAllRoutingReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith('[catch-all]');
}

/** Recognition never establishes ownership; callers must also verify company scope. */
export function isCatchAllWorkspace(workspace: { slug?: string | null; name?: string | null }): boolean {
  const slug = canonicalDeptSlug(workspace.slug ?? '');
  return ['general', 'general-task', 'master-orchestrator', 'ceo'].includes(slug)
    || ['general', 'general task', 'ceo', 'master orchestrator'].includes((workspace.name ?? '').trim().toLowerCase());
}

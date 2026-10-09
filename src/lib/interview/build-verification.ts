/** A legacy timestamp alone cannot certify a personalized workforce. */
export function verifiedBuild(state: Record<string, unknown> | null): boolean {
  if (!state || typeof state.buildId !== 'string' || !state.buildId) return false;
  const receipt = state.completionVerification as Record<string, unknown> | undefined;
  return receipt?.version === 1 && receipt.status === 'verified' && receipt.buildId === state.buildId &&
    Array.isArray(receipt.unmetRequirements) && receipt.unmetRequirements.length === 0;
}

/** Owner-ordered standard company (Trevor 2026-10-08): admits the dashboard while the interview stays open. Never counts as interview completion. */
export function standardPlaceholderActive(state: Record<string, unknown> | null): boolean {
  const p = state?.standardPlaceholder as Record<string, unknown> | undefined;
  return state?.companyMode === 'standard-placeholder' && p?.status === 'active';
}

/** The personalized workforce must be installed and synchronized before its board is ready. */
export function verifiedCommandCenter(state: Record<string, unknown> | null): boolean {
  return !!state && state.commandCenterStatus === 'done' && [
    'commandCenterBuildFresh', 'commandCenterWorkspacesSeeded', 'commandCenterDepartmentsSynced',
    'commandCenterMdContentSynced', 'commandCenterDashboardContentSeeded',
    'commandCenterDeptRuntimeParity', 'commandCenterTenantReady',
  ].every(key => state[key] === true);
}

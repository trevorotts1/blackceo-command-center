/**
 * Setup readiness vocabulary (T-31).
 *
 * The Command Center's health probes answer "is the running system well right
 * now". They do NOT answer "is this box actually SET UP" — a box can be
 * perfectly live and still have no owner record, no workspace, and no agent
 * roster, because nothing on the boot path is required to prove any of that.
 *
 * Three states, and only three. The important one is UNKNOWN: it means a probe
 * could not decide, and it is NEVER folded into READY. A readiness surface that
 * rounds "couldn't tell" up to "fine" is worse than no surface at all, because
 * it spends the operator's trust on a claim nobody made.
 */

export type ReadinessState = 'READY' | 'BLOCKED' | 'UNKNOWN';

export type ReadinessGroup = 'data' | 'identity' | 'runtime';

/**
 * What actually decided an item's state.
 *
 * `probe` names the operation that ran (a SQL statement, a registry lookup, a
 * socket connect) so the claim is checkable. `observed` carries the returned
 * values — never credentials, never a config value standing in for a result.
 */
export interface ReadinessEvidence {
  probe: string;
  observed: Record<string, unknown>;
  at: string;
}

export interface ReadinessItem {
  id: ReadinessItemId;
  label: string;
  group: ReadinessGroup;
  state: ReadinessState;
  /** Why it is blocked. Present exactly when `state === 'BLOCKED'`. */
  reason?: string;
  /** What decided the state, or (for UNKNOWN) why nothing could decide it. */
  evidence: ReadinessEvidence;
}

export type ReadinessItemId =
  | 'database'
  | 'schema_migrations'
  | 'dispatch_schema'
  | 'company_record'
  | 'company_workspace'
  | 'owner_registration'
  | 'agent_roster'
  | 'openclaw_gateway';

export interface OwnerAction {
  id: OwnerActionId;
  label: string;
  /** Plain description of what running it does. */
  description: string;
  /** Item ids this action is expected to unblock. */
  unblocks: ReadinessItemId[];
  enabled: boolean;
  /**
   * Present exactly when `enabled === false`: the reason this action CANNOT
   * succeed right now. An action that would fail is shown disabled with its
   * reason instead of being offered and failing silently.
   */
  disabledReason?: string;
}

export type OwnerActionId =
  | 'apply_pending_migrations'
  | 'create_company_record'
  | 'create_default_workspace'
  | 'sync_agent_roster';

export interface SetupReadiness {
  /** BLOCKED if anything is blocked, else UNKNOWN if anything is unknown, else READY. */
  overall: ReadinessState;
  items: ReadinessItem[];
  actions: OwnerAction[];
  computedAt: string;
}

export interface ActionResult {
  action: OwnerActionId;
  applied: boolean;
  /** Human-readable outcome. Always present, including on refusal. */
  detail: string;
}

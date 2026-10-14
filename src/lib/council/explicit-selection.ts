/**
 * Council of Wise Elders: explicit route selection (CWE-008).
 *
 * Directive Section 13 and binding B08. This is the council-scoped
 * explicit-selection path around the host's restrictive selectors. It exists
 * so that a route the client explicitly chose reaches the provider adapter
 * unchanged, while every unrelated department keeps its existing vendor and
 * cascade policies. Nothing in this module imports or calls the host model
 * selector, the intelligence resolver, or the runtime model reconciler, and
 * nothing here changes their behavior for non-council work.
 *
 * Guarantees:
 * 1. An explicitly chosen allowed route is not replaced by a preferred model.
 *    A host attempt that resolves to a different model is either refused
 *    (default, fallback_policy none) or, only under a client-approved
 *    fallback policy with an approval record, surfaced as an explicit route
 *    change with a new route revision. It is never silent.
 * 2. Requested and observed identities are kept distinct across the five
 *    identity levels in providers.ts, and identity is never inferred from a
 *    model's own prose response: the resolution input has a structured
 *    transport-reported field, and a prose claim field that is accepted only
 *    to be recorded as ignored.
 * 3. Scope comes only from the trusted host-filled scope argument. A
 *    body-supplied company or tenant id is never proof of scope; a
 *    conflicting one is rejected.
 * 4. No credential value enters any structure emitted here. Selections carry
 *    credential presence (name and source) only, copied from the catalog.
 */

import {
  HIDDEN_IDENTITY_STATEMENT,
  identityLevelRank,
  type CredentialPresence,
  type RouteCapabilitySnapshot,
  type RouteCatalogEntry,
  type RouteIdentityLevel,
  type RouteKind,
} from './providers';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CouncilSelectionErrorCode =
  | 'ROUTE_NOT_IN_CATALOG'
  | 'UNTRUSTED_SCOPE_FIELD'
  | 'INVALID_SELECTION'
  | 'COMBINATION_MEMBER_REQUIRED';

export class CouncilSelectionError extends Error {
  readonly code: CouncilSelectionErrorCode;
  constructor(code: CouncilSelectionErrorCode, message: string) {
    super(message);
    this.name = 'CouncilSelectionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Trusted scope (host-filled only, mirroring the CWE-003 ScopeFields rule: a
// caller never gains authority by supplying these fields).
// ---------------------------------------------------------------------------

export interface TrustedScope {
  tenantId: string;
  companyId: string;
  installationId: string;
  ownerSubject: string | null;
}

/** Field names a client body may never use to establish scope. */
const SCOPE_FIELD_NAMES = [
  'tenant_id',
  'tenantId',
  'company_id',
  'companyId',
  'installation_id',
  'installationId',
  'owner_subject',
  'ownerSubject',
] as const;

// ---------------------------------------------------------------------------
// Selection snapshot (build step 2: persist the exact selected route and
// alias, reasoning preference, fallback policy, account reference, and
// capability snapshot).
// ---------------------------------------------------------------------------

export type ModelSelectionSource = 'explicit' | 'client_default' | 'route_default';
export type FallbackPolicy = 'none' | 'client_approved_only';

export interface ReasoningPreferenceOutcome {
  /** Exactly what the client asked for. Never renamed. */
  requested: string | null;
  /** What will actually be applied. Null when nothing may be claimed active. */
  applied: string | null;
  /** True/false when support is known; null when the route is unprobed. */
  supported: boolean | null;
  /** Plain-language limitation, present whenever applied differs from asked. */
  limitation: string | null;
}

export interface CouncilRouteSelection {
  schema: 'wise-elders.route-selection/v1';
  selectionSource: ModelSelectionSource;
  routeId: string;
  routeRevision: number;
  routeKind: RouteKind;
  providerSlug: string;
  /** Exact requested route reference (the catalog route id). */
  requestedRoute: string;
  /** Requested model or alias for a fixed route. Null for combinations. */
  requestedModelOrAlias: string | null;
  /** Pinned, ordered combination members. Null for fixed routes. */
  combinationMembers: string[] | null;
  reasoning: ReasoningPreferenceOutcome;
  fallbackPolicy: FallbackPolicy;
  providerAccountRef: string | null;
  capabilitySnapshot: RouteCapabilitySnapshot;
  credential: CredentialPresence;
  /** Identity level at selection time; never stronger than the evidence. */
  identityLevel: RouteIdentityLevel;
  scope: TrustedScope;
  createdAt: string;
}

/**
 * Untrusted client input. Every field is a request, never evidence. Scope
 * fields are detected only so a conflict can be rejected; they are never
 * read as authority.
 */
export interface RouteSelectionRequest {
  routeId: string;
  selectionSource?: ModelSelectionSource;
  requestedModelOrAlias?: string | null;
  reasoningPreference?: string | null;
  fallbackPolicy?: FallbackPolicy;
  providerAccountRef?: string | null;
  [key: string]: unknown;
}

function assertNoConflictingScopeFields(
  request: RouteSelectionRequest,
  scope: TrustedScope,
): void {
  const trustedByField: Record<string, string | null> = {
    tenant_id: scope.tenantId,
    tenantId: scope.tenantId,
    company_id: scope.companyId,
    companyId: scope.companyId,
    installation_id: scope.installationId,
    installationId: scope.installationId,
    owner_subject: scope.ownerSubject,
    ownerSubject: scope.ownerSubject,
  };
  for (const field of SCOPE_FIELD_NAMES) {
    const supplied = request[field];
    if (supplied === undefined || supplied === null) continue;
    if (String(supplied) !== String(trustedByField[field] ?? '')) {
      throw new CouncilSelectionError(
        'UNTRUSTED_SCOPE_FIELD',
        `Body-supplied ${field} conflicts with the trusted scope and is not proof of scope.`,
      );
    }
  }
}

function resolveReasoning(
  requested: string | null,
  capability: RouteCapabilitySnapshot,
): ReasoningPreferenceOutcome {
  if (requested === null) {
    return { requested: null, applied: null, supported: null, limitation: null };
  }
  // `auto` is preserved as no forced vendor-specific reasoning parameter.
  if (requested === 'auto') {
    return { requested, applied: 'auto', supported: true, limitation: null };
  }
  const supportedLevels = capability.supportedReasoningLevels;
  if (supportedLevels === null) {
    return {
      requested,
      applied: null,
      supported: null,
      limitation:
        `Reasoning preference "${requested}" is recorded, but this route has not been probed ` +
        'for reasoning support, so the preference is not claimed active.',
    };
  }
  if (supportedLevels.includes(requested)) {
    return { requested, applied: requested, supported: true, limitation: null };
  }
  return {
    requested,
    applied: null,
    supported: false,
    limitation:
      `Reasoning preference "${requested}" is not supported by this route. ` +
      `Supported levels: ${supportedLevels.join(', ') || 'none documented'}. ` +
      'The requested value is retained as requested; it was not renamed to another level ' +
      'and is not claimed active.',
  };
}

/**
 * Create the pinned selection snapshot for a session revision. The catalog
 * entry is the frozen route fact source; the scope is the trusted host
 * argument only.
 */
export function createRouteSelection(
  entry: RouteCatalogEntry,
  request: RouteSelectionRequest,
  trustedScope: TrustedScope,
  options: { routeRevision: number; createdAt: string },
): CouncilRouteSelection {
  if (request.routeId !== entry.routeId) {
    throw new CouncilSelectionError(
      'ROUTE_NOT_IN_CATALOG',
      `Requested route ${request.routeId} does not match catalog entry ${entry.routeId}.`,
    );
  }
  assertNoConflictingScopeFields(request, trustedScope);

  if (entry.kind === 'fixed_model') {
    const requestedModel = request.requestedModelOrAlias ?? entry.modelId;
    if (!requestedModel || requestedModel !== entry.modelId) {
      throw new CouncilSelectionError(
        'INVALID_SELECTION',
        'A fixed-model selection must name the exact catalog model for the route.',
      );
    }
  }
  if (entry.kind === 'combination' && entry.combinationMembers.length === 0) {
    throw new CouncilSelectionError(
      'COMBINATION_MEMBER_REQUIRED',
      'A combination route must carry its pinned member list.',
    );
  }

  const fallbackPolicy: FallbackPolicy = request.fallbackPolicy ?? 'none';
  const reasoning = resolveReasoning(
    request.reasoningPreference ?? null,
    entry.capability,
  );

  return {
    schema: 'wise-elders.route-selection/v1',
    selectionSource: request.selectionSource ?? 'explicit',
    routeId: entry.routeId,
    routeRevision: options.routeRevision,
    routeKind: entry.kind,
    providerSlug: entry.providerSlug,
    requestedRoute: entry.routeId,
    requestedModelOrAlias: entry.kind === 'fixed_model' ? entry.modelId : null,
    combinationMembers:
      entry.kind === 'combination' ? [...entry.combinationMembers] : null,
    reasoning,
    fallbackPolicy,
    providerAccountRef: request.providerAccountRef ?? entry.providerAccountRef,
    capabilitySnapshot: {
      contextWindowTokens: entry.capability.contextWindowTokens,
      maxOutputTokens: entry.capability.maxOutputTokens,
      capabilities: [...entry.capability.capabilities],
      supportedReasoningLevels: entry.capability.supportedReasoningLevels
        ? [...entry.capability.supportedReasoningLevels]
        : null,
    },
    credential: {
      state: entry.credential.state,
      envVar: entry.credential.envVar,
      source: entry.credential.source,
      checked: [...entry.credential.checked],
    },
    identityLevel: entry.identityLevel,
    scope: { ...trustedScope },
    createdAt: options.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Host resolution guard. The execution owner (CWE-009) reports what the host
// actually resolved; this guard decides whether that resolution may stand
// for a council selection, and records the outcome explicitly either way.
// ---------------------------------------------------------------------------

export type HostResolutionSource =
  | 'explicit_route'
  | 'cascade'
  | 'sovereign_default'
  | 'runtime_reconcile'
  | 'combination_member'
  | 'fallback';

export interface ClientFallbackApproval {
  approvalRef: string;
  reason: string;
  /** Cost implications of the change, stated by the approval record. */
  costImplication: string;
}

export interface HostResolutionAttempt {
  source: HostResolutionSource;
  /** Model the host used or tried to use, when the transport exposes one. */
  attemptedModelId: string | null;
  /**
   * Identity reported by the transport or provider through a structured
   * field. This is the only reported-identity input. Null when the router
   * hides the underlying model.
   */
  reportedModelId?: string | null;
  /**
   * A model identity claimed in a model's own prose response. Accepted only
   * so the outcome can record that it was ignored: prose is never identity
   * evidence (Section 13.4).
   */
  proseClaimedModelId?: string | null;
  /** Client approval for a fallback change, when one exists. */
  approval?: ClientFallbackApproval | null;
}

export interface RouteChangeRecord {
  reason: string;
  originalRoute: string;
  replacementRoute: string;
  costImplications: string;
  newRouteRevision: number;
  approvalRef: string;
}

export type RouteResolutionEvent =
  | {
      type: 'route_resolution_accepted';
      routeId: string;
      effectiveModelId: string | null;
      source: HostResolutionSource;
    }
  | {
      type: 'substitution_refused';
      routeId: string;
      requestedModelOrAlias: string | null;
      attemptedModelId: string | null;
      source: HostResolutionSource;
      reason: string;
    }
  | {
      type: 'substitution_approved';
      routeId: string;
      change: RouteChangeRecord;
    }
  | {
      type: 'combination_member_resolved';
      routeId: string;
      memberModelId: string;
    }
  | {
      type: 'identity_not_exposed';
      routeId: string;
      statement: string;
    }
  | {
      type: 'prose_identity_claim_ignored';
      routeId: string;
      claimedModelId: string;
    };

export interface RouteResolutionOutcome {
  outcome: 'accepted' | 'refused' | 'substituted_with_approval';
  /** The model the council may proceed with. Null when refused. */
  effectiveModelId: string | null;
  /** Strongest identity level the structured evidence supports. */
  identityLevel: RouteIdentityLevel;
  /** Set when the underlying identity is hidden and must be disclosed. */
  identityStatement: string | null;
  changeRecord: RouteChangeRecord | null;
  events: RouteResolutionEvent[];
}

function refusedOutcome(
  selection: CouncilRouteSelection,
  attempt: HostResolutionAttempt,
  reason: string,
  events: RouteResolutionEvent[],
): RouteResolutionOutcome {
  events.push({
    type: 'substitution_refused',
    routeId: selection.routeId,
    requestedModelOrAlias: selection.requestedModelOrAlias,
    attemptedModelId: attempt.attemptedModelId,
    source: attempt.source,
    reason,
  });
  return {
    outcome: 'refused',
    effectiveModelId: null,
    identityLevel: selection.identityLevel,
    identityStatement: null,
    changeRecord: null,
    events,
  };
}

export function applyHostResolution(
  selection: CouncilRouteSelection,
  attempt: HostResolutionAttempt,
): RouteResolutionOutcome {
  const events: RouteResolutionEvent[] = [];

  // A prose claim is recorded as ignored and never consulted again below.
  if (attempt.proseClaimedModelId) {
    events.push({
      type: 'prose_identity_claim_ignored',
      routeId: selection.routeId,
      claimedModelId: attempt.proseClaimedModelId,
    });
  }

  const reported = attempt.reportedModelId ?? null;
  let identityLevel: RouteIdentityLevel = selection.identityLevel;
  if (
    reported !== null &&
    identityLevelRank(identityLevel) < identityLevelRank('reported_identity')
  ) {
    identityLevel = 'reported_identity';
  }

  if (selection.routeKind === 'combination') {
    return resolveCombination(selection, attempt, reported, identityLevel, events);
  }
  return resolveFixedModel(selection, attempt, reported, identityLevel, events);
}

function resolveFixedModel(
  selection: CouncilRouteSelection,
  attempt: HostResolutionAttempt,
  reported: string | null,
  identityLevel: RouteIdentityLevel,
  events: RouteResolutionEvent[],
): RouteResolutionOutcome {
  const requested = selection.requestedModelOrAlias;
  const attempted = attempt.attemptedModelId ?? reported;

  // The provider-reported identity conflicts with the requested model: the
  // requested and observed identities are kept distinct and the conflict is
  // surfaced, never smoothed over.
  if (reported !== null && requested !== null && reported !== requested) {
    return refusedOutcome(
      selection,
      { ...attempt, attemptedModelId: reported },
      'Provider-reported identity differs from the requested model for this fixed-model selection.',
      events,
    );
  }

  if (attempted !== null && requested !== null && attempted === requested) {
    events.push({
      type: 'route_resolution_accepted',
      routeId: selection.routeId,
      effectiveModelId: attempted,
      source: attempt.source,
    });
    return {
      outcome: 'accepted',
      effectiveModelId: attempted,
      identityLevel,
      identityStatement: null,
      changeRecord: null,
      events,
    };
  }

  if (attempted === null) {
    // The transport exposed no model at all. The selected route was used but
    // its identity is not independently exposed, and that must be said.
    events.push({
      type: 'identity_not_exposed',
      routeId: selection.routeId,
      statement: HIDDEN_IDENTITY_STATEMENT,
    });
    return {
      outcome: 'accepted',
      effectiveModelId: requested,
      identityLevel: selection.identityLevel,
      identityStatement: HIDDEN_IDENTITY_STATEMENT,
      changeRecord: null,
      events,
    };
  }

  // The host resolved a different model than the client selected.
  if (
    selection.fallbackPolicy === 'client_approved_only' &&
    attempt.approval
  ) {
    const change: RouteChangeRecord = {
      reason: attempt.approval.reason,
      originalRoute: selection.requestedRoute,
      replacementRoute: attempted,
      costImplications: attempt.approval.costImplication,
      newRouteRevision: selection.routeRevision + 1,
      approvalRef: attempt.approval.approvalRef,
    };
    events.push({ type: 'substitution_approved', routeId: selection.routeId, change });
    return {
      outcome: 'substituted_with_approval',
      effectiveModelId: attempted,
      identityLevel,
      identityStatement: null,
      changeRecord: change,
      events,
    };
  }

  return refusedOutcome(
    selection,
    attempt,
    selection.fallbackPolicy === 'none'
      ? 'Fallback policy is none: a fixed-model council selection may not be replaced.'
      : 'Fallback requires a client approval record for this session.',
    events,
  );
}

function resolveCombination(
  selection: CouncilRouteSelection,
  attempt: HostResolutionAttempt,
  reported: string | null,
  identityLevel: RouteIdentityLevel,
  events: RouteResolutionEvent[],
): RouteResolutionOutcome {
  const members = selection.combinationMembers ?? [];
  const exposedMember = attempt.attemptedModelId ?? reported;

  if (exposedMember !== null) {
    if (!members.includes(exposedMember)) {
      return refusedOutcome(
        selection,
        attempt,
        'Resolved model is not a member of the approved combination. ' +
          'A combination is not permission to add models or cross provider accounts.',
        events,
      );
    }
    events.push({
      type: 'combination_member_resolved',
      routeId: selection.routeId,
      memberModelId: exposedMember,
    });
    events.push({
      type: 'route_resolution_accepted',
      routeId: selection.routeId,
      effectiveModelId: exposedMember,
      source: attempt.source,
    });
    return {
      outcome: 'accepted',
      effectiveModelId: exposedMember,
      identityLevel,
      identityStatement: null,
      changeRecord: null,
      events,
    };
  }

  // The router hid the member identity. The combination stands, the member
  // is not invented, and the limitation is stated with the exact sentence.
  events.push({
    type: 'identity_not_exposed',
    routeId: selection.routeId,
    statement: HIDDEN_IDENTITY_STATEMENT,
  });
  return {
    outcome: 'accepted',
    effectiveModelId: null,
    identityLevel: selection.identityLevel,
    identityStatement: HIDDEN_IDENTITY_STATEMENT,
    changeRecord: null,
    events,
  };
}

// ---------------------------------------------------------------------------
// Client payload projection. A whitelist copy: only the fields a client may
// see, in a stable shape. Credential presence travels; values never exist in
// the selection, so they cannot leak here.
// ---------------------------------------------------------------------------

export function selectionClientPayload(selection: CouncilRouteSelection) {
  return {
    schema: selection.schema,
    routeId: selection.routeId,
    routeRevision: selection.routeRevision,
    routeKind: selection.routeKind,
    providerSlug: selection.providerSlug,
    requestedRoute: selection.requestedRoute,
    requestedModelOrAlias: selection.requestedModelOrAlias,
    combinationMembers: selection.combinationMembers
      ? [...selection.combinationMembers]
      : null,
    reasoning: { ...selection.reasoning },
    fallbackPolicy: selection.fallbackPolicy,
    providerAccountRef: selection.providerAccountRef,
    capability: {
      contextWindowTokens: selection.capabilitySnapshot.contextWindowTokens,
      maxOutputTokens: selection.capabilitySnapshot.maxOutputTokens,
      capabilities: [...selection.capabilitySnapshot.capabilities],
      supportedReasoningLevels: selection.capabilitySnapshot.supportedReasoningLevels
        ? [...selection.capabilitySnapshot.supportedReasoningLevels]
        : null,
    },
    credential: {
      state: selection.credential.state,
      envVar: selection.credential.envVar,
      source: selection.credential.source,
    },
    identityLevel: selection.identityLevel,
    companyId: selection.scope.companyId,
  };
}

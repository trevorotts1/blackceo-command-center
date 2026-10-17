/**
 * Council of Wise Elders: explicit route catalog (CWE-008).
 *
 * Directive Section 13 (model routes and identity) and binding B08: the
 * scheduler imports `resolveProviderApiKey` from `src/lib/provider-key-detection`
 * and `ALL_PROVIDERS` from `src/lib/model-providers`. CWE-008 adds ONLY the
 * council's explicit route-selection adapter over those host functions. This
 * module never selects a model, never runs a cascade, and never changes any
 * unrelated department's vendor or cascade policy.
 *
 * Model law: this module prescribes no named model anywhere. The client
 * selects a route, or their configured default applies; this catalog only
 * describes the routes the installation has configured.
 *
 * Secret law: credential VALUES never enter any structure this module emits.
 * `resolveProviderApiKey` returns the resolved value to its caller; the
 * wrapper below reads only presence, the env-var NAME, and the store label,
 * and lets the value fall out of scope. Catalog entries, selection snapshots,
 * events, and client payloads built from them carry presence only.
 *
 * Identity law (Section 13.4): route identity has five distinct levels and
 * they are never conflated. A successful request is not proof of a particular
 * backend model, and runtime identity is never inferred from a model's own
 * prose response.
 */

import { ALL_PROVIDERS, getProvider } from '../model-providers';
import type { ModelProvider } from '../model-providers/types';
import { resolveProviderApiKey } from '../provider-key-detection';
import type { ModelRegistryEntry } from '../model-registry-types';

// ---------------------------------------------------------------------------
// Route identity levels (Section 13.4). Ordered weakest to strongest.
// ---------------------------------------------------------------------------

export const ROUTE_IDENTITY_LEVELS = [
  'configured',
  'transport_probed',
  'reported_identity',
  'resolved_identity_verified',
  'quality_qualified',
] as const;
export type RouteIdentityLevel = (typeof ROUTE_IDENTITY_LEVELS)[number];

export function identityLevelRank(level: RouteIdentityLevel): number {
  return ROUTE_IDENTITY_LEVELS.indexOf(level);
}

/**
 * The exact statement the product must show when a router hides the
 * underlying model identity (Section 13.4).
 */
export const HIDDEN_IDENTITY_STATEMENT =
  'Selected route used; underlying model identity not independently exposed.';

// ---------------------------------------------------------------------------
// Route kinds. A fixed-model route names one model. A combination route is an
// intentionally selected router combination (for example a 9Router
// combination): it may select among its configured members only, and it is
// never permission to add models, reorder members, or cross provider
// accounts.
// ---------------------------------------------------------------------------

export type RouteKind = 'fixed_model' | 'combination';

// ---------------------------------------------------------------------------
// Credential presence. Names and presence only, never a value.
// ---------------------------------------------------------------------------

export type CredentialSourceName =
  | 'process.env'
  | 'env_file'
  | 'openclaw_json'
  | 'openclaw_auth_store';

export interface CredentialPresence {
  state: 'present' | 'absent' | 'not_required';
  /** Env-var NAME the credential was found under. Never the value. */
  envVar: string | null;
  /** Store the credential was found in. Never the value. */
  source: CredentialSourceName | null;
  /** Candidate env-var names checked when absent. Names only. */
  checked: string[];
}

/**
 * Resolve credential presence for a host provider connector through the B08
 * host resolver, discarding the value inside this function scope. The value
 * returned by `resolveProviderApiKey` is never copied, logged, or returned.
 */
export function credentialPresenceFor(provider: ModelProvider): CredentialPresence {
  const result = resolveProviderApiKey(provider);
  if ('localEndpoint' in result) {
    return { state: 'not_required', envVar: null, source: null, checked: [] };
  }
  if (result.found) {
    // Deliberately read only `envVar` and `source`. `result.value` is never
    // touched beyond this point and leaves scope with this call frame.
    return {
      state: 'present',
      envVar: result.envVar,
      source: result.source,
      checked: [],
    };
  }
  return { state: 'absent', envVar: null, source: null, checked: [...result.checked] };
}

/** Credential presence for a provider slug registered in the host registry. */
export function credentialPresenceForSlug(slug: string): CredentialPresence | null {
  const provider = getProvider(slug);
  if (!provider) return null;
  return credentialPresenceFor(provider);
}

// ---------------------------------------------------------------------------
// Capability snapshot. Frozen onto a selection at selection time (Section
// 13.3): the weekly model refresh can deprecate or rewrite catalog rows, so
// a session never re-reads live catalog facts at execution time.
// ---------------------------------------------------------------------------

export interface RouteCapabilitySnapshot {
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  capabilities: string[];
  /**
   * Reasoning levels the route is documented or probed to support, in the
   * route's own vocabulary. Null means not yet probed: support is unknown and
   * no preference may be claimed active.
   */
  supportedReasoningLevels: string[] | null;
}

// ---------------------------------------------------------------------------
// Route descriptors: the configured-route facts a catalog is built from.
// ---------------------------------------------------------------------------

export interface ProviderRouteDescriptor {
  /** Stable route reference, unique within the installation. */
  routeId: string;
  providerSlug: string;
  displayLabel: string;
  kind: RouteKind;
  /** The one named model for a fixed_model route. Null for combinations. */
  modelId: string | null;
  /**
   * Ordered, pinned member model ids for a combination route. The approved
   * combination is exactly this list. Empty for fixed_model routes.
   */
  combinationMembers: string[];
  /**
   * Opaque reference to the provider account this route is bound to (an
   * account id or label in the host's own terms). Never a credential value.
   */
  providerAccountRef: string | null;
  capability: RouteCapabilitySnapshot;
  credential: CredentialPresence;
}

/**
 * Build a fixed-model route descriptor from a host `model_registry` row.
 * The row is an input: this module does not read the database, so a caller
 * passes rows from the store it owns and the facts are frozen at build time.
 */
export function routeDescriptorFromRegistryEntry(
  entry: ModelRegistryEntry,
  credential: CredentialPresence,
): ProviderRouteDescriptor {
  return {
    routeId: entry.model_id,
    providerSlug: entry.provider,
    displayLabel: entry.label,
    kind: 'fixed_model',
    modelId: entry.model_id,
    combinationMembers: [],
    providerAccountRef: null,
    capability: {
      contextWindowTokens: entry.context_window,
      maxOutputTokens: null,
      capabilities: [...entry.capabilities],
      supportedReasoningLevels: null,
    },
    credential,
  };
}

/** Descriptors for every provider connector the host has registered (B08). */
export function hostProviderSlugs(): string[] {
  return ALL_PROVIDERS.map((p) => p.slug);
}

// ---------------------------------------------------------------------------
// Readiness and qualification evidence. Supplied by probe and evaluation
// owners (CWE-009 probes, CWE-042 qualification). CWE-008 defines how the
// evidence maps to labels; it does not fabricate evidence.
// ---------------------------------------------------------------------------

export interface RouteEvidence {
  /** A real transport probe reached the endpoint for this route. */
  transportProbed: boolean;
  /** Identity the transport or provider reported, when it exposes one. */
  reportedModelId: string | null;
  /** Independent identity verification record, when one exists. */
  identityVerification: { verified: boolean; method: string } | null;
  /** Recorded quality evaluation, when one exists. */
  evaluation: {
    status: 'passed' | 'failed' | 'not_run';
    evaluationId: string | null;
    recordedAt: string | null;
  } | null;
}

export const NO_ROUTE_EVIDENCE: RouteEvidence = {
  transportProbed: false,
  reportedModelId: null,
  identityVerification: null,
  evaluation: null,
};

/**
 * Route readiness for the surface the UI units consume. A route that is
 * merely listed is UNTESTED. A transport probe raises it to PROBED, which is
 * still not qualified. Only a recorded, passing evaluation makes a route
 * QUALIFIED.
 */
export type RouteReadiness = 'UNTESTED' | 'PROBED' | 'QUALIFIED';

export function deriveRouteReadiness(evidence: RouteEvidence): RouteReadiness {
  if (evidence.evaluation?.status === 'passed') return 'QUALIFIED';
  if (evidence.transportProbed) return 'PROBED';
  return 'UNTESTED';
}

/**
 * The strongest identity level the evidence supports, and no stronger. An
 * evaluation pass is required for `quality_qualified`; a provider report
 * alone never reaches `resolved_identity_verified`.
 */
export function deriveIdentityLevel(evidence: RouteEvidence): RouteIdentityLevel {
  if (evidence.evaluation?.status === 'passed') return 'quality_qualified';
  if (evidence.identityVerification?.verified) return 'resolved_identity_verified';
  if (evidence.reportedModelId) return 'reported_identity';
  if (evidence.transportProbed) return 'transport_probed';
  return 'configured';
}

// ---------------------------------------------------------------------------
// The catalog: safe route references plus qualification states (build step
// 1). Every field here is client-safe: no credential values, no secrets, no
// server paths.
// ---------------------------------------------------------------------------

export interface RouteCatalogEntry {
  routeId: string;
  providerSlug: string;
  displayLabel: string;
  kind: RouteKind;
  modelId: string | null;
  combinationMembers: string[];
  providerAccountRef: string | null;
  capability: RouteCapabilitySnapshot;
  credential: CredentialPresence;
  identityLevel: RouteIdentityLevel;
  readiness: RouteReadiness;
  /** True only when a recorded evaluation passed. Listed is not qualified. */
  qualityQualified: boolean;
}

/**
 * Recorded probe evidence for the catalog (CWE-045). The composed
 * probe (model-probe.ts) journals a route_probe_recorded event on the
 * grant's session for every dispatched probe, carrying the
 * RouteEvidence it derived. This reader folds those events for one
 * tenant/company scope into the evidence map buildRouteCatalog
 * consumes: the latest probe per route wins for transport and
 * reported identity. Probes never record evaluations, so this map can
 * raise a route to PROBED (and its identity to what the provider
 * reported) but never to QUALIFIED.
 */
export function recordedRouteEvidence(
  db: import('better-sqlite3').Database,
  scope: { tenant_id: string; company_id: string },
): Map<string, RouteEvidence> {
  const rows = db
    .prepare(
      `SELECT payload_json, created_at FROM council_events
        WHERE tenant_id = ? AND company_id = ? AND type = 'operation_completed'
          AND payload_json LIKE '%"action":"route_probe_recorded"%'
        ORDER BY created_at ASC`,
    )
    .all(scope.tenant_id, scope.company_id) as Array<{
    payload_json: string;
    created_at: string;
  }>;
  const evidence = new Map<string, RouteEvidence>();
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (payload.action !== 'route_probe_recorded') continue;
    const routeId = payload.route_id;
    const recorded = payload.evidence as RouteEvidence | undefined;
    if (typeof routeId !== 'string' || !recorded) continue;
    evidence.set(routeId, {
      transportProbed: recorded.transportProbed === true,
      reportedModelId:
        typeof recorded.reportedModelId === 'string' ? recorded.reportedModelId : null,
      identityVerification: null,
      evaluation: null,
    });
  }
  return evidence;
}

export function buildRouteCatalog(
  routes: ProviderRouteDescriptor[],
  evidenceByRouteId: ReadonlyMap<string, RouteEvidence> = new Map(),
): RouteCatalogEntry[] {
  return routes.map((route) => {
    const evidence = evidenceByRouteId.get(route.routeId) ?? NO_ROUTE_EVIDENCE;
    const readiness = deriveRouteReadiness(evidence);
    return {
      routeId: route.routeId,
      providerSlug: route.providerSlug,
      displayLabel: route.displayLabel,
      kind: route.kind,
      modelId: route.modelId,
      combinationMembers: [...route.combinationMembers],
      providerAccountRef: route.providerAccountRef,
      capability: {
        contextWindowTokens: route.capability.contextWindowTokens,
        maxOutputTokens: route.capability.maxOutputTokens,
        capabilities: [...route.capability.capabilities],
        supportedReasoningLevels: route.capability.supportedReasoningLevels
          ? [...route.capability.supportedReasoningLevels]
          : null,
      },
      credential: {
        state: route.credential.state,
        envVar: route.credential.envVar,
        source: route.credential.source,
        checked: [...route.credential.checked],
      },
      identityLevel: deriveIdentityLevel(evidence),
      readiness,
      qualityQualified: readiness === 'QUALIFIED',
    };
  });
}

export function findCatalogEntry(
  catalog: RouteCatalogEntry[],
  routeId: string,
): RouteCatalogEntry | null {
  return catalog.find((entry) => entry.routeId === routeId) ?? null;
}

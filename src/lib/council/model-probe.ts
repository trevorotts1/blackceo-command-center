/**
 * Council model route probe (CWE-045 graduation of council.models.probe;
 * directive Sections 17.2, 17.5, 25.6; contracts T142 family).
 *
 * CWE-050 left this endpoint FEATURE_NOT_READY because no probe
 * executor existed in this tree. This module is that executor, composed
 * at the CWE-045 integration line from services that already exist:
 *
 * - The route reference resolves against the CWE-008 catalog built
 *   from the host model registry (providers.ts), the same catalog the
 *   models endpoint serves. An unknown route is a typed 404.
 * - The caller presents a purpose-bound CWE-049 grant. The grant must
 *   resolve active, carry purpose 'capability_probe', and pin the
 *   exact route being probed; every mismatch is the run-authorization
 *   service's own typed refusal (RUN_GRANT_PURPOSE_MISMATCH,
 *   RUN_GRANT_ROUTE_MISMATCH, RUN_GRANT_NOT_FOUND).
 * - The probe operation is admitted through the SAME service
 *   (admitOperation, kind 'provider_request'), reserving once under
 *   the operation key derived from the request's idempotency key, and
 *   settled through recordConsumption: a clean answer settles at the
 *   recorded actual (probes carry no metered price in this host, so
 *   the settled money actual is 0 with token counts on the attempt
 *   record); an ambiguous transport failure records outcome 'unknown'
 *   so the reservation stays counted at estimate, never free
 *   (Section 15.9 doctrine).
 * - The transport is the host provider connector's own
 *   chatCompletion: one minimal request (a single short message,
 *   max_tokens 1) through the route's provider. The credential VALUE
 *   is resolved server-side through the host key detection and used
 *   only as the connector call's argument; it is never stored,
 *   journaled, logged, or returned (CWE-008 presence-only law for
 *   everything client-visible). A route whose credential is absent,
 *   or whose connector exposes no completion transport, is refused
 *   BEFORE admission: nothing was dispatched, so nothing is charged
 *   and no evidence is recorded.
 * - The outcome is recorded twice: a council_provider_attempts row
 *   (the canonical attempt accounting) and a route_probe_recorded
 *   journal event carrying the RouteEvidence, which the CWE-008
 *   catalog merges as recorded evidence (providers.ts
 *   recordedRouteEvidence), so a probed route reads PROBED in the
 *   catalog afterwards. A probe never creates an evaluation record,
 *   so it can never make a route QUALIFIED or raise identity past
 *   what the provider itself reported.
 */

import { randomUUID } from 'node:crypto';
import { canonicalHash } from './contracts';
import type { CouncilPrincipal } from './auth';
import type { CouncilRouteContext } from './api/foundation';
import { CouncilApiError, idempotencyConflict, schemaValidation } from './api/errors';
import {
  CouncilRunAuthorizationError,
  CouncilRunAuthorizationService,
} from './run-authorization';
import { envelopeFromScope } from './store';
import {
  buildRouteCatalog,
  credentialPresenceForSlug,
  deriveIdentityLevel,
  deriveRouteReadiness,
  routeDescriptorFromRegistryEntry,
  type RouteCatalogEntry,
  type RouteEvidence,
} from './providers';
import { appendKanbanJournalEvent, listKanbanJournalEntries } from './kanban/journal';
import { listModels } from '@/lib/model-registry';
import { getProvider } from '@/lib/model-providers';
import { resolveProviderApiKey } from '@/lib/provider-key-detection';

export const PROBE_OPERATION = 'council.models.probe';
const PROBE_SOURCE = 'council-api';
const PROBE_PROMPT = 'Reply with the single word: ready.';
const PROBE_TIMEOUT_MS = 8_000;

export type ProbeOutcome = 'answered' | 'failed' | 'unknown';

export interface ModelProbeResult {
  route_id: string;
  provider_slug: string;
  model_id: string | null;
  grant_id: string;
  session_id: string;
  operation_id: string;
  probe_outcome: ProbeOutcome;
  failure_code: string | null;
  evidence: RouteEvidence;
  identity_level: ReturnType<typeof deriveIdentityLevel>;
  readiness: ReturnType<typeof deriveRouteReadiness>;
  usage: { input_tokens: number | null; output_tokens: number | null };
  probed_at: string;
  replayed: boolean;
}

/** What one dispatched probe transport reports back. */
export interface ProbeTransportReport {
  reportedModelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type ProbeTransport = (route: {
  providerSlug: string;
  modelId: string;
}) => Promise<ProbeTransportReport>;

export interface CouncilModelProbeDeps {
  runAuthorization?: CouncilRunAuthorizationService;
  transport?: ProbeTransport;
  catalog?: () => RouteCatalogEntry[];
  now?: () => string;
  newId?: () => string;
  timeoutMs?: number;
}

function catalogEntries(): RouteCatalogEntry[] {
  const descriptors = listModels().map((model) =>
    routeDescriptorFromRegistryEntry(
      model,
      credentialPresenceForSlug(model.provider) ?? {
        state: 'absent',
        envVar: null,
        source: null,
        checked: [],
      },
    ),
  );
  return buildRouteCatalog(descriptors);
}

/** A transport failure whose HTTP status is known: the provider answered and refused. */
function httpStatusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as Record<string, unknown>;
  for (const key of ['status', 'httpStatus', 'statusCode']) {
    if (typeof record[key] === 'number') return record[key] as number;
  }
  const message = error instanceof Error ? error.message : '';
  const match = /\b([45]\d\d)\b/.exec(message);
  return match ? Number(match[1]) : null;
}

/**
 * The default composed transport: the host provider connector for the
 * route's provider slug. Dispatchability (connector present, exposes
 * chatCompletion, credential resolvable) is checked by the service
 * before admission through probeDispatchability; this function is
 * only called for a dispatchable route.
 */
async function hostConnectorTransport(route: {
  providerSlug: string;
  modelId: string;
}): Promise<ProbeTransportReport> {
  const provider = getProvider(route.providerSlug);
  if (!provider?.chatCompletion) {
    throw new Error(`Provider ${route.providerSlug} exposes no completion transport.`);
  }
  const keyResult = resolveProviderApiKey(provider);
  let apiKey: string | null = null;
  if ('localEndpoint' in keyResult) {
    apiKey = '';
  } else if (keyResult.found) {
    // The value is used only as this call's argument. It is never
    // stored, journaled, logged, or returned (CWE-008).
    apiKey = keyResult.value;
  }
  if (apiKey === null) {
    throw new Error(`No credential is configured for provider ${route.providerSlug}.`);
  }
  const response = await provider.chatCompletion(apiKey, {
    model: route.modelId,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    max_tokens: 1,
  });
  return {
    reportedModelId: typeof response.model === 'string' ? response.model : null,
    inputTokens: response.usage?.prompt_tokens ?? null,
    outputTokens: response.usage?.completion_tokens ?? null,
  };
}

/**
 * Why a route cannot be probed at all, checked BEFORE any budget is
 * reserved: no connector, no completion transport on the connector,
 * or no configured credential. Returns null when the route is
 * dispatchable.
 */
export function probeRefusal(route: RouteCatalogEntry): { code: string; message: string } | null {
  const provider = getProvider(route.providerSlug);
  if (!provider) {
    return {
      code: 'COUNCIL_ROUTE_NOT_CONFIGURED',
      message: `No provider connector is registered for ${route.providerSlug}; route ${route.routeId} cannot be probed.`,
    };
  }
  if (!provider.chatCompletion) {
    return {
      code: 'COUNCIL_ROUTE_TRANSPORT_UNSUPPORTED',
      message:
        `The ${route.providerSlug} connector exposes no completion transport, so route ${route.routeId} ` +
        'cannot be probed through the composed path. No probe was dispatched and no evidence was recorded.',
    };
  }
  if (provider.authType !== 'local_endpoint' && route.credential.state !== 'present') {
    return {
      code: 'COUNCIL_ROUTE_CREDENTIAL_ABSENT',
      message:
        `No credential is configured for provider ${route.providerSlug} (presence check only; no value was read). ` +
        'A probe is not dispatched without the route credential, and no evidence was recorded.',
    };
  }
  return null;
}

/** Translate run-authorization refusals with the composed-services status mapping. */
function translateProbeError(error: unknown): never {
  if (error instanceof CouncilRunAuthorizationError) {
    const notFound = ['RUN_SESSION_NOT_FOUND', 'RUN_PREVIEW_NOT_FOUND', 'RUN_GRANT_NOT_FOUND', 'BUDGET_RESERVATION_NOT_FOUND'];
    const badRequest = ['RUN_INVALID_INPUT', 'RUN_MONEY_UNBOUNDED'];
    const forbidden = [
      'RUN_AUTHORIZATION_REQUIRED',
      'RUN_AUTHORITY_MODE_MISMATCH',
      'RUN_GRANT_SCOPE_MISMATCH',
      'RUN_GRANT_ROUTE_MISMATCH',
      'RUN_GRANT_PURPOSE_MISMATCH',
      'RUN_GRANT_KIND_NOT_ALLOWED',
      'RUN_OPERATION_GRANT_MISMATCH',
    ];
    const status = notFound.includes(error.code)
      ? 404
      : badRequest.includes(error.code)
        ? 400
        : forbidden.includes(error.code)
          ? 403
          : 409;
    throw new CouncilApiError(error.code, error.message, {
      status,
      retryable: error.code === 'BUDGET_EXHAUSTED',
      action: status === 404 ? 'check_reference' : status === 400 ? 'fix_request' : 'reload_and_retry',
    });
  }
  throw error;
}

export class CouncilModelProbeService {
  private readonly runAuthorization: CouncilRunAuthorizationService;
  private readonly transport: ProbeTransport;
  private readonly catalog: () => RouteCatalogEntry[];
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly timeoutMs: number;

  constructor(
    private readonly ctx: CouncilRouteContext,
    deps: CouncilModelProbeDeps = {},
  ) {
    this.runAuthorization =
      deps.runAuthorization ?? new CouncilRunAuthorizationService({ store: ctx.store });
    this.transport = deps.transport ?? hostConnectorTransport;
    this.catalog = deps.catalog ?? catalogEntries;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
    this.timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  }

  /** The recorded result of an earlier probe under this operation key, if any. */
  private recordedResult(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    operationId: string,
  ): ModelProbeResult | null {
    const entries = listKanbanJournalEntries(this.ctx.store.handle(), scope, sessionId);
    for (const entry of entries) {
      if (entry.action !== 'route_probe_recorded') continue;
      if (entry.payload.operation_id !== operationId) continue;
      const evidence = entry.payload.evidence as RouteEvidence;
      return {
        route_id: String(entry.payload.route_id),
        provider_slug: String(entry.payload.provider_slug),
        model_id: (entry.payload.model_id as string | null) ?? null,
        grant_id: String(entry.payload.grant_id),
        session_id: sessionId,
        operation_id: operationId,
        probe_outcome: entry.payload.probe_outcome as ProbeOutcome,
        failure_code: (entry.payload.failure_code as string | null) ?? null,
        evidence,
        identity_level: deriveIdentityLevel(evidence),
        readiness: deriveRouteReadiness(evidence),
        usage: entry.payload.usage as ModelProbeResult['usage'],
        probed_at: String(entry.payload.probed_at),
        replayed: true,
      };
    }
    return null;
  }

  async probe(input: {
    route_id: string;
    grant_id: string;
    idempotency_key: string;
  }): Promise<ModelProbeResult> {
    const principal: CouncilPrincipal = this.ctx.principal;
    const scope = {
      tenant_id: principal.scope.tenant_id,
      company_id: principal.scope.company_id,
    };

    // 1. The route reference resolves against the CWE-008 catalog.
    const route = this.catalog().find((entry) => entry.routeId === input.route_id);
    if (!route) {
      throw new CouncilApiError(
        'COUNCIL_ROUTE_NOT_FOUND',
        `No route ${input.route_id} exists in the council route catalog for this installation.`,
        { status: 404, action: 'check_reference' },
      );
    }
    if (route.kind !== 'fixed_model' || !route.modelId) {
      throw new CouncilApiError(
        'COUNCIL_ROUTE_NOT_PROBEABLE',
        `Route ${route.routeId} is a ${route.kind} route; the probe binds one fixed route and one named model.`,
        { status: 422, action: 'fix_request' },
      );
    }

    // 2. The capability_probe grant resolves, binds the purpose, and
    // pins this exact route (the service's own typed refusals).
    let grant: ReturnType<CouncilRunAuthorizationService['resolveRunGrant']>;
    let record: ReturnType<CouncilRunAuthorizationService['loadGrantRecord']>;
    try {
      grant = this.runAuthorization.resolveRunGrant(principal, input.grant_id);
      record = this.runAuthorization.loadGrantRecord(principal, input.grant_id);
    } catch (error) {
      translateProbeError(error);
    }
    if (!grant || !record || record.proof.stage !== 'granted' || record.session_id === null) {
      throw new CouncilApiError(
        'RUN_GRANT_NOT_FOUND',
        `No active granted run grant ${input.grant_id} resolves in this scope for a probe.`,
        { status: 404, action: 'check_reference' },
      );
    }
    if (grant.purpose !== 'capability_probe') {
      throw new CouncilApiError(
        'RUN_GRANT_PURPOSE_MISMATCH',
        `Grant ${input.grant_id} carries purpose ${grant.purpose}; a model probe requires a capability_probe grant (Section 25.6).`,
        { status: 403, action: 'check_authorization' },
      );
    }
    const sessionId = record.session_id;
    const snapshot = record.proof.route_snapshot;
    if (!snapshot || snapshot.routeId !== route.routeId) {
      throw new CouncilApiError(
        'RUN_GRANT_ROUTE_MISMATCH',
        `Grant ${input.grant_id} does not pin route ${route.routeId}; a probe runs only against the route its grant approved.`,
        { status: 403, action: 'check_authorization' },
      );
    }

    const operationId = `council-probe:${input.grant_id}:${input.idempotency_key}`;

    // 3. Idempotent replay: a recorded probe under this key answers
    // again without a second dispatch or a second reservation.
    const recorded = this.recordedResult(scope, sessionId, operationId);
    if (recorded) return recorded;

    const fingerprint = canonicalHash({
      operation: PROBE_OPERATION,
      route_id: route.routeId,
      grant_id: input.grant_id,
    });
    const claim = this.ctx.repositories.claimRequestKey({
      tenantId: scope.tenant_id,
      source: PROBE_SOURCE,
      operation: PROBE_OPERATION,
      requestKey: input.idempotency_key,
      payloadFingerprint: fingerprint,
      sessionId,
    });
    if (claim.outcome === 'conflict') throw idempotencyConflict(PROBE_OPERATION);

    // 4. Dispatchability before admission: an undispatched probe
    // consumes no budget and records no evidence.
    const refusal = probeRefusal(route);
    if (refusal) {
      throw new CouncilApiError(refusal.code, refusal.message, {
        status: 422,
        action: 'fix_configuration',
      });
    }

    // 5. Admit under the grant: one provider_request reservation.
    const envelope = envelopeFromScope(principal.scope, principal.subject, 'owner', 'write');
    const session = this.ctx.repositories.getSession(envelope, sessionId);
    if (!session) {
      throw new CouncilApiError(
        'RUN_SESSION_NOT_FOUND',
        `Session ${sessionId} bound to grant ${input.grant_id} is not visible in this scope.`,
        { status: 404, action: 'check_reference' },
      );
    }
    const currency = record.currency ?? record.proof.ceilings.max_money?.currency ?? undefined;
    try {
      this.runAuthorization.admitOperation(principal, {
        grant_id: input.grant_id,
        session_id: sessionId,
        operation_id: operationId,
        kind: 'provider_request',
        purpose: 'capability_probe',
        estimate_minor: 0,
        currency,
        lease_epoch: session.state.lease_epoch,
        route_snapshot: snapshot,
      });
    } catch (error) {
      translateProbeError(error);
    }

    // 6. Dispatch the one minimal probe request.
    let report: ProbeTransportReport | null = null;
    let failure: { code: string; known: boolean } | null = null;
    try {
      report = await Promise.race([
        this.transport({ providerSlug: route.providerSlug, modelId: route.modelId }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`Probe transport timed out after ${this.timeoutMs} ms.`)),
            this.timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      const status = httpStatusOf(error);
      failure = {
        code: status !== null ? `TRANSPORT_HTTP_${status}` : 'TRANSPORT_ERROR',
        known: status !== null,
      };
    }

    const probedAt = this.now();
    const evidence: RouteEvidence = {
      transportProbed: true,
      reportedModelId: report?.reportedModelId ?? null,
      identityVerification: null,
      evaluation: null,
    };
    const probeOutcome: ProbeOutcome = report ? 'answered' : failure?.known ? 'failed' : 'unknown';
    const usage = {
      input_tokens: report?.inputTokens ?? null,
      output_tokens: report?.outputTokens ?? null,
    };

    // 7. Settle the reservation: answered and known-refused probes
    // settle at the recorded money actual (0; the probe's token usage
    // rides the attempt record). An ambiguous failure stays counted
    // at estimate under outcome 'unknown', never free.
    try {
      this.runAuthorization.recordConsumption(principal, {
        grant_id: input.grant_id,
        session_id: sessionId,
        operation_id: operationId,
        lease_epoch: session.state.lease_epoch,
        outcome: probeOutcome === 'unknown' ? 'unknown' : 'settled',
        ...(probeOutcome === 'unknown' ? {} : { actual_minor: 0 }),
      });
    } catch (error) {
      translateProbeError(error);
    }

    // 8. Record the attempt and the route evidence event atomically.
    const db = this.ctx.store.handle();
    const attemptStatus =
      probeOutcome === 'answered'
        ? 'accepted'
        : probeOutcome === 'failed'
          ? 'failed'
          : 'provider_completion_unknown';
    db.transaction(() => {
      db.prepare(
        `INSERT INTO council_provider_attempts
           (tenant_id, company_id, session_id, id, job_id, operation_id, seat_id, round,
            provider_id, provider_config_version, model_ref, model_selection_source, status,
            outcome_code, retry_safe, input_tokens, output_tokens, actual_cost_minor, currency,
            request_hash, response_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, 0, ?, 'model_registry', ?, 'explicit', ?, ?, 0, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      ).run(
        scope.tenant_id,
        scope.company_id,
        sessionId,
        this.newId(),
        operationId,
        route.providerSlug,
        route.modelId,
        attemptStatus,
        failure?.code ?? null,
        usage.input_tokens,
        usage.output_tokens,
        canonicalHash({ route_id: route.routeId, model: route.modelId, prompt: PROBE_PROMPT }),
        report ? canonicalHash({ reported: report.reportedModelId, usage }) : null,
        probedAt,
        probedAt,
      );
      appendKanbanJournalEvent(db, scope, sessionId, {
        eventId: this.newId(),
        actorSubject: principal.subject,
        action: 'route_probe_recorded',
        createdAt: probedAt,
        data: {
          route_id: route.routeId,
          provider_slug: route.providerSlug,
          model_id: route.modelId,
          grant_id: input.grant_id,
          operation_id: operationId,
          probe_outcome: probeOutcome,
          failure_code: failure?.code ?? null,
          evidence,
          usage,
          probed_at: probedAt,
          authorization: { permission: 'run' },
        },
      });
    }).immediate();

    return {
      route_id: route.routeId,
      provider_slug: route.providerSlug,
      model_id: route.modelId,
      grant_id: input.grant_id,
      session_id: sessionId,
      operation_id: operationId,
      probe_outcome: probeOutcome,
      failure_code: failure?.code ?? null,
      evidence,
      identity_level: deriveIdentityLevel(evidence),
      readiness: deriveRouteReadiness(evidence),
      usage,
      probed_at: probedAt,
      replayed: false,
    };
  }
}

/** Route-facing entry: strict body discipline, then the service. */
export async function probeModelRoute(
  ctx: CouncilRouteContext,
  body: Record<string, unknown>,
  idempotencyKey: string,
  deps: CouncilModelProbeDeps = {},
): Promise<ModelProbeResult> {
  for (const key of Object.keys(body)) {
    if (!['route_id', 'grant_id', 'idempotency_key'].includes(key)) {
      throw schemaValidation(
        `Unexpected field "${key}" in the model probe request. The probe contract accepts only route_id, grant_id, and idempotency_key; a client cannot name a credential, an endpoint, or a scope through it.`,
      );
    }
  }
  if (typeof body.route_id !== 'string' || body.route_id.trim().length === 0) {
    throw schemaValidation('route_id must be the catalog route reference returned by the models endpoint.');
  }
  if (typeof body.grant_id !== 'string' || body.grant_id.trim().length === 0) {
    throw schemaValidation('grant_id must reference an approved capability_probe run grant.');
  }
  const service = new CouncilModelProbeService(ctx, deps);
  return service.probe({
    route_id: body.route_id,
    grant_id: body.grant_id,
    idempotency_key: idempotencyKey,
  });
}

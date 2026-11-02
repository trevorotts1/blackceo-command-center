import { NextResponse, type NextRequest } from 'next/server';
import {
  authorizeSessionMutate,
  checkBodyScope,
  handleCouncil,
  modelsCatalogData,
  parseJsonBody,
  requireMutationProof,
} from '@/lib/council/api/foundation';
import { assertNoConfiguredSecretsInPayload } from '@/lib/council/auth';
import {
  CouncilApiError,
  schemaValidation,
  translateError,
} from '@/lib/council/api/errors';
import { createDraftSession, parseDraftInput } from '@/lib/council/api/drafts';
import {
  approveRunAuthorization,
  getRunAuthorizationStatus,
  previewRunAuthorization,
  startSessionRun,
} from '@/lib/council/composed-services';
import {
  CONTRACT_PACKAGE_VERSION,
  SEAT_IDS,
  canonicalHash,
  type DecisionBrief,
} from '@/lib/council/contracts';
import {
  CouncilSelectionError,
  createRouteSelection,
  type CouncilRouteSelection,
} from '@/lib/council/explicit-selection';
import {
  canonicalRouteIdForModel,
  findCatalogEntryByCanonicalRouteId,
  type RouteCatalogEntry,
} from '@/lib/council/providers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/convene (CTR-191 canonical composer contract).
 *
 * The canonical chamber's New-question dialog posts
 * `{brief, route_id, requested_by, model?}` and treats HTTP 202 with a
 * top-level `session_id` as success (public/chamber/chamber-shell.js
 * submitComposer). This adapter honors that contract against the Command
 * Center's own managed store and trust boundary:
 *
 *   1. The trusted principal, tenant, company and installation come only
 *      from resolveCouncilPrincipal/checkBodyScope. A caller-supplied scope,
 *      route snapshot, signature, authority mode, ceiling or grant is not
 *      accepted; the body is a strict allowlist.
 *   2. The route is resolved from THIS installation's catalog. The exact
 *      configured model is pinned; a mismatch refuses rather than
 *      substituting. Fallback policy is 'none'.
 *   3. The explicit POST is the user's start gesture. It creates the draft,
 *      runs the existing previewRunAuthorization -> approveRunAuthorization
 *      owner flow, then startSessionRun. The approval is a managed-principal
 *      grant over a session the caller actually owns (authorizeSessionMutate
 *      runs first). A bare question with no route never approves anything.
 *   4. The response returns the canonical session id and links before any
 *      council work. The durable council_run job is the handoff; the
 *      existing run worker is kicked in the background and is never awaited
 *      in the request.
 */

const TOP_LEVEL_FIELDS = [
  'brief',
  'route_id',
  'requested_by',
  'model',
  'idempotency_key',
] as const;

const BRIEF_FIELDS = [
  'schema_version',
  'brief_id',
  'session_id',
  'revision',
  'question',
  'facts',
  'assumptions',
  'unknowns',
  'constraints',
  'options',
  'relevance_weights',
  'critical_domains',
  'evidence_manifest',
  'private_preference_ref',
  'created_at',
  'display_timezone',
] as const;

const MAX_QUESTION = 600;
const MAX_OPTION_LABEL = 200;
const MAX_OPTIONS = 4;
const MAX_IDEMPOTENCY_KEY = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  operation: string,
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw schemaValidation(
        `Unknown field "${key}" in the ${operation} request. The ${operation} contract accepts only: ${allowed.join(', ')}.`,
      );
    }
  }
}

function boundedString(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw schemaValidation(`Field "${field}" is required.`);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw schemaValidation(`Field "${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw schemaValidation(`Field "${field}" must not be empty.`);
    return undefined;
  }
  if (trimmed.length > max) {
    throw schemaValidation(`Field "${field}" must be at most ${max} characters.`);
  }
  return trimmed;
}

function boundedArray(
  value: unknown,
  field: string,
  max: number,
): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw schemaValidation(`Field "${field}" must be an array when present.`);
  }
  if (value.length > max) {
    throw schemaValidation(`Field "${field}" must contain at most ${max} entries.`);
  }
  return value;
}

function recoveryFor(action: string): string {
  switch (action) {
    case 'refresh_csrf_token':
      return 'Reload the page, then press Convene again.';
    case 'fix_request':
      return 'Check the question, the options and the route, then try again.';
    case 'sign_in':
    case 'check_authorization':
    case 'contact_owner':
      return 'Sign in with the account that owns this Command Center, then try again.';
    case 'reload_and_retry':
      return 'Reload the page and try again.';
    case 'wait_for_verdict':
      return 'Wait for the council to finish, then try again.';
    default:
      return 'Open the service status page, then try again.';
  }
}

function canonicalFailure(error: unknown): NextResponse {
  const translated = translateError(error);
  return NextResponse.json(
    {
      code: translated.code,
      detail: translated.message,
      recovery: recoveryFor(translated.action),
    },
    { status: translated.status, headers: { 'cache-control': 'no-store' } },
  );
}

function linkSet(sessionId: string) {
  const id = encodeURIComponent(sessionId);
  return {
    session: `/council/${id}`,
    events: `/api/council/sessions/${id}/events`,
    result: `/council/${id}`,
    download: `/council/${id}/report.pdf`,
    cancel: `/api/council/sessions/${id}/cancel`,
  };
}

function idempotencyKeyFor(
  request: NextRequest,
  body: Record<string, unknown>,
  fingerprint: Record<string, unknown>,
): string {
  const header = request.headers.get('idempotency-key');
  const fromBody =
    typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined;
  const chosen = header ?? fromBody;
  if (chosen !== undefined) {
    if (chosen.trim().length === 0 || chosen.length > MAX_IDEMPOTENCY_KEY) {
      throw schemaValidation(
        `The idempotency key must be between 1 and ${MAX_IDEMPOTENCY_KEY} characters.`,
      );
    }
    return chosen.trim();
  }
  // The canonical composer sends no key. Derive one from the DECISION CONTENT
  // only (never created_at/brief_id), so a retry or a double click dedups to
  // the first sitting instead of creating a second council.
  return `convene:${canonicalHash(fingerprint)}`;
}

function activeGrantId(
  ctx: Parameters<typeof getRunAuthorizationStatus>[0],
  sessionId: string,
): string | null {
  const status = getRunAuthorizationStatus(ctx, sessionId);
  const now = Date.now();
  for (const grant of status.grants) {
    if (!grant) continue;
    if (grant.stage !== 'granted' || grant.status !== 'active' || grant.standing) continue;
    const expires = Date.parse(String(grant.expires_at));
    if (Number.isFinite(expires) && expires > now) return String(grant.grant_id);
  }
  return null;
}

function readRouteSelection(
  ctx: Parameters<typeof getRunAuthorizationStatus>[0],
  routeId: string,
  requestedModel: string | undefined,
): { selection: CouncilRouteSelection; entry: RouteCatalogEntry } {
  const entry = findCatalogEntryByCanonicalRouteId(modelsCatalogData(ctx).routes, routeId);
  if (!entry) {
    throw new CouncilApiError(
      'ROUTE_NOT_IN_CATALOG',
      `Route ${routeId} is not in this installation's council route catalog. Refresh the window and choose a listed route.`,
      { status: 400, action: 'fix_request' },
    );
  }
  const composable =
    entry.kind === 'fixed_model' &&
    (entry.credential.state === 'present' || entry.credential.state === 'not_required');
  if (!composable || !entry.modelId) {
    throw new CouncilApiError(
      'ROUTE_NOT_AVAILABLE',
      `Route ${routeId} is not available for a council run on this installation: its credential is ${entry.credential.state}. Configure it on this box, then reopen the window.`,
      { status: 409, action: 'fix_request' },
    );
  }
  if (requestedModel !== undefined && requestedModel !== entry.modelId) {
    throw new CouncilApiError(
      'MODEL_NOT_ON_ROUTE',
      `The requested model "${requestedModel}" is not the exact model configured for route ${routeId} ("${entry.modelId}"). The council does not silently substitute models; choose the route's model or change the route catalog.`,
      { status: 400, action: 'fix_request' },
    );
  }
  try {
    const selection = createRouteSelection(
      entry,
      {
        routeId: entry.routeId,
        selectionSource: 'explicit',
        requestedModelOrAlias: entry.modelId,
        fallbackPolicy: 'none',
        providerAccountRef: entry.providerAccountRef,
      },
      {
        tenantId: ctx.principal.scope.tenant_id,
        companyId: ctx.principal.scope.company_id,
        installationId: ctx.principal.scope.installation_id,
        ownerSubject: ctx.principal.subject,
      },
      { routeRevision: 1, createdAt: new Date().toISOString() },
    );
    return { selection, entry };
  } catch (error) {
    if (error instanceof CouncilSelectionError) {
      throw new CouncilApiError(error.code, error.message, {
        status: 400,
        action: 'fix_request',
      });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  return handleCouncil(request, async (ctx) => {
    try {
      await requireMutationProof(request);
      const body = await parseJsonBody(request);
      checkBodyScope(ctx.principal, body);
      rejectUnknownKeys(body, TOP_LEVEL_FIELDS, 'convene');

      if (!isRecord(body.brief)) {
        throw schemaValidation(
          'Field "brief" is required and must be the canonical DecisionBrief object.',
        );
      }
      const brief = body.brief;
      rejectUnknownKeys(brief, BRIEF_FIELDS, 'convene brief');

      const question = boundedString(brief.question, 'brief.question', MAX_QUESTION, true) as string;
      const options = boundedArray(brief.options, 'brief.options', MAX_OPTIONS);
      if (options.length === 0) {
        throw schemaValidation('brief.options must name at least one option.');
      }
      for (const option of options) {
        if (!isRecord(option)) throw schemaValidation('Each brief option must be an object.');
        boundedString(option.label, 'brief.options[].label', MAX_OPTION_LABEL, true);
      }
      const facts = boundedArray(brief.facts, 'brief.facts', 100);
      const assumptions = boundedArray(brief.assumptions, 'brief.assumptions', 100);
      const unknowns = boundedArray(brief.unknowns, 'brief.unknowns', 100);
      const constraints = boundedArray(brief.constraints, 'brief.constraints', 100);
      const evidenceManifest = boundedArray(
        brief.evidence_manifest,
        'brief.evidence_manifest',
        100,
      );
      const criticalDomains = boundedArray(
        brief.critical_domains,
        'brief.critical_domains',
        20,
      );
      if (
        brief.relevance_weights !== undefined &&
        brief.relevance_weights !== null &&
        !isRecord(brief.relevance_weights)
      ) {
        throw schemaValidation('Field "brief.relevance_weights" must be an object when present.');
      }
      if (
        brief.private_preference_ref !== undefined &&
        brief.private_preference_ref !== null &&
        typeof brief.private_preference_ref !== 'string'
      ) {
        throw schemaValidation('Field "brief.private_preference_ref" must be a string or null.');
      }
      const displayTimezone =
        boundedString(brief.display_timezone, 'brief.display_timezone', 100, false) ?? undefined;

      const routeId = boundedString(body.route_id, 'route_id', 200, true) as string;
      const requestedModel = boundedString(body.model, 'model', 200, false);
      if (body.requested_by !== undefined && body.requested_by !== null) {
        boundedString(body.requested_by, 'requested_by', 80, false);
      }
      const { selection, entry } = readRouteSelection(ctx, routeId, requestedModel);
      if (!entry.modelId) {
        // readRouteSelection already refused; this narrows the type only.
        throw schemaValidation('The selected route has no configured model.');
      }

      const rawWeights = isRecord(brief.relevance_weights)
        ? brief.relevance_weights
        : {};
      const weights =
        Object.keys(rawWeights).length > 0
          ? rawWeights
          : Object.fromEntries(SEAT_IDS.map((seat) => [seat, 2]));

      const fingerprint = {
        route_id: routeId,
        model: entry.modelId,
        question,
        options,
        facts,
        assumptions,
        unknowns,
        constraints,
        relevance_weights: weights,
        critical_domains: criticalDomains,
      };
      const idempotencyKey = idempotencyKeyFor(request, body, fingerprint);

      const draft = createDraftSession(
        ctx,
        parseDraftInput({
          mode: 'full',
          visibility: 'private',
          seat_ids: [...SEAT_IDS],
          source_pack_version: CONTRACT_PACKAGE_VERSION,
          model_policy: {
            selection: 'explicit',
            // Canonical idSchema forbids '/' in an id, so the raw host model
            // id cannot be this field. The exact model is pinned in the
            // route snapshot and run grant; this is its legal route name.
            route_id: canonicalRouteIdForModel(entry.routeId),
            requested_model_id: null,
            reasoning_preference: null,
            fallback_policy: 'none',
          },
          display_timezone: displayTimezone,
          brief: {
            question,
            facts: facts as DecisionBrief['facts'],
            assumptions: assumptions as DecisionBrief['assumptions'],
            unknowns: unknowns as DecisionBrief['unknowns'],
            constraints: constraints as DecisionBrief['constraints'],
            options: options as DecisionBrief['options'],
            relevance_weights: weights as unknown as DecisionBrief['relevance_weights'],
            critical_domains: criticalDomains as DecisionBrief['critical_domains'],
            evidence_manifest: evidenceManifest as DecisionBrief['evidence_manifest'],
            private_preference_ref:
              (brief.private_preference_ref as DecisionBrief['private_preference_ref']) ?? null,
            display_timezone: displayTimezone,
          },
        }),
        idempotencyKey,
      );

      const sessionId = draft.session.spec.session_id;
      const links = linkSet(sessionId);
      const currentState = draft.session.state.state;

      // A replay after the run already left the draft states is a completed
      // launch: return the same session and links, never a second grant.
      if (draft.replayed && currentState !== 'DRAFT' && currentState !== 'READY') {
        const payload = {
          session_id: sessionId,
          state: currentState,
          state_version: draft.session.state.state_version,
          replayed: true,
          links,
        };
        assertNoConfiguredSecretsInPayload(payload);
        return NextResponse.json(payload, {
          status: 202,
          headers: { 'cache-control': 'no-store' },
        });
      }

      const authorized = authorizeSessionMutate(ctx, sessionId);
      let grantId = activeGrantId(ctx, sessionId);
      if (!grantId) {
        const routePolicySha256 = canonicalHash(
          selection as unknown as Record<string, unknown>,
        );
        const preview = previewRunAuthorization(ctx, sessionId, {
          route_snapshot: selection as unknown as Record<string, unknown>,
          route_policy_sha256: routePolicySha256,
          purpose: 'council_run',
        });
        const approved = approveRunAuthorization(
          ctx,
          sessionId,
          {
            preview_id: preview.preview_id,
            authority_mode: 'managed_principal',
            current_route_snapshot: selection,
          },
          `${idempotencyKey}:approve:${preview.preview_id}`,
        );
        grantId = approved.grant_id;
      }

      const start = await startSessionRun(
        ctx,
        authorized,
        sessionId,
        { grant_id: grantId },
        `${idempotencyKey}:start:${grantId}`,
      );
      const receipt = start.receipt as {
        state?: string;
        state_version?: number;
        idempotent_replay?: boolean;
        job_id?: string;
        grant_id?: string;
      };
      const payload = {
        session_id: sessionId,
        state: receipt.state ?? currentState,
        state_version: receipt.state_version ?? draft.session.state.state_version,
        replayed: draft.replayed || receipt.idempotent_replay === true,
        job_id: receipt.job_id ?? null,
        grant_id: receipt.grant_id ?? grantId,
        links,
      };
      assertNoConfiguredSecretsInPayload(payload);

      // The durable job is the handoff. Start the existing run worker in the
      // background and return now; the request never waits for a council.
      void import('@/lib/council/engine')
        .then((engine) => engine.getCouncilEngine().drainCouncilRunsOnce())
        .catch(() => undefined);

      return NextResponse.json(payload, {
        status: 202,
        headers: { 'cache-control': 'no-store' },
      });
    } catch (error) {
      return canonicalFailure(error);
    }
  });
}

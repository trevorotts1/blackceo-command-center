/**
 * CTR-191: the configured Council run transport (composition, not a framework).
 *
 * Why this file exists
 * --------------------
 * `CouncilRunWorker` (engine.ts) owns the durable lease, admission and
 * settlement of a `council_run` job, but it deliberately refuses to invent
 * an execution path: with no transport it reports
 * `transport_not_configured` and leaves every job QUEUED. That is correct
 * behaviour, and it is also why a new Council stayed stuck after convene.
 *
 * This module supplies the missing composition from the host's OWN installed
 * provider execution surface — the same one the model probe and the model
 * refresh already use:
 *
 *   getProvider(route.providerSlug)          the installed connector
 *   resolveProviderApiKey(provider)          the server-side credential
 *   provider.chatCompletion(apiKey, req, s)  the authenticated transport
 *
 * Nothing here is a second router, a second credential store, or a new
 * generic framework. There is no model fallback: the route snapshot pinned on
 * the approved run grant is the exact route, and every refusal is typed
 * BEFORE a request leaves the box.
 *
 * Laws kept by this module
 * ------------------------
 * - Route law: `selectionSource` must be `explicit` and `fallbackPolicy`
 *   `none`; the provider slug and the exact model must be pinned. A
 *   combination route is refused rather than collapsed to one member.
 * - Secret law: the credential VALUE is resolved inside `dispatch`, used only
 *   as the connector call's argument, and never stored, journaled, returned
 *   or included in an error message. Errors carry a stable code only.
 * - Request law: exactly ONE provider request per `dispatch`. The transport
 *   never batches, never performs a whole council in one call, and is safe
 *   for concurrent dispatches — the worker's operation graph keeps its own
 *   round barrier and concurrency.
 * - Failure law: a definite provider rejection is `failed`; an ambiguous
 *   failure (network, timeout, 5xx) is `unknown` and is never auto-replayed.
 *
 * CTR-191 completion: `execute()` composes the FULL canonical engine
 * (`engine/council-engine.ts`, ported from the 77-council-of-wise-elders
 * runtime) over the CC durable store/jobs/authorization. One durable job
 * now runs both advisor rounds, crux review, draft resolution,
 * ratification, deterministic scoring, verdict validation, and session
 * COMPLETED. `dispatch()` remains the single-operation path for explicit
 * callers; the production worker never treats it as a completed council.
 */

import type Database from 'better-sqlite3';
import { getProvider } from '@/lib/model-providers';
import type { ChatCompletionResponse } from '@/lib/model-providers/types';
import { resolveProviderApiKey } from '@/lib/provider-key-detection';
import { canonicalHash } from './contracts';
import type { CouncilRouteSelection } from './explicit-selection';
import type {
  CouncilRunExecutionInput,
  CouncilRunExecutionResult,
  CouncilRunTransport,
  CouncilRunTransportDispatch,
  CouncilRunTransportResult,
} from './engine';
import type { CouncilStore } from './persistence/council-store';
import { CouncilRepositories, envelopeFromScope } from './store';
import { CouncilJobService } from './jobs';
import { CouncilRunAuthorizationService } from './run-authorization';
import { CouncilEngine } from './engine/council-engine';
import { createCcCouncilHost } from './engine/cc-host';
import { CouncilError } from './engine/errors';
import {
  assertExplicitRoute as assertPinnedRoute,
  resolveConfiguredConnector,
} from './provider-route';

/** A typed refusal: the worker records `code` as the job's error_code. */
export class CouncilRunTransportRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CouncilRunTransportRefusal';
    this.code = code;
  }
}

export interface ConfiguredCouncilRunTransportOptions {
  /** The composed council store; used only to read the session's own brief. */
  store?: CouncilStore;
  /** Repositories/jobs/authorization from the ONE engine composition. */
  repositories?: CouncilRepositories;
  jobs?: CouncilJobService;
  runAuthorization?: CouncilRunAuthorizationService;
  /** Hard ceiling for one provider request. Ambiguous overrun => unknown. */
  timeoutMs?: number;
  maxOutputTokens?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 600;
const MAX_BRIEF_CHARS = 4_000;

interface BriefRow {
  question: string;
  brief_json: string;
}

function refusal(code: string, message: string): never {
  throw new CouncilRunTransportRefusal(code, message);
}

/**
 * Assert the grant's route snapshot is the exact, explicit route this
 * transport may execute. No default route is ever read here.
 */
function assertExplicitRoute(route: CouncilRouteSelection): void {
  if (route.selectionSource !== 'explicit') {
    refusal(
      'RUN_ROUTE_NOT_EXPLICIT',
      'The run grant does not pin an explicit route; the council transport never resolves a default.',
    );
  }
  if (route.fallbackPolicy !== 'none') {
    refusal(
      'RUN_ROUTE_FALLBACK_REFUSED',
      'The run grant permits fallback; the council transport executes only the pinned route.',
    );
  }
  if (route.routeKind !== 'fixed_model') {
    refusal(
      'RUN_ROUTE_COMBINATION_UNSUPPORTED',
      'A combination route cannot be executed by one dispatch; no member is selected implicitly.',
    );
  }
  if (!route.providerSlug || !route.requestedModelOrAlias) {
    refusal(
      'RUN_ROUTE_PIN_INCOMPLETE',
      'The run grant does not pin both a provider and an exact model; nothing was dispatched.',
    );
  }
}

/**
 * The connector-native model id. Registry ids are `<provider>/<native>`; a
 * connector that also strips its own prefix (agnes) is unaffected because
 * the prefix is gone by then. A model id owned by a DIFFERENT provider is a
 * route mismatch, never a substitution.
 */
function nativeModelId(route: CouncilRouteSelection): string {
  const raw = (route.requestedModelOrAlias as string).trim();
  const slug = route.providerSlug;
  if (raw.startsWith(`${slug}/`)) return raw.slice(slug.length + 1);
  const slash = raw.indexOf('/');
  if (slash > 0) {
    const root = raw.slice(0, slash);
    if (root !== slug && getProvider(root)) {
      refusal(
        'RUN_ROUTE_MODEL_MISMATCH',
        `The pinned model belongs to provider "${root}", not the grant's provider "${slug}".`,
      );
    }
  }
  return raw;
}

/** The session's own current brief, reduced to the fields an advisor reads. */
function readBrief(
  db: Database.Database,
  dispatch: CouncilRunTransportDispatch,
): { question: string; context: string } {
  const row = db
    .prepare(
      `SELECT question, brief_json FROM council_brief_revisions
        WHERE tenant_id = ? AND company_id = ? AND session_id = ?
        ORDER BY revision DESC LIMIT 1`,
    )
    .get(dispatch.tenant_id, dispatch.company_id, dispatch.session_id) as
    | BriefRow
    | undefined;
  if (!row || typeof row.question !== 'string' || row.question.trim().length === 0) {
    refusal(
      'RUN_OPERATION_CONTEXT_MISSING',
      'No decision brief exists for this session, so no provider request was dispatched.',
    );
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.brief_json) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const lines: string[] = [];
  for (const key of ['options', 'facts', 'assumptions', 'unknowns', 'constraints'] as const) {
    const value = parsed[key];
    if (!Array.isArray(value) || value.length === 0) continue;
    lines.push(
      `${key}: ${value
        .slice(0, 12)
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : typeof entry === 'object' && entry !== null && 'label' in entry
              ? String((entry as { label: unknown }).label)
              : JSON.stringify(entry),
        )
        .join(' | ')}`,
    );
  }
  const context = lines.join('\n').slice(0, MAX_BRIEF_CHARS);
  return { question: row.question.slice(0, MAX_BRIEF_CHARS), context };
}

function httpStatusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as Record<string, unknown>;
  for (const key of ['status', 'httpStatus', 'statusCode']) {
    if (typeof record[key] === 'number') return record[key] as number;
  }
  return null;
}

/**
 * Build the configured transport. Absent `store` keeps the transport usable
 * for explicit callers but any dispatch refuses before a request because it
 * cannot read the session brief.
 */
export function createConfiguredCouncilRunTransport(
  options: ConfiguredCouncilRunTransportOptions = {},
): CouncilRunTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const db = options.store?.handle() ?? null;

  return {
    /**
     * The FULL canonical engine over the CC durable store. One durable job
     * runs all nine seats, both advisor rounds, crux review, draft
     * resolution, ratification, deterministic scoring, verdict validation,
     * and session COMPLETED. Nothing is marked complete on a prepare call.
     */
    async execute(input: CouncilRunExecutionInput): Promise<CouncilRunExecutionResult> {
      if (!options.store) {
        refusal(
          'RUN_TRANSPORT_STORE_NOT_COMPOSED',
          'The council store is not composed, so the canonical engine cannot run.',
        );
      }
      assertPinnedRoute(input.route);
      const repositories =
        options.repositories ?? new CouncilRepositories({ adapter: options.store });
      const jobs = options.jobs ?? new CouncilJobService({ store: options.store });
      const runAuthorization =
        options.runAuthorization ?? new CouncilRunAuthorizationService({ store: options.store });
      const envelope = envelopeFromScope(
        {
          tenant_id: input.tenant_id,
          company_id: input.company_id,
          installation_id: input.installation_id,
          owner_subject: null,
        },
        input.worker_subject,
        'worker',
        'write',
      );
      const session = repositories.getSession(envelope, input.session_id);
      if (!session) {
        return {
          status: 'failed',
          error_code: 'RUN_SESSION_NOT_FOUND',
          reason: 'the session does not exist in this scope or is not visible to the worker',
        };
      }
      if (session.spec.model_policy.route_id !== input.route.routeId) {
        return {
          status: 'failed',
          error_code: 'RUN_ROUTE_PIN_MISMATCH',
          reason: `the session route ${session.spec.model_policy.route_id} is not the grant's pinned route ${input.route.routeId}`,
        };
      }
      if (input.signal.aborted) {
        return { status: 'failed', error_code: 'RUN_TRANSPORT_ABORTED', reason: 'aborted before execution' };
      }
      // Credential presence and the exact route are preflighted BEFORE any
      // state change or provider request. The value never leaves this call.
      try {
        resolveConfiguredConnector(input.route);
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'RUN_PROVIDER_NOT_REGISTERED';
        return { status: 'failed', error_code: code, reason: (error as Error).message };
      }
      const composed = createCcCouncilHost({
        repositories,
        store: options.store,
        jobs,
        runAuthorization,
        principal: input.principal,
        envelope,
        session,
        grant_id: input.grant_id,
        currency: input.currency,
        route: input.route,
        job_id: input.job_id,
        worker_id: input.worker_id,
        worker_subject: input.worker_subject,
        lease_epoch: input.lease_epoch,
        job_lease_epoch: input.job_lease_epoch,
        signal: input.signal,
        timeoutMs,
        newId: undefined,
        now: undefined,
      });
      const engine = new CouncilEngine(composed.host, {
        settings: composed.settings,
        ownerId: input.worker_id,
      });
      try {
        const finalSession = await engine.continueAdmittedSession(
          input.session_id,
          input.grant_id,
        );
        const verdict = repositories.getVerdict(envelope, input.session_id);
        const cards = repositories.listCards(envelope, input.session_id);
        if (finalSession.state.state === 'COMPLETED' && verdict) {
          return {
            status: 'accepted',
            verdict_revision: verdict.verdict_revision,
            session_state: finalSession.state.state,
            cards_committed: cards.length,
          };
        }
        return {
          status: 'failed',
          error_code:
            finalSession.state.state === 'BLOCKED'
              ? 'COUNCIL_BLOCKED'
              : finalSession.state.state === 'PAUSED' ||
                  finalSession.state.state === 'PAUSE_REQUESTED'
                ? 'COUNCIL_PAUSED'
                : finalSession.state.state === 'CANCELLED'
                  ? 'COUNCIL_CANCELLED'
                  : 'COUNCIL_RUN_INCOMPLETE',
          session_state: finalSession.state.state,
          cards_committed: cards.length,
          reason: `session finished in ${finalSession.state.state} with ${cards.length} committed card(s)`,
        };
      } catch (error) {
        if (error instanceof CouncilError) {
          return {
            status:
              error.code === 'COUNCIL_TRANSPORT_FAILED' &&
              (error as { unknownCompletion?: boolean }).unknownCompletion === true
                ? 'unknown'
                : 'failed',
            error_code: error.code,
            reason: error.message,
          };
        }
        if (input.signal.aborted) {
          return { status: 'failed', error_code: 'RUN_TRANSPORT_ABORTED', reason: 'cancelled' };
        }
        return {
          status: 'failed',
          error_code: (error as { code?: string }).code ?? 'COUNCIL_RUN_FAILED',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async dispatch(dispatch: CouncilRunTransportDispatch): Promise<CouncilRunTransportResult> {
      const route = dispatch.route;
      assertExplicitRoute(route);

      if (dispatch.signal.aborted) {
        refusal('RUN_TRANSPORT_ABORTED', 'The run was cancelled before the provider request.');
      }
      if (!db) {
        refusal(
          'RUN_TRANSPORT_STORE_NOT_COMPOSED',
          'The council store is not composed, so no operation context can be read.',
        );
      }

      const provider = getProvider(route.providerSlug);
      if (!provider) {
        refusal(
          'RUN_PROVIDER_NOT_REGISTERED',
          `No installed provider connector is registered for "${route.providerSlug}".`,
        );
      }
      if (typeof provider.chatCompletion !== 'function') {
        refusal(
          'RUN_PROVIDER_TRANSPORT_UNSUPPORTED',
          `The "${route.providerSlug}" connector exposes no completion transport.`,
        );
      }

      // Presence and value resolution are one server-side step. The value is
      // never copied anywhere but the connector call below.
      const keyResult = resolveProviderApiKey(provider);
      let apiKey: string;
      if ('localEndpoint' in keyResult) {
        apiKey = '';
      } else if (keyResult.found) {
        apiKey = keyResult.value;
      } else {
        refusal(
          'RUN_PROVIDER_CREDENTIAL_ABSENT',
          `No credential is configured for provider "${route.providerSlug}" (presence only; no value was read).`,
        );
      }

      const model = nativeModelId(route);
      const brief = readBrief(db, dispatch);
      const messages = [
        {
          role: 'system' as const,
          content:
            'You are answering one operation for the Council of Wise Elders. ' +
            'Answer the decision question using only the brief. Be concise and specific.',
        },
        {
          role: 'user' as const,
          content: brief.context ? `${brief.question}\n\n${brief.context}` : brief.question,
        },
      ];

      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort(dispatch.signal.reason);
      dispatch.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort('provider_timeout');
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();

      let response: ChatCompletionResponse;
      try {
        response = await provider.chatCompletion!(
          apiKey,
          { model, messages, max_tokens: maxOutputTokens },
          controller.signal,
        );
      } catch (error) {
        if (dispatch.signal.aborted) {
          return { status: 'unknown', error_code: 'RUN_TRANSPORT_ABORTED' };
        }
        if (timedOut) {
          // The provider may or may not have completed: never claim success.
          return { status: 'unknown', error_code: 'TRANSPORT_TIMEOUT' };
        }
        const status = httpStatusOf(error);
        if (status !== null && status >= 400 && status < 500) {
          return { status: 'failed', error_code: `TRANSPORT_HTTP_${status}` };
        }
        return { status: 'unknown', error_code: 'TRANSPORT_ERROR' };
      } finally {
        clearTimeout(timer);
        dispatch.signal.removeEventListener('abort', onAbort);
      }

      const content = response?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        return { status: 'failed', error_code: 'TRANSPORT_EMPTY_RESPONSE' };
      }
      return {
        status: 'accepted',
        response_sha256: canonicalHash({
          route_id: route.routeId,
          model,
          reported_model: typeof response.model === 'string' ? response.model : null,
          content,
          usage: response.usage ?? null,
        }),
        input_tokens: response.usage?.prompt_tokens ?? null,
        output_tokens: response.usage?.completion_tokens ?? null,
        actual_minor: 0,
        error_code: null,
      };
    },
  };
}

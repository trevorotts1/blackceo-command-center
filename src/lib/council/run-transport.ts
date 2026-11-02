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
 * Deliberate ceiling: the Command Center worker admits one `prepare`
 * operation per durable job. This transport executes that admitted operation
 * on the pinned route; it does not synthesize the multi-round debate graph.
 * ponytail: one operation per dispatch. Add a round/seat operation producer
 * when the canonical deliberation engine is composed into this repository —
 * do not widen this transport into a one-call council.
 */

import type Database from 'better-sqlite3';
import { getProvider } from '@/lib/model-providers';
import type { ChatCompletionResponse } from '@/lib/model-providers/types';
import { resolveProviderApiKey } from '@/lib/provider-key-detection';
import { canonicalHash } from './contracts';
import type { CouncilRouteSelection } from './explicit-selection';
import type {
  CouncilRunTransport,
  CouncilRunTransportDispatch,
  CouncilRunTransportResult,
} from './engine';
import type { CouncilStore } from './persistence/council-store';

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

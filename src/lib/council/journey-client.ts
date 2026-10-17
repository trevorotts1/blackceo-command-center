/**
 * journey-client.ts (CWE-033, Skill 77 Council of Wise Elders)
 *
 * Typed client bindings over the CWE-029 API foundation. Every function
 * speaks the Section 17.3 envelope ({ ok: true, data } on success,
 * { ok: false, error: { code, message, retryable, action, request_id } }
 * on failure) and surfaces failures as a CouncilClientError carrying the
 * server's canonical code unrenamed. A FEATURE_NOT_READY failure is data
 * the journey screens render as the endpoint's typed readiness state
 * (with the owning unit from the CWE-029 registry, never guessed); no
 * function here invents, caches, or simulates a server result.
 *
 * Mutations send an Idempotency-Key header (Section 17.1). CSRF is the
 * foundation's cookie proof: same-origin fetches carry the cookie, so
 * no token is read or handled by this module.
 */

import type { DecisionBrief, Verdict } from './contracts';
import type { CouncilStoredSession } from './store';
import type { RouteCatalogEntry } from './providers';
import type { SessionDraftInput, BriefRevisionInput } from './api/drafts';
import { endpointById, type CouncilEndpointEntry } from './api/registry';

function registryEntry(contractId: string): CouncilEndpointEntry | null {
  try {
    return endpointById(contractId);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- errors

export interface CouncilClientErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  action: string;
  requestId: string | null;
  httpStatus: number;
}

/** A council API failure, carrying the server's canonical error fields. */
export class CouncilClientError extends Error implements CouncilClientErrorShape {
  readonly code: string;
  readonly retryable: boolean;
  readonly action: string;
  readonly requestId: string | null;
  readonly httpStatus: number;

  constructor(shape: CouncilClientErrorShape) {
    super(shape.message);
    this.name = 'CouncilClientError';
    this.code = shape.code;
    this.retryable = shape.retryable;
    this.action = shape.action;
    this.requestId = shape.requestId;
    this.httpStatus = shape.httpStatus;
  }
}

export function isCouncilClientError(value: unknown): value is CouncilClientError {
  return value instanceof CouncilClientError;
}

/** The typed readiness state of a registered-but-unwired endpoint. */
export interface FeatureNotReadyState {
  code: 'FEATURE_NOT_READY';
  message: string;
  owningUnit: string;
  surface: string;
  action: string;
}

/**
 * When a failure is FEATURE_NOT_READY for a known registry contract,
 * return the typed readiness state the screens render; otherwise null.
 * The owning unit comes from the CWE-029 registry entry for the
 * contract, and the message is the server's own, verbatim.
 */
export function featureNotReadyState(
  error: unknown,
  contractId: string,
): FeatureNotReadyState | null {
  if (!isCouncilClientError(error) || error.code !== 'FEATURE_NOT_READY') return null;
  const entry = registryEntry(contractId);
  return {
    code: 'FEATURE_NOT_READY',
    message: error.message,
    owningUnit: entry?.owning_unit ?? 'an unassigned owning unit',
    surface: entry?.surface ?? contractId,
    action: error.action,
  };
}

/** Static registry view of one endpoint: readiness without any call. */
export function endpointReadiness(contractId: string): {
  readiness: 'ready' | 'not_ready' | 'unknown';
  owningUnit: string | null;
  surface: string | null;
} {
  const entry = registryEntry(contractId);
  if (!entry) return { readiness: 'unknown', owningUnit: null, surface: null };
  return {
    readiness: entry.readiness,
    owningUnit: entry.owning_unit,
    surface: entry.surface,
  };
}

// ---------------------------------------------------------------- envelope

interface EnvelopeSuccess<T> {
  ok: true;
  data: T;
  request_id: string;
  meta?: Record<string, unknown>;
}

interface EnvelopeFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    action: string;
    request_id: string;
  };
}

async function councilFetch<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {},
): Promise<{ data: T; meta: Record<string, unknown> | null; requestId: string | null }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (cause) {
    throw new CouncilClientError({
      code: 'NETWORK_UNREACHABLE',
      message:
        'The council service could not be reached. Nothing was sent or changed. ' +
        (cause instanceof Error ? cause.message : ''),
      retryable: true,
      action: 'retry',
      requestId: null,
      httpStatus: 0,
    });
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (payload && typeof payload === 'object' && 'ok' in payload) {
    const envelope = payload as EnvelopeSuccess<T> | EnvelopeFailure;
    if (envelope.ok) {
      return {
        data: envelope.data,
        meta: envelope.meta ?? null,
        requestId: envelope.request_id ?? null,
      };
    }
    throw new CouncilClientError({
      code: envelope.error.code,
      message: envelope.error.message,
      retryable: envelope.error.retryable,
      action: envelope.error.action,
      requestId: envelope.error.request_id ?? null,
      httpStatus: response.status,
    });
  }

  throw new CouncilClientError({
    code: 'UNEXPECTED_RESPONSE',
    message: `The council service answered with HTTP ${response.status} and no typed envelope. Nothing was changed.`,
    retryable: response.status >= 500,
    action: 'retry',
    requestId: null,
    httpStatus: response.status,
  });
}

/** A fresh idempotency key for one mutation attempt (Section 17.1). */
export function newIdempotencyKey(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return `council-ui-${cryptoRef.randomUUID()}`;
  }
  return `council-ui-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// ---------------------------------------------------------------- shapes

export interface CouncilCapabilitiesData {
  foundation: {
    unit: string;
    scope: string;
    registry_contract: string;
    route_ownership_after_acceptance: string;
  };
  endpoints: {
    total: number;
    ready: number;
    not_ready: number;
    by_owning_unit: Record<string, number>;
  };
  routes: {
    total: number;
    by_readiness: Record<string, number>;
    runtime_verified: boolean;
  };
  principal: Record<string, unknown>;
}

export interface CouncilAdvisorSeat {
  seat_id: string;
  display_name: string;
  lenses: string[];
  profile_label: string;
  provenance: string;
}

export interface CouncilModelsData {
  routes: RouteCatalogEntry[];
  summary: {
    total: number;
    by_readiness: Record<string, number>;
    runtime_verified: boolean;
  };
}

export interface CouncilSessionListItem {
  session_id: string;
  mode: string;
  visibility: string;
  state: string;
  state_version: number;
  brief_revision: number;
  archived: boolean;
  owner_subject: string | null;
  created_at: string;
  updated_at: string;
}

export interface CouncilSessionListData {
  sessions: CouncilSessionListItem[];
  count: number;
  total_in_scope: number;
}

export interface CouncilVerdictData {
  session_id: string;
  verdict_state: 'not_ready' | 'validated';
  verdict: Verdict | null;
}

export type { DecisionBrief, Verdict, CouncilStoredSession, SessionDraftInput, BriefRevisionInput };

// ---------------------------------------------------------------- calls

const API_BASE = '/api/council';

export async function getCapabilities(): Promise<CouncilCapabilitiesData> {
  const { data } = await councilFetch<CouncilCapabilitiesData>(`${API_BASE}/capabilities`);
  return data;
}

export async function getAdvisors(): Promise<{ seats: CouncilAdvisorSeat[] }> {
  const { data } = await councilFetch<{ seats: CouncilAdvisorSeat[] }>(`${API_BASE}/advisors`);
  return data;
}

export async function getModels(): Promise<CouncilModelsData> {
  const { data } = await councilFetch<CouncilModelsData>(`${API_BASE}/models`);
  return data;
}

export async function listSessions(limit = 50, offset = 0): Promise<CouncilSessionListData> {
  const { data } = await councilFetch<CouncilSessionListData>(
    `${API_BASE}/sessions?limit=${limit}&offset=${offset}`,
  );
  return data;
}

export async function createSession(
  input: SessionDraftInput,
  idempotencyKey: string,
): Promise<CouncilStoredSession> {
  const { data } = await councilFetch<CouncilStoredSession>(`${API_BASE}/sessions`, {
    method: 'POST',
    body: input,
    idempotencyKey,
  });
  return data;
}

export async function getSession(
  sessionId: string,
): Promise<{ session: CouncilStoredSession; accessVia: string | null }> {
  const { data, meta } = await councilFetch<CouncilStoredSession>(
    `${API_BASE}/sessions/${encodeURIComponent(sessionId)}`,
  );
  const accessVia = meta && typeof meta.access_via === 'string' ? meta.access_via : null;
  return { session: data, accessVia };
}

export async function patchBrief(
  sessionId: string,
  input: BriefRevisionInput,
  idempotencyKey: string,
): Promise<CouncilStoredSession> {
  // Literal /api path here (not the API_BASE composition) so the repo's
  // U052 passthrough scanner sees this interface call, as it does for
  // every other client in the codebase. The composed URL is identical.
  const { data } = await councilFetch<CouncilStoredSession>(
    `/api/council/sessions/${encodeURIComponent(sessionId)}/brief`,
    { method: 'PATCH', body: input, idempotencyKey },
  );
  return data;
}

export async function getVerdict(sessionId: string): Promise<CouncilVerdictData> {
  const { data } = await councilFetch<CouncilVerdictData>(
    `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/verdict`,
  );
  return data;
}

/**
 * POST the run start. Until CWE-027 wires the run service (route
 * ownership passes to CWE-050), the foundation answers
 * FEATURE_NOT_READY; this call surfaces that typed error and never
 * reports progress of any kind.
 */
export async function startSession(sessionId: string, idempotencyKey: string): Promise<never> {
  // Literal /api path here (not the API_BASE composition) so the repo's
  // U052 passthrough scanner sees this interface call, as it does for
  // every other client in the codebase. The composed URL is identical.
  const { data } = await councilFetch<unknown>(
    `/api/council/sessions/${encodeURIComponent(sessionId)}/start`,
    { method: 'POST', body: {}, idempotencyKey },
  );
  // The foundation never returns success here today; if a future wired
  // service does, the caller still gets no fabricated state back.
  throw new CouncilClientError({
    code: 'UNEXPECTED_RESPONSE',
    message: `Start answered without a typed run state: ${JSON.stringify(data)}.`,
    retryable: false,
    action: 'reload_session',
    requestId: null,
    httpStatus: 200,
  });
}

/**
 * POST a bounded follow-up question (the linked consult, Section 20).
 * Creating a consult is its own act, distinct from reading an
 * objection on the verdict. Until CWE-050 wires follow-up
 * coordination, the foundation answers FEATURE_NOT_READY.
 */
export async function createFollowUp(
  sessionId: string,
  question: string,
  target: { kind: 'advisor'; seatId: string } | { kind: 'department'; departmentId: string },
  idempotencyKey: string,
): Promise<never> {
  await councilFetch<unknown>(
    `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/follow-up`,
    {
      method: 'POST',
      body: {
        question,
        target_kind: target.kind,
        target_seat_id: target.kind === 'advisor' ? target.seatId : undefined,
        target_department_id: target.kind === 'department' ? target.departmentId : undefined,
      },
      idempotencyKey,
    },
  );
  throw new CouncilClientError({
    code: 'UNEXPECTED_RESPONSE',
    message: 'Follow-up answered without a typed operation receipt.',
    retryable: false,
    action: 'reload_session',
    requestId: null,
    httpStatus: 200,
  });
}

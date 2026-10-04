/**
 * Company Headquarters — private head-conversation storage and turn state machine (unit B09).
 *
 * Authority: SPEC.md revision 4, S6 (private sessions and turns) and S9 (durable turn
 * protocol, identity/transport correlation). Types are the frozen P01 contract in
 * `./types` — this module imports them and never redeclares them.
 *
 * Scope boundary: this file is the STATE MACHINE plus storage. It performs no network
 * I/O, so no network call is ever inside a SQL transaction (SPEC S9). The caller
 * (B10 routes, wired by A05) claims a turn, sends with the returned gateway key and
 * reports each lifecycle outcome back through `applyTransportCallback`.
 *
 * Tables `hq_chat_sessions` / `hq_chat_turns` are created by B01's reserved additive
 * migration 169, and B01 is their sole DDL writer (P02 storage-auth.md §(b)). SPEC S6 fixes
 * the column LIST but types only `id`, `attempts`, `gateway_session_key`, so the column
 * types follow B01's landed DDL rather than a second choice made here: every timestamp
 * column is TEXT, including `lease_expires_at`. Expiry comparisons go through the repo's
 * dialect-safe `sqlTime()` helper (`src/lib/db/index.ts`) so the two TEXT timestamp dialects
 * that live in this database can never be compared lexicographically by accident.
 *
 * B01 also exports row types, decoders and `HQ_NONTERMINAL_TURN_STATES` from
 * `./storage`, which is NOT in this branch's tree (B09 bases on `hq/contracts`; B01 lands
 * separately). This module therefore declares only the slices it reads and reconciles at
 * integration — A05 is the seat that connects B09's service to B11's transport.
 */

import { createHash, randomUUID } from 'node:crypto';
import { queryAll, queryOne, run, sqlTime, timeNow, transaction } from '@/lib/db';
import { hqSemanticSerialize } from './types';
import {
  hqChatTurnCreateSchema,
  type HqChatSession,
  type HqChatTransportCallback,
  type HqChatTurn,
  type HqChatTurnState,
} from './types';

/* ================================================================== *
 * SPEC-given constants (S9)
 * ================================================================== */

/** S9: "assign random fencing lease (120s) before network operation". */
export const HQ_CHAT_LEASE_MS = 120_000;
/** S9: "unresolved: reconciliation cannot establish outcome within 10 minutes". */
export const HQ_CHAT_UNRESOLVED_AFTER_MS = 600_000;
/** S9/S6: chat contents expire 30 days after a terminal turn. */
export const HQ_CHAT_CONTENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** S9: "During streaming, persist accumulated text at most once per second". */
export const HQ_CHAT_PARTIAL_PERSIST_MS = 1_000;
/** S9: "Keep accumulator within 64,000 characters". */
export const HQ_CHAT_PARTIAL_CAP = 64_000;
/** S9 retry endpoint: "accepts only failed_unsent, attempts<3". */
export const HQ_CHAT_MAX_ATTEMPTS = 3;
/** S8/S9: current message cap; reject oversize with 413, never truncate. */
export const HQ_CHAT_MESSAGE_CAP = 32_000;

/** S9 terminal set. `failed_unsent` is terminal AND the one retryable state. */
const TERMINAL_STATES: ReadonlySet<HqChatTurnState> = new Set<HqChatTurnState>([
  'replied',
  'failed_unsent',
  'refused',
  'unresolved',
]);

/** S6: the four states carrying the one-active-turn partial unique index. */
const NONTERMINAL_STATES: readonly HqChatTurnState[] = ['queued', 'sending', 'awaiting_reply', 'reconciling'];

const isTerminal = (state: HqChatTurnState): boolean => TERMINAL_STATES.has(state);

/* ================================================================== *
 * Scope and result shapes
 * ================================================================== */

/** Caller scope resolved by B02's HQ context guard. Never taken from the request body. */
export type HqChatScope = {
  companyId: string;
  ownerSubject: string;
  installationId: string;
};

/**
 * Failure codes. `turn_in_progress`, `request_conflict` and `head_binding_changed` are
 * SPEC-named (P01 `HQ_SPEC_ERROR_CODES`). The rest spell outcomes SPEC states by status
 * only: 404 foreign/unknown, 410 expired session or expired content (S6 "return 410 for
 * expired owned session, 404 for unknown/foreign"; S9 "never becomes a fresh send via
 * retry (404/410)"), 413 oversize, 409 for the turn-level conflicts SPEC names. No status
 * was invented where SPEC gives one. The string spelling of the non-SPEC-named codes is
 * the route owner's to finalize, so B10 may rename them without touching this state
 * machine.
 */
export const HQ_CHAT_FAIL_CODES = [
  'not_found',
  'session_closed',
  'head_binding_changed',
  'turn_in_progress',
  'request_conflict',
  'content_expired',
  'message_too_long',
  'invalid_body',
  'turn_not_claimable',
  'turn_not_retryable',
  'lease_lost',
  'not_completion',
  'run_mismatch',
] as const;
export type HqChatFailCode = (typeof HQ_CHAT_FAIL_CODES)[number];

export type HqChatFailure = {
  ok: false;
  status: number;
  code: HqChatFailCode;
  message: string;
};

export type HqChatResult<T> = ({ ok: true } & T) | HqChatFailure;

const fail = (status: number, code: HqChatFailCode, message: string): HqChatFailure => ({
  ok: false,
  status,
  code,
  message,
});

/* ================================================================== *
 * Rows and views
 * ================================================================== */

type SessionRow = {
  id: string;
  company_id: string;
  owner_subject: string;
  installation_id: string;
  head_agent_id: string;
  runtime_agent_id: string;
  created_at: string;
  last_activity_at: string;
  closed_at: string | null;
};

type TurnRow = {
  id: string;
  company_id: string;
  session_id: string;
  owner_subject: string;
  client_request_id: string;
  payload_hash: string;
  message_text: string;
  reply_text: string | null;
  state: HqChatTurnState;
  attempts: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  gateway_session_key: string | null;
  source_run_id: string | null;
  task_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  content_expired_at: string | null;
};

/** G-17: the browser-facing view carries metadata and text, never the gateway key. */
const toSessionView = (row: SessionRow): HqChatSession => ({
  id: row.id,
  headAgentId: row.head_agent_id,
  createdAt: row.created_at,
  lastActivityAt: row.last_activity_at,
  closedAt: row.closed_at,
});

/** G-17 + S9: `partial` is true only while a nonterminal turn holds accumulated text. */
const toTurnView = (row: TurnRow): HqChatTurn => ({
  id: row.id,
  sessionId: row.session_id,
  state: row.state,
  message: row.message_text,
  reply: row.reply_text,
  partial: row.reply_text !== null && !isTerminal(row.state),
  attempts: row.attempts,
  taskId: row.task_id,
  errorCode: row.error_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  terminalAt: row.terminal_at,
});

const nowMs = (value?: number): number => value ?? Date.now();

/**
 * One clock per call. A caller that injects `nowMs` (tests, replay, a scheduled sweep)
 * gets that instant for every timestamp the call writes; production callers omit it and
 * every writer stamps from the wall clock, so the two are the same clock in service.
 */
const stamp = (value?: number): string => (value === undefined ? timeNow() : new Date(value).toISOString());

/** The 120 s fencing lease, written in the same ISO UTC dialect as every other timestamp. */
const leaseExpiry = (at: number): string => new Date(at + HQ_CHAT_LEASE_MS).toISOString();

/** S9: normalized payload hash over the frozen canonical serializer (no second canonicalizer). */
const payloadHashOf = (message: string): string =>
  createHash('sha256').update(hqSemanticSerialize({ message }), 'utf8').digest('hex');

/** S6: only terminal rows may be pruned; a redacted or 30-day-old terminal row is expired. */
const isContentExpired = (row: TurnRow, at: number): boolean => {
  if (row.content_expired_at !== null) return true;
  if (row.terminal_at === null) return false;
  const terminal = Date.parse(row.terminal_at);
  return Number.isFinite(terminal) && at - terminal >= HQ_CHAT_CONTENT_RETENTION_MS;
};

/* ================================================================== *
 * Sessions
 * ================================================================== */

/** S6/S9: IDs are server-minted, and the runtime head binding is fixed at creation. */
export function createSession(
  scope: HqChatScope,
  input: { headAgentId: string; runtimeAgentId: string; nowMs?: number },
): HqChatSession {
  const id = randomUUID();
  const at = timeNow();
  run(
    `INSERT INTO hq_chat_sessions
       (id, company_id, owner_subject, installation_id, head_agent_id, runtime_agent_id,
        created_at, last_activity_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, scope.companyId, scope.ownerSubject, scope.installationId, input.headAgentId, input.runtimeAgentId, at, at],
  );
  const row = queryOne<SessionRow>(
    `SELECT * FROM hq_chat_sessions WHERE id = ? AND company_id = ? AND owner_subject = ?`,
    [id, scope.companyId, scope.ownerSubject],
  );
  return toSessionView(row as SessionRow);
}

/** Ownership is validated on every access; a foreign session is null, never another owner's row. */
export function getSession(scope: HqChatScope, sessionId: string): HqChatSession | null {
  const row = queryOne<SessionRow>(
    `SELECT * FROM hq_chat_sessions WHERE id = ? AND company_id = ? AND owner_subject = ?`,
    [sessionId, scope.companyId, scope.ownerSubject],
  );
  return row ? toSessionView(row) : null;
}

export function listSessions(scope: HqChatScope, opts: { limit?: number } = {}): HqChatSession[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return queryAll<SessionRow>(
    `SELECT * FROM hq_chat_sessions
      WHERE company_id = ? AND owner_subject = ?
      ORDER BY last_activity_at DESC, id DESC
      LIMIT ?`,
    [scope.companyId, scope.ownerSubject, limit],
  ).map(toSessionView);
}

/** S9: retired sessions are closed, never deleted; authorized history remains readable. */
export function closeSession(scope: HqChatScope, sessionId: string, at: string = timeNow()): boolean {
  return (
    run(
      `UPDATE hq_chat_sessions SET closed_at = ?
        WHERE id = ? AND company_id = ? AND owner_subject = ? AND closed_at IS NULL`,
      [at, sessionId, scope.companyId, scope.ownerSubject],
    ).changes === 1
  );
}

/* ================================================================== *
 * Turn creation — duplicate handling
 * ================================================================== */

/**
 * S9 creation transaction: checks context, unique request key, normalized payload hash
 * and the one-active-turn constraint. Identical duplicate returns the existing
 * authorized turn; changed content under the same key returns 409 `request_conflict`.
 */
export function createTurn(
  scope: HqChatScope,
  sessionId: string,
  input: { clientRequestId: string; message: string; runtimeAgentId: string; nowMs?: number },
): HqChatResult<{ turn: HqChatTurn; duplicate: boolean }> {
  const parsed = hqChatTurnCreateSchema.safeParse({
    clientRequestId: input.clientRequestId,
    message: input.message,
  });
  if (!parsed.success) {
    // The only schema rejections that are not "wrong shape" are past-the-cap strings.
    const oversize =
      typeof input.message === 'string' && input.message.trim().length > HQ_CHAT_MESSAGE_CAP;
    const status = oversize ? 413 : 400;
    const code: HqChatFailCode = oversize ? 'message_too_long' : 'invalid_body';
    return fail(
      status,
      code,
      oversize
        ? `message exceeds ${HQ_CHAT_MESSAGE_CAP} characters`
        : 'turn body must be {clientRequestId, message} with string values',
    );
  }
  // S8/S9: the schema trims; the cap is applied to the trimmed text, never a truncation.
  const message = parsed.data.message;
  const hash = payloadHashOf(message);
  const at = timeNow();

  const outcome = transaction((): HqChatResult<{ turn: HqChatTurn; duplicate: boolean }> => {
    const session = queryOne<SessionRow>(
      `SELECT * FROM hq_chat_sessions WHERE id = ? AND company_id = ? AND owner_subject = ?`,
      [sessionId, scope.companyId, scope.ownerSubject],
    );
    // Foreign or unknown session is rejected BEFORE dedupe (S9).
    if (!session) return fail(404, 'not_found', 'session not found for this company and owner');
    // S9: a closed logical session accepts no new sends.
    if (session.closed_at !== null) return fail(410, 'session_closed', 'session is closed; existing authorized history remains readable');

    // S9: the head binding is fixed at creation; a changed binding needs a new session.
    if (session.runtime_agent_id !== input.runtimeAgentId) {
      return fail(
        409,
        'head_binding_changed',
        'roster mapping changed; close this session and open a new one before sending',
      );
    }

    const existing = queryOne<TurnRow>(
      `SELECT * FROM hq_chat_turns
        WHERE company_id = ? AND session_id = ? AND client_request_id = ? AND owner_subject = ?`,
      [scope.companyId, sessionId, input.clientRequestId, scope.ownerSubject],
    );
    if (existing) {
      if (existing.payload_hash !== hash) {
        return fail(409, 'request_conflict', 'this request key was already used with different content');
      }
      return { ok: true, turn: toTurnView(existing), duplicate: true };
    }

    const turnId = randomUUID();
    try {
      run(
        `INSERT INTO hq_chat_turns
           (id, company_id, session_id, owner_subject, client_request_id, payload_hash, message_text,
            reply_text, state, attempts, lease_token, lease_expires_at, gateway_session_key,
            source_run_id, task_id, error_code, created_at, updated_at, terminal_at, content_expired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'queued', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
        [turnId, scope.companyId, sessionId, scope.ownerSubject, input.clientRequestId, hash, message, at, at],
      );
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      // S6 partial unique index on (company_id,session_id) for the four nonterminal states.
      if (code.startsWith('SQLITE_CONSTRAINT')) {
        // A concurrent identical insert loses the (company_id,session_id,client_request_id) race.
        const raced = queryOne<TurnRow>(
          `SELECT * FROM hq_chat_turns
            WHERE company_id = ? AND session_id = ? AND client_request_id = ? AND owner_subject = ?`,
          [scope.companyId, sessionId, input.clientRequestId, scope.ownerSubject],
        );
        if (raced && raced.payload_hash === hash) return { ok: true, turn: toTurnView(raced), duplicate: true };
        if (raced) return fail(409, 'request_conflict', 'this request key was already used with different content');
        return fail(409, 'turn_in_progress', 'a turn is already in progress for this session');
      }
      throw err;
    }

    run(`UPDATE hq_chat_sessions SET last_activity_at = ? WHERE id = ? AND company_id = ?`, [
      at,
      sessionId,
      scope.companyId,
    ]);
    const row = queryOne<TurnRow>(`SELECT * FROM hq_chat_turns WHERE id = ? AND company_id = ?`, [
      turnId,
      scope.companyId,
    ]);
    return { ok: true, turn: toTurnView(row as TurnRow), duplicate: false };
  });

  return outcome;
}

/* ================================================================== *
 * Claim — CAS and fencing lease
 * ================================================================== */

const selectTurn = (scope: HqChatScope, turnId: string): TurnRow | undefined =>
  queryOne<TurnRow>(
    `SELECT * FROM hq_chat_turns WHERE id = ? AND company_id = ? AND owner_subject = ?`,
    [turnId, scope.companyId, scope.ownerSubject],
  );

/**
 * Claim a `queued` turn by atomic compare-and-swap to `sending`, incrementing the
 * attempt count and assigning the random fencing lease BEFORE any network operation.
 *
 * The gateway session key `agent:<verifiedRuntimeId>:hq-<opaqueTurnId>` (S9) is minted
 * once, server-side, and stays on the turn forever: "stores it once on the turn, and
 * never reuses it for another turn". A retry of the same turn reuses it, which is what
 * makes "positively-unsent retries may use the same turn key" possible.
 */
export function claimTurn(
  scope: HqChatScope,
  turnId: string,
  opts: { nowMs?: number } = {},
): HqChatResult<{ turn: HqChatTurn; leaseToken: string; gatewaySessionKey: string }> {
  const at = nowMs(opts.nowMs);
  const row = selectTurn(scope, turnId);
  if (!row) return fail(404, 'not_found', 'turn not found for this company and owner');
  if (row.state !== 'queued') return fail(409, 'turn_not_claimable', `turn is ${row.state}, not queued`);
  if (row.attempts >= HQ_CHAT_MAX_ATTEMPTS) return fail(409, 'turn_not_retryable', 'attempt limit reached');

  const session = queryOne<SessionRow>(
    `SELECT * FROM hq_chat_sessions WHERE id = ? AND company_id = ?`,
    [row.session_id, scope.companyId],
  );
  if (!session) return fail(404, 'not_found', 'session row missing for turn');
  if (session.closed_at !== null) return fail(410, 'session_closed', 'session is closed; existing authorized history remains readable');

  const leaseToken = randomUUID();
  const gatewaySessionKey = row.gateway_session_key ?? `agent:${session.runtime_agent_id}:hq-${row.id}`;
  const changes = run(
    `UPDATE hq_chat_turns
        SET state = 'sending', attempts = attempts + 1, lease_token = ?, lease_expires_at = ?,
            gateway_session_key = COALESCE(gateway_session_key, ?), updated_at = ?
      WHERE id = ? AND company_id = ? AND owner_subject = ? AND state = 'queued' AND attempts < ?`,
    [leaseToken, leaseExpiry(at), gatewaySessionKey, stamp(at), turnId, scope.companyId, scope.ownerSubject, HQ_CHAT_MAX_ATTEMPTS],
  ).changes;
  if (changes !== 1) return fail(409, 'lease_lost', 'turn was claimed by another writer');

  const claimed = selectTurn(scope, turnId) as TurnRow;
  return { ok: true, turn: toTurnView(claimed), leaseToken, gatewaySessionKey };
}

/**
 * S9 retry endpoint. Accepts ONLY `failed_unsent`, attempts<3, no known gateway
 * acceptance, unexpired message content and an open owned session; re-claims with the
 * same request ID (the row keeps it). Timeout is never retried here — an uncertain send
 * is `reconciling`, and only a user's explicit "Send as new message" may follow it.
 */
export function retryTurn(
  scope: HqChatScope,
  turnId: string,
  opts: { nowMs?: number } = {},
): HqChatResult<{ turn: HqChatTurn; leaseToken: string; gatewaySessionKey: string }> {
  const at = nowMs(opts.nowMs);
  const row = selectTurn(scope, turnId);
  if (!row) return fail(404, 'not_found', 'turn not found for this company and owner');
  if (row.state !== 'failed_unsent') {
    return fail(409, 'turn_not_retryable', `only a positively-unsent turn may be retried (turn is ${row.state})`);
  }
  if (row.attempts >= HQ_CHAT_MAX_ATTEMPTS) return fail(409, 'turn_not_retryable', 'attempt limit reached');
  // 410, never resent empty: an expired turn is not silently re-materialized from a tombstone.
  if (isContentExpired(row, at)) return fail(410, 'content_expired', 'message content has expired; send a new message');

  const session = queryOne<SessionRow>(
    `SELECT * FROM hq_chat_sessions WHERE id = ? AND company_id = ?`,
    [row.session_id, scope.companyId],
  );
  if (!session) return fail(404, 'not_found', 'session row missing for turn');
  if (session.closed_at !== null) return fail(410, 'session_closed', 'session is closed; existing authorized history remains readable');

  const leaseToken = randomUUID();
  const gatewaySessionKey = row.gateway_session_key ?? `agent:${session.runtime_agent_id}:hq-${row.id}`;
  const changes = run(
    `UPDATE hq_chat_turns
        SET state = 'sending', attempts = attempts + 1, lease_token = ?, lease_expires_at = ?,
            gateway_session_key = COALESCE(gateway_session_key, ?), updated_at = ?
      WHERE id = ? AND company_id = ? AND owner_subject = ? AND state = 'failed_unsent' AND attempts < ?`,
    [leaseToken, leaseExpiry(at), gatewaySessionKey, stamp(at), turnId, scope.companyId, scope.ownerSubject, HQ_CHAT_MAX_ATTEMPTS],
  ).changes;
  if (changes !== 1) return fail(409, 'lease_lost', 'turn changed before the retry could claim it');

  const claimed = selectTurn(scope, turnId) as TurnRow;
  return { ok: true, turn: toTurnView(claimed), leaseToken, gatewaySessionKey };
}

/* ================================================================== *
 * Fenced lifecycle transitions
 * ================================================================== */

/**
 * Every update below is fenced by the current lease token AND the state it expects, so an
 * obsolete writer (expired lease, superseded attempt) can never mutate its turn. The
 * returned `ok:false` is the fence doing its job, not an error path.
 */
type Fence = { scope: HqChatScope; turnId: string; leaseToken: string; from: readonly HqChatTurnState[] };

const fencedUpdate = (fence: Fence, setSql: string, params: unknown[]): boolean => {
  const placeholders = fence.from.map(() => '?').join(', ');
  return (
    run(
      `UPDATE hq_chat_turns SET ${setSql}
        WHERE id = ? AND company_id = ? AND owner_subject = ? AND lease_token = ? AND state IN (${placeholders})`,
      [...params, fence.turnId, fence.scope.companyId, fence.scope.ownerSubject, fence.leaseToken, ...fence.from],
    ).changes === 1
  );
};

/** S9: acceptance is not completion — this only moves `sending` to `awaiting_reply`. */
export function recordSendAccepted(
  scope: HqChatScope,
  turnId: string,
  leaseToken: string,
  input: { sourceRunId?: string | null } = {},
): HqChatResult<{ turn: HqChatTurn }> {
  const fence: Fence = { scope, turnId, leaseToken, from: ['sending'] };
  const ok = fencedUpdate(
    fence,
    `state = 'awaiting_reply', source_run_id = COALESCE(source_run_id, ?), updated_at = ?`,
    [input.sourceRunId ?? null, timeNow()],
  );
  if (!ok) return fail(409, 'lease_lost', 'send acceptance does not match this turn and lease');
  return { ok: true, turn: toTurnView(selectTurn(scope, turnId) as TurnRow) };
}

/** S9: transport positively proves nothing was sent. Terminal, and the only retryable state. */
export function recordSendFailedUnsent(
  scope: HqChatScope,
  turnId: string,
  leaseToken: string,
  input: { errorCode?: string | null; nowMs?: number } = {},
): HqChatResult<{ turn: HqChatTurn }> {
  const at = nowMs(input.nowMs);
  const ok = fencedUpdate(
    { scope, turnId, leaseToken, from: ['sending'] },
    `state = 'failed_unsent', lease_token = NULL, lease_expires_at = NULL, error_code = ?,
     terminal_at = ?, updated_at = ?`,
    [input.errorCode ?? null, stamp(input.nowMs), stamp(input.nowMs)],
  );
  if (!ok) return fail(409, 'lease_lost', 'unsent report does not match this turn and lease');
  return { ok: true, turn: toTurnView(selectTurn(scope, turnId) as TurnRow) };
}

/**
 * S9: timeout or any post-send uncertainty. `reconciling` never resends automatically and
 * is never `replied`; it resolves to a terminal result or to `unresolved` in the sweep.
 */
export function recordUncertain(
  scope: HqChatScope,
  turnId: string,
  leaseToken: string,
  input: { errorCode?: string | null } = {},
): HqChatResult<{ turn: HqChatTurn }> {
  const ok = fencedUpdate(
    { scope, turnId, leaseToken, from: ['sending', 'awaiting_reply'] },
    `state = 'reconciling', lease_token = NULL, lease_expires_at = NULL, error_code = ?, updated_at = ?`,
    [input.errorCode ?? 'delivery_uncertain', timeNow()],
  );
  if (!ok) return fail(409, 'lease_lost', 'uncertainty report does not match this turn and lease');
  return { ok: true, turn: toTurnView(selectTurn(scope, turnId) as TurnRow) };
}

/** S9: invalid target/policy — decided before any send, so no lease is required. */
export function refuseTurn(
  scope: HqChatScope,
  turnId: string,
  reason: string,
): HqChatResult<{ turn: HqChatTurn }> {
  const changes = run(
    `UPDATE hq_chat_turns
        SET state = 'refused', error_code = ?, terminal_at = ?, updated_at = ?
      WHERE id = ? AND company_id = ? AND owner_subject = ? AND state = 'queued' AND attempts = 0`,
    [reason, timeNow(), timeNow(), turnId, scope.companyId, scope.ownerSubject],
  ).changes;
  if (changes !== 1) return fail(409, 'lease_lost', 'turn cannot be refused in its current state');
  return { ok: true, turn: toTurnView(selectTurn(scope, turnId) as TurnRow) };
}

/** Process-local throttle only; losing it costs one extra write, never correctness. */
const partialPersistedAt = new Map<string, number>();

/**
 * S9 streaming persistence: at most once per second, capped accumulator, labelled partial
 * until terminal. `truncated` reports honestly that the accumulator hit the cap; S6 gives
 * the turn no truncation column, so surfacing it is the caller's (route/UI) choice.
 */
export function recordPartial(
  scope: HqChatScope,
  turnId: string,
  leaseToken: string,
  accumulatedText: string,
  opts: { nowMs?: number } = {},
): HqChatResult<{ persisted: boolean; truncated: boolean }> {
  const at = nowMs(opts.nowMs);
  const truncated = accumulatedText.length > HQ_CHAT_PARTIAL_CAP;
  const text = truncated ? accumulatedText.slice(0, HQ_CHAT_PARTIAL_CAP) : accumulatedText;

  const last = partialPersistedAt.get(turnId);
  if (last !== undefined && at - last < HQ_CHAT_PARTIAL_PERSIST_MS) {
    return { ok: true, persisted: false, truncated };
  }
  const ok = fencedUpdate(
    { scope, turnId, leaseToken, from: ['sending', 'awaiting_reply'] },
    `reply_text = ?, updated_at = ?`,
    [text, stamp(opts.nowMs)],
  );
  if (!ok) return fail(409, 'lease_lost', 'partial update does not match this turn and lease');
  partialPersistedAt.set(turnId, at);
  return { ok: true, persisted: true, truncated };
}

/**
 * S9 completion evidence. `yielded` finals and empty finals are NOT completion: an empty
 * final leaves the turn reconciling (previously buffered partial text stays labelled
 * partial) rather than fabricating a reply. The first observed runId is recorded;
 * a different runId on this turn's key is ignored, never relabelled.
 */
export function recordCompletion(
  scope: HqChatScope,
  turnId: string,
  leaseToken: string,
  input: { sourceRunId?: string | null; visibleText: string; yielded?: boolean; nowMs?: number } = {
    visibleText: '',
  },
): HqChatResult<{ turn: HqChatTurn; completed: boolean }> {
  const at = nowMs(input.nowMs);
  if (input.yielded === true) return fail(409, 'not_completion', 'yielded final is not completion evidence');

  const row = selectTurn(scope, turnId);
  if (!row) return fail(404, 'not_found', 'turn not found for this company and owner');
  if (
    row.source_run_id !== null &&
    input.sourceRunId != null &&
    row.source_run_id !== input.sourceRunId
  ) {
    return fail(409, 'run_mismatch', 'a different run id on this turn is ignored, not relabelled');
  }

  const text = (input.visibleText ?? '').trim();
  const completed = text.length > 0;
  const ok = fencedUpdate(
    { scope, turnId, leaseToken, from: ['awaiting_reply'] },
    `state = ?, reply_text = ?, source_run_id = COALESCE(source_run_id, ?), lease_token = NULL,
     lease_expires_at = NULL, terminal_at = ?, updated_at = ?`,
    [
      completed ? 'replied' : 'reconciling',
      completed ? text : row.reply_text,
      input.sourceRunId ?? null,
      completed ? stamp(input.nowMs) : null,
      stamp(input.nowMs),
    ],
  );
  if (!ok) return fail(409, 'lease_lost', 'completion does not match this turn and lease');
  if (completed) partialPersistedAt.delete(turnId);
  return { ok: true, turn: toTurnView(selectTurn(scope, turnId) as TurnRow), completed };
}

/** Non-completion callbacks report `completed:false`; only a real completion sets it true. */
const withCompleted = (
  result: HqChatResult<{ turn: HqChatTurn }>,
): HqChatResult<{ turn: HqChatTurn; completed: boolean }> =>
  result.ok ? { ok: true, turn: result.turn, completed: false } : result;

/**
 * S9: the typed lifecycle callback from V07/B11 is the ONLY completion path. The callback
 * carries session/turn correlation; the caller supplies its lease and any payload detail.
 */
export function applyTransportCallback(
  scope: HqChatScope,
  callback: HqChatTransportCallback,
  leaseToken: string,
  detail: { sourceRunId?: string | null; visibleText?: string; yielded?: boolean; errorCode?: string | null; nowMs?: number } = {},
): HqChatResult<{ turn: HqChatTurn; completed: boolean }> {
  // Session correlation is checked, not assumed: the callback must address this turn's session.
  const row = selectTurn(scope, callback.turnId);
  if (!row) return fail(404, 'not_found', 'turn not found for this company and owner');
  if (row.session_id !== callback.sessionId) {
    return fail(409, 'not_found', 'callback session does not own this turn');
  }
  if (row.gateway_session_key !== null && row.gateway_session_key !== callback.gatewaySessionKey) {
    return fail(409, 'run_mismatch', 'callback gateway key does not match this turn');
  }

  switch (callback.kind) {
    case 'send_accepted':
      return withCompleted(recordSendAccepted(scope, callback.turnId, leaseToken, { sourceRunId: detail.sourceRunId ?? null }));
    case 'failed_before_send':
      return withCompleted(
        recordSendFailedUnsent(scope, callback.turnId, leaseToken, { errorCode: detail.errorCode ?? null, nowMs: detail.nowMs }),
      );
    case 'timeout':
      return withCompleted(recordUncertain(scope, callback.turnId, leaseToken, { errorCode: detail.errorCode ?? 'timeout' }));
    case 'completion_observed':
      return recordCompletion(scope, callback.turnId, leaseToken, {
        sourceRunId: detail.sourceRunId ?? null,
        visibleText: detail.visibleText ?? '',
        yielded: detail.yielded,
        nowMs: detail.nowMs,
      });
  }
}

/* ================================================================== *
 * Reads
 * ================================================================== */

export function getTurn(scope: HqChatScope, turnId: string): HqChatTurn | null {
  const row = selectTurn(scope, turnId);
  return row ? toTurnView(row) : null;
}

export function listTurns(
  scope: HqChatScope,
  sessionId: string,
  opts: { limit?: number } = {},
): HqChatTurn[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return queryAll<TurnRow>(
    `SELECT * FROM hq_chat_turns
      WHERE company_id = ? AND owner_subject = ? AND session_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
    [scope.companyId, scope.ownerSubject, sessionId, limit],
  ).map(toTurnView);
}

/* ================================================================== *
 * Stale sweep (S9: "check stale nonterminal turns once per minute")
 * ================================================================== */

/**
 * Bounded housekeeping for nonterminal turns. Registration of the once-a-minute job is the
 * scheduler owner's (A01/A05); this function is the work it calls.
 *
 *   - an expired `sending`/`awaiting_reply` lease is neither a success nor a proven non-send,
 *     so it becomes `reconciling` and is never resent automatically;
 *   - a `reconciling` turn that stays undecided past the 10-minute window ends `unresolved`;
 *   - a `queued` turn with attempts 0 is left alone: it is durable and safe to claim once.
 *
 * Two clocks, deliberately: `lease_expires_at` is epoch milliseconds (an exact integer
 * compare) while `updated_at` is ISO-8601 TEXT. `at` is the sweep instant; production
 * callers omit it and every writer stamps `updated_at` from the same wall clock.
 */
export function sweepStaleTurns(at: number = Date.now()): { reconciling: number; unresolved: number } {
  const reconciling = run(
    `UPDATE hq_chat_turns
        SET state = 'reconciling', lease_token = NULL, lease_expires_at = NULL, updated_at = ?,
            error_code = COALESCE(error_code, 'lease_expired')
      WHERE state IN ('sending', 'awaiting_reply')
        AND lease_expires_at IS NOT NULL AND ${sqlTime('lease_expires_at')} <= ${sqlTime('?')}`,
    [stamp(at), stamp(at)],
  ).changes;

  const unresolvedBound = new Date(at - HQ_CHAT_UNRESOLVED_AFTER_MS).toISOString();
  const unresolved = run(
    `UPDATE hq_chat_turns
        SET state = 'unresolved', terminal_at = ?, updated_at = ?,
            error_code = COALESCE(error_code, 'reconciliation_window_expired')
      WHERE state = 'reconciling' AND updated_at <= ?`,
    [stamp(at), stamp(at), unresolvedBound],
  ).changes;

  return { reconciling, unresolved };
}

/** Exported for the fixture check that the one-active-turn index matches the state set. */
export const HQ_CHAT_NONTERMINAL_STATES: readonly HqChatTurnState[] = NONTERMINAL_STATES;

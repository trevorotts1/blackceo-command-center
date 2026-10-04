/**
 * PRIVATE TEST STUB — declares the B09 seam (`CC:src/lib/hq/chat.ts`) that this unit's
 * routes import and that does not exist yet on branch `hq/contracts`.
 *
 * swarm-plan `base_policy`: "Contract consumers import declared names and use existing
 * test mocks/private test stubs only for absent implementations; never ship mocks."
 * Test-only: reached through `paths` in `tests/unit/hq/B10/tsconfig.b10.json`, never by
 * a shipped route in a real build. At assembly the real B09 service must implement this
 * declared surface; a mismatch is an INTERFACE_PASS build error, not a silent
 * substitution.
 *
 * Declared surface (B10 route family ↔ B09 service), derived from SPEC S8/S9:
 *   createHqSession  — S8 POST /sessions: resolve authorized head + runtime binding,
 *                      server-minted session; 409 runtime unavailable.
 *   getHqSession     — ownership gate every session-scoped route runs FIRST:
 *                      404 unknown/foreign, 410 expired owned session (S6 line 255).
 *   listHqTurns      — S8 GET /sessions/{id}: paginated private turns.
 *   createHqTurn     — S9 durable turn protocol: foreign-before-dedupe, identical
 *                      duplicate returns the existing turn, changed content under the
 *                      same key is 409 `request_conflict`, a second turn while one is
 *                      nonterminal is 409 `turn_in_progress`.
 *   getHqTurn        — S8 GET /turns/{turnId}: state + persisted reply/partial.
 *   retryHqTurn      — S9 retry: only `failed_unsent`, attempts<3, unexpired content;
 *                      content-expired turn is 410; never an implicit new turn.
 *
 * The service (not the route) is where dedupe, lease/CAS and expiration are decided —
 * B09 owns that state machine. These routes own identity, strict validation, the HTTP
 * mapping of each outcome and the response envelope.
 */
import type { HqChatSession, HqChatTurn } from '@/lib/hq/types';
import type { HqContext } from '@/lib/hq/context';

/** HTTP-mappable service outcome. `status`/`code`/`message` are already the values the
 *  route envelope must publish; the route never invents a status for a known refusal. */
export type HqChatServiceError = {
  ok: false;
  status: number;
  code: string;
  message: string;
  retryable?: boolean;
};

export type HqChatServiceResult<T = Record<string, unknown>> = ({ ok: true } & T) | HqChatServiceError;

export interface HqTurnListPage {
  turns: HqChatTurn[];
  hasMore: boolean;
  nextBefore: string | null;
}

type FnName = 'createHqSession' | 'getHqSession' | 'listHqTurns' | 'createHqTurn' | 'getHqTurn' | 'retryHqTurn';

interface Control {
  /** Call order with arguments — how tests prove foreign-before-dedupe. */
  calls: { fn: FnName; args: unknown[] }[];
  /** One queued result per call; shift() as calls arrive. Empty queue = unarmed stub. */
  queue: Record<FnName, HqChatServiceResult<unknown>[]>;
}

export const __hqChatControl: Control = {
  calls: [],
  queue: { createHqSession: [], getHqSession: [], listHqTurns: [], createHqTurn: [], getHqTurn: [], retryHqTurn: [] },
};

export function __hqChatPush(fn: FnName, result: HqChatServiceResult): void {
  __hqChatControl.queue[fn].push(result);
}

function consume<T>(fn: FnName, ...args: unknown[]): HqChatServiceResult<T> {
  __hqChatControl.calls.push({ fn, args });
  const queued = __hqChatControl.queue[fn].shift() as HqChatServiceResult<T> | undefined;
  if (!queued) throw new Error(`hq chat stub not armed for ${fn}`);
  return queued;
}

export async function createHqSession(ctx: HqContext, headAgentId: string): Promise<HqChatServiceResult<{ session: HqChatSession }>> {
  return consume('createHqSession', ctx, headAgentId);
}

export async function getHqSession(ctx: HqContext, sessionId: string): Promise<HqChatServiceResult<{ session: HqChatSession }>> {
  return consume('getHqSession', ctx, sessionId);
}

export async function listHqTurns(
  ctx: HqContext,
  sessionId: string,
  page: { limit: number; before?: string },
): Promise<HqChatServiceResult<HqTurnListPage>> {
  return consume('listHqTurns', ctx, sessionId, page);
}

export async function createHqTurn(
  ctx: HqContext,
  sessionId: string,
  body: { clientRequestId: string; message: string },
): Promise<HqChatServiceResult<{ turn: HqChatTurn; duplicate: boolean }>> {
  return consume('createHqTurn', ctx, sessionId, body);
}

export async function getHqTurn(ctx: HqContext, sessionId: string, turnId: string): Promise<HqChatServiceResult<{ turn: HqChatTurn }>> {
  return consume('getHqTurn', ctx, sessionId, turnId);
}

export async function retryHqTurn(ctx: HqContext, sessionId: string, turnId: string): Promise<HqChatServiceResult<{ turn: HqChatTurn }>> {
  return consume('retryHqTurn', ctx, sessionId, turnId);
}

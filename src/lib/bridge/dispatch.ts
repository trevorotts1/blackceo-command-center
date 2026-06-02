/**
 * Server-only Bridge dispatch helpers (E12 / E21 / E22).
 *
 * Kept SEPARATE from `./agents.ts` on purpose: `agents.ts` is imported by the
 * client components `BridgeChat` and `AgentSelector` (for `BRIDGE_AGENTS` + the
 * `BridgeAgent` type), so it must stay free of server-only imports
 * (`child_process`, the OpenClaw WS client, the DB). This module pulls in those
 * server modules and is therefore only safe to import from route handlers and
 * server actions.
 *
 * It provides the two things a dispatch path needs to be PER-CLIENT:
 *
 *   - `bridgeOpenClawTarget()` — the SELECTED client's OpenClaw gateway target
 *     (token + CF-Access headers), to hand straight to
 *     `getOpenClawClient(target)` (E21/E22 "real reply stream").
 *   - `withClientContext()` — prepend the operator's active goals to a turn so
 *     the client agent always has them in context (E12 dispatch injection).
 */

import {
  getClientContext,
  clientToOpenClawTarget,
  type OpenClawTarget,
} from '@/lib/clients';
import { buildGoalsContext } from '@/lib/operator/goals';

/**
 * Resolve the OpenClaw gateway target for the SELECTED client (E21/E22).
 *
 * Pass the result straight into `getOpenClawClient(target)`. For the operator's
 * own box this resolves to the reserved `__self__` target, so `getOpenClawClient`
 * returns the historical loopback singleton (fully backward compatible).
 * Returns `undefined` only when the clients table is empty, in which case
 * `getOpenClawClient(undefined)` also yields the self singleton.
 */
export function bridgeOpenClawTarget(): OpenClawTarget | undefined {
  const client = getClientContext();
  return client ? clientToOpenClawTarget(client) : undefined;
}

/**
 * Prepend the operator's active-goals context (E12) to a dispatched turn.
 * Returns the original text unchanged when there are no active goals, so
 * callers can apply it unconditionally.
 */
export function withClientContext(userText: string): string {
  const goals = buildGoalsContext();
  if (!goals) return userText;
  return `${goals}\n\n---\n\n${userText}`;
}

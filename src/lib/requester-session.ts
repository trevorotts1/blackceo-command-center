/**
 * requester-session.ts — the ADDRESSABLE-SESSION half of the requester identity.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * P1-04 captured exactly one way to reach a requester: a Telegram chat id
 * (`tasks.requester_chat_id`). A request that arrives over a WEBCHAT session
 * has no chat id at all, so the whole report-back loop — ACK / PROGRESS /
 * BLOCKED / DONE and the audience-confirmation ask — had nothing to address.
 * The `requester_chat_id_missing` warning fired correctly and then nothing in
 * the system could ever close the gap: every requester lane fell back to an
 * operator channel or to silence, while the owner sat in a live gateway
 * session the box knew about.
 *
 * `tasks.requester_session_key` (migration 127) is the second address. It
 * holds the OpenClaw gateway session key for the conversation the request came
 * from, so the trust engine can deliver into that session when there is no
 * chat id.
 *
 * ── WHAT COUNTS AS A SESSION KEY ───────────────────────────────────────────
 * ONLY the gateway's own structured addressing form, `agent:<agentId>:<peer>`
 * — the shape `src/lib/ceo-chat/gateway.ts` builds (buildSessionKey) and the
 * only shape `sessions.create` / `sessions.send` accept on this gateway
 * version (a bare `{channel, peer}` pair is rejected outright; see
 * openclaw/client.ts's createSession comment).
 *
 * This strictness is the point. The ingest front door's `external_session_id`
 * field is documented for session keys but in live traffic mostly carries
 * PRODUCER run ids (`pres-mta0y199-qj40j3`, `tmp.Jwknz5wXuf`,
 * `<task-id>:P4-COPY`). Those are provenance, not addresses — nothing can be
 * delivered to them. Capturing them into `requester_session_key` would fill
 * the column with un-addressable values and turn every one of them into a
 * failed client-facing send. So the column only ever accepts a key the
 * delivery lane can actually reach.
 */

/**
 * The `requester_channel` value that means "deliver through the OpenClaw
 * gateway session named by `requester_session_key`" — the third lane alongside
 * 'telegram' and CEO_CHAT_CHANNEL.
 */
export const REQUESTER_SESSION_CHANNEL = 'session';

/**
 * The gateway's structured session-key form: `agent:<agentId>:<peer>`.
 * `agentId` carries no colon (it is a single path segment); `peer` may — e.g.
 * `agent:main:telegram:direct:123` is one agent addressing a composite peer.
 * Neither segment may contain whitespace: the key is an address, not prose,
 * and a value with a space in it is a description that leaked into the field.
 */
const GATEWAY_SESSION_KEY = /^agent:[^\s:]+:[^\s]+$/;

/** True when `value` is a session key the gateway can actually be asked to address. */
export function isGatewaySessionKey(value: unknown): value is string {
  return typeof value === 'string' && GATEWAY_SESSION_KEY.test(value.trim());
}

/**
 * Normalize a candidate session key for storage: trimmed when it is a real
 * addressable gateway key, otherwise `null`. Never throws, never guesses — a
 * producer run id or a free-text note returns null rather than being stored as
 * an address the delivery lane would later fail on.
 */
export function normalizeRequesterSessionKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return GATEWAY_SESSION_KEY.test(trimmed) ? trimmed : null;
}

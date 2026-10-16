/**
 * Company Headquarters — canonical frozen contracts (unit P01, milestone V02).
 *
 * Authority: SPEC.md revision 4, sections S3–S9. This module freezes exactly what
 * the SPEC defines and nothing more. Where the SPEC names a fact but defines no
 * shape, the field is typed `unknown` and the gap is recorded in
 * `evidence/contracts/interfaces.md` (project) under S17 change control — the
 * first consumer to need it freezes it, this file does not invent it.
 *
 * Contract consumers import these names; they do not redeclare them (swarm-plan
 * base_policy). Producer envelopes (S7), activity read-route queries (S8) and chat
 * request bodies (S8/S9) validate with the exported schemas. The canonical
 * semantic-hash byte rules (S7) are translated by `hqSemanticSerialize`; the
 * SHA-256 digest step stays with server-side consumers so this module remains
 * importable from client components (no `node:*` imports).
 */
import { z } from 'zod';

/* ================================================================== *
 * SPEC S3 — company and workforce identity
 * ================================================================== */

export const HQ_STAFFING = ['permanent', 'on-call'] as const;
export type HqStaffing = (typeof HQ_STAFFING)[number];

export const HQ_BINDING_KINDS = ['explicit', 'department-shared', 'unbound'] as const;
export type HqBindingKind = (typeof HQ_BINDING_KINDS)[number];

export const HQ_AGENT_STATUSES = ['standby', 'working', 'busy', 'degraded', 'offline', 'unknown'] as const;
export type HqAgentStatus = (typeof HQ_AGENT_STATUSES)[number];

export const HQ_PROVISIONING_STATES = ['ready', 'incomplete', 'unknown'] as const;
export type HqProvisioning = (typeof HQ_PROVISIONING_STATES)[number];

/**
 * S3 roster projection. Only known values map to themselves; an unrecognized
 * status becomes `'unknown'` at the projection boundary with the raw value kept
 * for diagnostics only. `observedAt` references the source observation, never the
 * view fetch time. Department identity is `workspaces.id`.
 */
export type HqAgent = {
  id: string;
  workspaceId: string;
  displayName: string;
  role: string;
  isHead: boolean;
  staffing: HqStaffing;
  runtimeBound: boolean;
  canTalk: boolean;
  runtimeAgentId: string | null;
  bindingKind: HqBindingKind;
  sharedRoleIds: string[];
  status: HqAgentStatus;
  observedAt: string | null;
  activeTaskIds: string[];
};

export type HqDepartment = {
  id: string;
  slug: string;
  name: string;
  headAgentId: string | null;
  provisioning: HqProvisioning;
  agents: HqAgent[];
};

/* ================================================================== *
 * SPEC S4 — deterministic floor geometry
 * ================================================================== */

export type HqWorldPoint = { x: number; y: number };

/**
 * S4 seat. `screenX = x - y`, `screenY = (x + y) / 2` are the SPEC's isometric
 * projection of the world point.
 */
export type HqSeatLayout = {
  agentId: string;
  isHead: boolean;
  world: HqWorldPoint;
  screenX: number;
  screenY: number;
};

/**
 * S4 room. `width` is 480 world units; `height` is
 * `max(320, 144 + 72 * ceil(seatedCount / 4))`. Absolute room origin, seat column
 * indexing and label hit-area bounds are not defined by SPEC (gap G-05/G-06).
 */
export type HqRoomLayout = {
  workspaceId: string;
  world: HqWorldPoint;
  width: number;
  height: number;
  seats: HqSeatLayout[];
};

/** S4 derived layout. `revision` is the layout revision (gap G-07: hash input normalization). */
export type HqLayout = {
  revision: string;
  rooms: HqRoomLayout[];
};

/* ================================================================== *
 * SPEC S5/S6 — activity kinds, phases, public projection
 * ================================================================== */

export const HQ_ACTIVITY_KINDS = ['task', 'owner_note', 'decision', 'exchange'] as const;
export type HqActivityKind = (typeof HQ_ACTIVITY_KINDS)[number];

export const HQ_TASK_PHASES = ['created', 'assigned', 'status_changed'] as const;
export type HqTaskPhase = (typeof HQ_TASK_PHASES)[number];

export const HQ_OWNER_NOTE_PHASES = ['recorded'] as const;
export type HqOwnerNotePhase = (typeof HQ_OWNER_NOTE_PHASES)[number];

export const HQ_DECISION_PHASES = ['applied', 'shadow', 'unavailable'] as const;
export type HqDecisionPhase = (typeof HQ_DECISION_PHASES)[number];

export const HQ_EXCHANGE_PHASES = ['requested', 'accepted', 'replied', 'failed', 'uncertain'] as const;
export type HqExchangePhase = (typeof HQ_EXCHANGE_PHASES)[number];

export type HqActivityPhase = HqTaskPhase | HqOwnerNotePhase | HqDecisionPhase | HqExchangePhase;

/** S5 safe fields only; public summary cap is 2,000 characters. */
export type HqPublicTaskPayload = { status: string | null; previousStatus: string | null };
export type HqPublicOwnerNotePayload = { text: string };
/** S5 JEV receipt fields; missing fields are null (gap G-10: "with reason" representation). */
export type HqPublicDecisionPayload = {
  intent: string | null;
  routeAction: string | null;
  departmentSlug: string | null;
  confidenceBps: number | null;
  fallback: boolean | null;
  mode: string;
  resolvedBy: string | null;
};
/** S5 exchange detail after internal routing keys are stripped (gap G-09). */
export type HqPublicExchangePayload = { message: string | null; summary: string };

export type HqPublicActivityPayload =
  | HqPublicTaskPayload
  | HqPublicOwnerNotePayload
  | HqPublicDecisionPayload
  | HqPublicExchangePayload;

/**
 * S5/S6 public feed row. Field names here are P01's frozen naming of the SPEC's
 * content list (source, actor/recipient labels from current scope, occurred and
 * received times, truthful phase, reference) — see gap G-08.
 */
export type HqActivityEvent = {
  id: string;
  seq: number;
  kind: HqActivityKind;
  phase: HqActivityPhase;
  taskId: string | null;
  actorLabel: string | null;
  recipientLabel: string | null;
  occurredAt: string | null;
  receivedAt: string;
  reference: string;
  payload: HqPublicActivityPayload;
};

/**
 * S7 SSE invalidation: content-free, company-scoped, high-water cursor only.
 * Private chat content/turn IDs are never emitted here.
 */
export type HqChangedEvent = {
  type: 'hq_changed';
  companyId: string;
  highSeq: number;
};

/* ================================================================== *
 * SPEC S7 — versioned producer envelope (normative shapes)
 * ================================================================== */

export const HQ_ENVELOPE_SCHEMA_VERSION = 1 as const;

export const HQ_TOOL_NAMES = ['sessions_send', 'sessions_spawn', 'task_dispatch'] as const;
export type HqToolName = (typeof HQ_TOOL_NAMES)[number];

export const HQ_SOURCE_HOOKS = ['before_tool_call', 'after_tool_call', 'lifecycle', 'task_dispatch'] as const;
export type HqSourceHook = (typeof HQ_SOURCE_HOOKS)[number];

export const HQ_NATIVE_STATUSES = ['accepted', 'ok', 'timeout', 'error', 'forbidden', 'no_reply', 'queued', 'end'] as const;
export type HqNativeStatus = (typeof HQ_NATIVE_STATUSES)[number];

export const HQ_TARGET_DISPOSITIONS = ['queued', 'steered'] as const;
export type HqTargetDisposition = (typeof HQ_TARGET_DISPOSITIONS)[number];

export const HQ_CORRELATION_STATUSES = ['linked', 'unresolved', 'unsupported'] as const;
export type HqCorrelationStatus = (typeof HQ_CORRELATION_STATUSES)[number];

/** S7 task payload: strings/null. */
export const hqTaskPayloadSchema = z.strictObject({
  status: z.string().nullable(),
  previousStatus: z.string().nullable(),
});

/** S7 owner_note payload (gap G-11: SPEC gives no numeric text bound for this kind). */
export const hqOwnerNotePayloadSchema = z.strictObject({
  text: z.string(),
});

/** S7 decision payload: nullable except mode; confidence is integer basis points 0..10000 (no floats). */
export const hqDecisionPayloadSchema = z.strictObject({
  intent: z.string().nullable(),
  routeAction: z.string().nullable(),
  departmentSlug: z.string().nullable(),
  confidenceBps: z.int().min(0).max(10000).nullable(),
  fallback: z.boolean().nullable(),
  mode: z.string(),
  resolvedBy: z.string().nullable(),
});

/**
 * S7 exchange payload. Session keys are bounded to 512 characters and are
 * populated only from host context / validated native after-result or lifecycle
 * data, never from raw model-requested target parameters.
 */
export const hqExchangePayloadSchema = z.strictObject({
  message: z.string().max(8000).nullable(),
  summary: z.string().max(2000),
  toolName: z.enum(HQ_TOOL_NAMES),
  toolCallId: z.string().nullable(),
  callerRunId: z.string().nullable(),
  targetRunId: z.string().nullable(),
  callerSessionKey: z.string().max(512).nullable(),
  targetSessionKey: z.string().max(512).nullable(),
  sourceHook: z.enum(HQ_SOURCE_HOOKS),
  nativeStatus: z.enum(HQ_NATIVE_STATUSES).nullable(),
  targetDisposition: z.enum(HQ_TARGET_DISPOSITIONS).nullable(),
  correlationStatus: z.enum(HQ_CORRELATION_STATUSES),
});

/** S7: all keys present; null is not omission; unknown keys rejected. */
const hqProducerEventBase = {
  eventId: z.string(),
  sourceKey: z.string(),
  installationId: z.string(),
  companyId: z.string(),
  issuedAt: z.string(),
  occurredAt: z.string().nullable(),
  taskId: z.string().nullable(),
  actorRuntimeId: z.string().nullable(),
  recipientRuntimeId: z.string().nullable(),
  fromWorkspaceId: z.string().nullable(),
  toWorkspaceId: z.string().nullable(),
  exchangeId: z.string().nullable(),
};

const hqTaskEventSchema = z.strictObject({
  ...hqProducerEventBase,
  kind: z.literal('task'),
  phase: z.enum(HQ_TASK_PHASES),
  payload: hqTaskPayloadSchema,
});

const hqOwnerNoteEventSchema = z.strictObject({
  ...hqProducerEventBase,
  kind: z.literal('owner_note'),
  phase: z.enum(HQ_OWNER_NOTE_PHASES),
  payload: hqOwnerNotePayloadSchema,
});

const hqDecisionEventSchema = z.strictObject({
  ...hqProducerEventBase,
  kind: z.literal('decision'),
  phase: z.enum(HQ_DECISION_PHASES),
  payload: hqDecisionPayloadSchema,
});

const hqExchangeEventSchema = z.strictObject({
  ...hqProducerEventBase,
  kind: z.literal('exchange'),
  phase: z.enum(HQ_EXCHANGE_PHASES),
  payload: hqExchangePayloadSchema,
});

export type HqTaskEvent = z.infer<typeof hqTaskEventSchema>;
export type HqOwnerNoteEvent = z.infer<typeof hqOwnerNoteEventSchema>;
export type HqDecisionEvent = z.infer<typeof hqDecisionEventSchema>;
export type HqExchangeEvent = z.infer<typeof hqExchangeEventSchema>;

/** S7 kinds/phases pairing, enforced by the discriminated union on `kind`. */
export const hqProducerEventSchema = z.discriminatedUnion('kind', [
  hqTaskEventSchema,
  hqOwnerNoteEventSchema,
  hqDecisionEventSchema,
  hqExchangeEventSchema,
]);

export type HqProducerEvent = z.infer<typeof hqProducerEventSchema>;

/** S7 outer envelope. The semantic hash covers `event` only; `sentAt` is signature-covered (gap G-12). */
export const hqProducerEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(HQ_ENVELOPE_SCHEMA_VERSION),
  sentAt: z.string(),
  event: hqProducerEventSchema,
  contentHash: z.string(),
});

export type HqProducerEnvelope = z.infer<typeof hqProducerEnvelopeSchema>;

/* ================================================================== *
 * SPEC S7 — canonic8al semantic serialization
 * ================================================================== */

/**
 * True when `jsonText` contains an object with a duplicate key (SPEC S7 rejects
 * duplicates before hashing). `JSON.parse` collapses duplicates, so this scan
 * runs on the raw text. Keys are compared after JSON decoding, so `"a"` and
 * `"a"` collide correctly. Returns false for text the scanner cannot read;
 * `JSON.parse` rejects malformed input separately.
 */
export function hqHasDuplicateObjectKeys(jsonText: string): boolean {
  const stack: { keys: Set<string> | null; wantKey: boolean }[] = [];
  const valueDone = () => {
    const top = stack[stack.length - 1];
    if (top && top.keys) top.wantKey = true;
  };
  let i = 0;
  const n = jsonText.length;
  while (i < n) {
    const ch = jsonText[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && jsonText[j] !== '"') j += jsonText[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.keys && top.wantKey) {
        let key: string;
        try {
          key = JSON.parse(jsonText.slice(i, j + 1)) as string;
        } catch {
          return false;
        }
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.wantKey = false;
      } else {
        valueDone();
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      stack.push({ keys: new Set<string>(), wantKey: true });
      i += 1;
      continue;
    }
    if (ch === '[') {
      stack.push({ keys: null, wantKey: false });
      i += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      valueDone();
      i += 1;
      continue;
    }
    if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top && top.keys) top.wantKey = true;
      i += 1;
      continue;
    }
    if (ch === ':') {
      i += 1;
      continue;
    }
    while (i < n && ',}] \t\n\r'.indexOf(jsonText[i]) === -1) i += 1;
    valueDone();
  }
  return false;
}

/** Rejects lone surrogates, which SPEC S7 excludes from the canonical bytes. */
function hqAssertNoLoneSurrogate(text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) throw new Error('semantic value contains a lone surrogate');
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('semantic value contains a lone surrogate');
    }
  }
}

/**
 * SPEC S7 canonical serialization: lexicographically sorted keys at every object
 * level, no whitespace, UTF-8 Unicode emitted directly, JSON control/quote/
 * backslash escapes, no floats. Byte-identical to Python
 * `json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)`.
 * Rejects NaN, Infinity, non-integers, integers outside `Number.isSafeInteger`
 * (whose `String()` form can diverge from Python), lone surrogates and any value
 * that is not a JSON kind. Duplicate keys cannot exist in a parsed value; call
 * `hqHasDuplicateObjectKeys` on raw text before parsing (gap G-13).
 */
export function hqSemanticSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    hqAssertNoLoneSurrogate(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('semantic value has a non-integer or unsafe number');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(hqSemanticSerialize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((key) => `${hqSemanticSerialize(key)}:${hqSemanticSerialize(record[key])}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`semantic value has unsupported type ${typeof value}`);
}

/**
 * SHA-256 of the canonical bytes, lowercase hex. Async only because WebCrypto is
 * the dependency-free digest; server-side callers may instead hash
 * `hqSemanticSerialize(event)` bytes with `node:crypto` (identical result).
 */
export async function hqSemanticHashHex(event: HqProducerEvent): Promise<string> {
  const bytes = new TextEncoder().encode(hqSemanticSerialize(event));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* ================================================================== *
 * SPEC S8 — read-route request/response contracts
 * ================================================================== */

/** S8: every successful response carries these; every error uses `HqApiErrorResponse`. */
export type HqApiSuccessBase = {
  schemaVersion: 1;
  generatedAt: string;
  companyId: string;
};

/**
 * S8 error codes named by the SPEC. Other error responses are specified by HTTP
 * status only (409 runtime unavailable, 413 oversize, 429 receipt capacity),
 * gap G-14.
 */
export const HQ_SPEC_ERROR_CODES = [
  'company_not_bound',
  'hq_direct_origin_required',
  'turn_in_progress',
  'request_conflict',
  'identity_switch_requires_signout',
  'event_expired',
  'head_binding_changed',
  'report_back_uncorrelated',
] as const;
export type HqApiNamedErrorCode = (typeof HQ_SPEC_ERROR_CODES)[number];

/** S8 error shape: `{error:{code,message,retryable},requestId}`, never raw exceptions or secrets. */
export type HqApiErrorResponse = {
  error: { code: string; message: string; retryable: boolean };
  requestId: string;
};

const hqNonnegativeSafeInt = z.coerce.number().int().min(0).refine(Number.isSafeInteger);

/** S8 `GET /api/hq/activity?after=N&through=M&limit=L`: forward page, N/M safe integers, L 1..200 default 100. */
export const hqActivityForwardQuerySchema = z.strictObject({
  after: hqNonnegativeSafeInt,
  through: hqNonnegativeSafeInt,
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** S8 older-history page: mutually exclusive with after/through (strict object rejects them). */
export const hqActivityOlderQuerySchema = z.strictObject({
  before: hqNonnegativeSafeInt,
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type HqActivityForwardQuery = z.infer<typeof hqActivityForwardQuerySchema>;
export type HqActivityOlderQuery = z.infer<typeof hqActivityOlderQuerySchema>;

/** S8 forward-page response field names are SPEC-given. */
export type HqActivityPageResponse = HqApiSuccessBase & {
  events: HqActivityEvent[];
  nextAfter: number;
  through: number;
  hasMore: boolean;
  resetRequired: boolean;
  prunedThroughSeq: number;
};

/** S8 snapshot response (field names highSeq/prunedThroughSeq/layoutRevision are SPEC-given). */
export type HqSnapshotResponse = HqApiSuccessBase & {
  roster: HqDepartment[];
  layout: HqLayout;
  /** G-01: S8 requires connection/capture health; SPEC defines no shape. */
  captureHealth: unknown;
  /** G-02: S8 requires current task links; SPEC defines no shape. */
  taskLinks: unknown;
  activities: HqActivityEvent[];
  highSeq: number;
  prunedThroughSeq: number;
  layoutRevision: string;
};

/** S8 activity detail: 404 for foreign/unknown, tombstone when the source was deleted (gap G-15). */
export type HqActivityDetailResponse = HqApiSuccessBase & {
  event: HqActivityEvent | null;
  tombstone: unknown;
};

/** S8 `POST /api/hq/chat/sessions`. */
export const hqChatSessionCreateSchema = z.strictObject({
  headAgentId: z.string(),
});

/** S8/S9 `POST /api/hq/chat/sessions/{id}/turns`: trim then apply the 32,000-character cap; never truncate. */
export const hqChatTurnCreateSchema = z.strictObject({
  clientRequestId: z.string(),
  message: z.string().trim().max(32000),
});

export type HqChatSessionCreateBody = z.infer<typeof hqChatSessionCreateSchema>;
export type HqChatTurnCreateBody = z.infer<typeof hqChatTurnCreateSchema>;

/* ================================================================== *
 * SPEC S9 — private head conversations
 * ================================================================== */

/** S9 durable turn states (exact set). */
export const HQ_CHAT_TURN_STATES = [
  'queued',
  'sending',
  'awaiting_reply',
  'replied',
  'failed_unsent',
  'refused',
  'reconciling',
  'unresolved',
] as const;
export type HqChatTurnState = (typeof HQ_CHAT_TURN_STATES)[number];

/** S9 lifecycle callbacks added to the HQ transport path; existing callers keep old behavior (gap G-16). */
export const HQ_CHAT_TRANSPORT_CALLBACK_KINDS = [
  'send_accepted',
  'completion_observed',
  'timeout',
  'failed_before_send',
] as const;
export type HqChatTransportCallbackKind = (typeof HQ_CHAT_TRANSPORT_CALLBACK_KINDS)[number];

export type HqChatTransportCallback = {
  kind: HqChatTransportCallbackKind;
  sessionId: string;
  turnId: string;
  gatewaySessionKey: string;
};

/**
 * S8/S9 authorized private session view: metadata only, never the gateway key
 * (gap G-17: field names are P01's frozen naming of S6/S8 requirements).
 */
export type HqChatSession = {
  id: string;
  headAgentId: string;
  createdAt: string;
  lastActivityAt: string;
  closedAt: string | null;
};

/**
 * S8/S9 authorized private turn view: persisted text, truthful state, partial
 * label while nonterminal, never the gateway key (gap G-17).
 */
export type HqChatTurn = {
  id: string;
  sessionId: string;
  state: HqChatTurnState;
  message: string;
  reply: string | null;
  partial: boolean;
  attempts: number;
  taskId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
};

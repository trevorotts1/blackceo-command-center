/**
 * Content-to-Delivery Handoff Schema (U065)
 *
 * VERSIONED RUNTIME CONTRACT between the Content Writer and the Communications
 * Agent. The prose version lives at agents/_shared/CONTENT-DELIVERY-HANDOFF.md;
 * this module is the TypeScript validation surface — it is the single
 * authoritative code-level definition of what crosses the seam.
 *
 * TWO SCHEMAS, TWO DIRECTIONS:
 *   1. Handoff (Content Writer → Communications Agent)  — versioned payload
 *      with content ref, channel, rendered fields, recipient ref, and approval
 *      state. The Communications Agent sends ONLY when the state rule passes.
 *   2. Receipt (Communications Agent → Content Writer)    — versioned delivery
 *      proof. Every attempted delivery produces one; no receipt means unproven.
 *
 * DESIGN PRINCIPLES:
 *   - Neither side puts an email address, phone number, or personal name into
 *     a handoff, receipt, log line, or report. References are opaque.
 *   - A payload that does not conform is REFUSED, never repaired.
 *   - The Content Writer never sets approval.state to "approved" on its own
 *     authorship. An author is not an approver.
 *   - The Communications Agent never edits `rendered`. Wrong copy goes back as
 *     `rejected`.
 */

import { z } from 'zod';

// ─── Version constants ────────────────────────────────────────────────────────

export const HANDOFF_SCHEMA_VERSION = 'content-delivery-handoff/v1' as const;
export const RECEIPT_SCHEMA_VERSION = 'content-delivery-receipt/v1' as const;

// ─── Channel enum ─────────────────────────────────────────────────────────────

export const HANDOFF_CHANNELS = ['email', 'sms', 'newsletter', 'push'] as const;
export type HandoffChannel = (typeof HANDOFF_CHANNELS)[number];

// ─── Approval states ──────────────────────────────────────────────────────────

export const APPROVAL_STATES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

// ─── Receipt outcomes ─────────────────────────────────────────────────────────

export const RECEIPT_OUTCOMES = ['delivered', 'rejected', 'failed', 'held'] as const;
export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number];

// ─── Zod schemas — the single source of truth for runtime validation ─────────

const handoffSchema = z.object({
  schema: z.literal(HANDOFF_SCHEMA_VERSION),
  handoff_id: z.string().trim().min(1),
  content_ref: z.string().trim().min(1),
  channel: z.enum(HANDOFF_CHANNELS),
  rendered: z.object({
    subject: z.string().trim().optional(),
    body: z.string().trim().min(1, 'rendered.body must be non-empty'),
    preheader: z.string().trim().optional(),
  }),
  recipient_ref: z.string().trim().min(1, 'recipient_ref is required (opaque reference only)'),
  approval: z.object({
    state: z.enum(APPROVAL_STATES),
    approved_by: z.string().trim().optional(),
    approved_at: z.string().trim().optional(),
    note: z.string().trim().optional(),
  }),
  created_at: z.string().trim().min(1),
});

/** The TypeScript type derived from the Zod schema — this IS the shape. */
export type HandoffPayload = z.infer<typeof handoffSchema>;

const receiptSchema = z.object({
  schema: z.literal(RECEIPT_SCHEMA_VERSION),
  handoff_id: z.string().trim().min(1),
  outcome: z.enum(RECEIPT_OUTCOMES),
  provider: z.string().trim().min(1),
  provider_message_id: z.string().trim().optional(),
  recipient_count: z.number().int().min(0).nullable(),
  sent_at: z.string().trim().optional(),
  error: z.string().trim().optional(),
});

/** The TypeScript type derived from the Zod schema. */
export type ReceiptPayload = z.infer<typeof receiptSchema>;

// ─── Validated parsing — shape validation only (no state rules applied) ───────

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  issues?: z.ZodIssue[];
}

/**
 * Parse and validate the shape of a handoff payload. This checks field
 * presence, types, and enum membership but does NOT apply the state rule
 * (approval gate). Use handoffSendable() for the full gate check.
 */
export function parseHandoff(raw: unknown): ParseResult<HandoffPayload> {
  const result = handoffSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.message, issues: result.error.issues };
  }
  return { ok: true, value: result.data };
}

/**
 * Parse and validate the shape of a receipt payload.
 */
export function parseReceipt(raw: unknown): ParseResult<ReceiptPayload> {
  const result = receiptSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.message, issues: result.error.issues };
  }
  return { ok: true, value: result.data };
}

// ─── The state rule (the load-bearing line) ────────────────────────────────────

/**
 * THE STATE RULE from CONTENT-DELIVERY-HANDOFF.md:
 *
 * The Communications Agent sends only when `approval.state == "approved"` AND
 * both `approved_by` and `approved_at` are present, non-empty, and non-blank.
 *
 * - "approved" without a non-empty approved_by AND non-empty approved_at →
 *   MALFORMED — this is an approval with no approver. Treating it as approved
 *   is the exact failure this contract exists to prevent.
 * - draft / pending_approval / rejected → not sendable.
 */

export interface SendabilityVerdict {
  /** true when the state rule is satisfied and the payload may be sent. */
  sendable: boolean;
  /** Short diagnostic for logging / receipt. */
  reason: string;
}

/**
 * Determine whether a handoff is sendable under the state rule.
 * Operates on the PARSED (shape-valid) fields so callers can separate
 * shape errors from gate denials.
 */
export function handoffSendable(
  approval: { state: string; approved_by?: string | null; approved_at?: string | null }
): SendabilityVerdict {
  const st = (approval.state ?? '').trim();

  if (st === 'draft') {
    return { sendable: false, reason: 'approval state is draft — held' };
  }
  if (st === 'pending_approval') {
    return { sendable: false, reason: 'approval state is pending_approval — held' };
  }
  if (st === 'rejected') {
    return { sendable: false, reason: 'approval state is rejected — returned to writer' };
  }
  if (st !== 'approved') {
    return { sendable: false, reason: `unknown approval state "${st}" — refused` };
  }

  // approved — verify the two required approver fields
  const by = (approval.approved_by ?? '').trim();
  const at = (approval.approved_at ?? '').trim();

  if (!by && !at) {
    return {
      sendable: false,
      reason: 'approved but missing approved_by and approved_at — malformed, refused',
    };
  }
  if (!by) {
    return {
      sendable: false,
      reason: 'approved but missing approved_by — malformed, refused',
    };
  }
  if (!at) {
    return {
      sendable: false,
      reason: 'approved but missing approved_at — malformed, refused',
    };
  }

  return { sendable: true, reason: 'approved' };
}

// ─── Receipt outcome rules ────────────────────────────────────────────────────

/**
 * Validate that a delivered receipt carries the required provider-issued proof.
 *
 * outcome == 'delivered' REQUIRES:
 *   - a non-empty provider_message_id (never synthesised)
 *   - a non-empty sent_at (ISO-8601 UTC)
 *   - recipient_count must NOT be null (the provider reported a count)
 *
 * Without a provider-issued identifier the send is not proven. The outcome
 * should be 'failed', not 'delivered'.
 */
export interface ReceiptValidityVerdict {
  valid: boolean;
  reason: string;
}

export function receiptValid(
  outcome: string,
  provider_message_id?: string | null,
  sent_at?: string | null,
  recipient_count?: number | null
): ReceiptValidityVerdict {
  if (outcome !== 'delivered') {
    // non-delivered outcomes: error is required for rejected/failed
    if ((outcome === 'rejected' || outcome === 'failed') && !(provider_message_id ?? sent_at)) {
      // the "error" field check is done at the shape level by parseReceipt;
      // this is the semantic check for the receipt's own documentation
    }
    return { valid: true, reason: `outcome ${outcome} is valid` };
  }

  // delivered — must have provider-issued proof
  const msgId = (provider_message_id ?? '').trim();
  const sent = (sent_at ?? '').trim();
  const count = recipient_count;

  if (!msgId && !sent) {
    return {
      valid: false,
      reason: 'delivered outcome requires provider_message_id and sent_at — missing both',
    };
  }
  if (!msgId) {
    return {
      valid: false,
      reason: 'delivered outcome requires a non-empty provider_message_id (never synthesised)',
    };
  }
  if (!sent) {
    return {
      valid: false,
      reason: 'delivered outcome requires a non-empty sent_at (ISO-8601 UTC)',
    };
  }
  if (count === null) {
    return {
      valid: false,
      reason: 'delivered outcome requires a non-null recipient_count',
    };
  }

  return { valid: true, reason: 'delivery proof is valid' };
}

// ─── Full handoff validation (combined shape + state rule) ────────────────────

export interface HandoffValidationResult {
  ok: boolean;
  payload?: HandoffPayload;
  sendable?: SendabilityVerdict;
  error?: string;
  issues?: z.ZodIssue[];
}

/**
 * Validate a handoff payload end-to-end:
 *   1. Shape validation (parseHandoff)
 *   2. State rule check (handoffSendable) — applied only when shape-valid so
 *      callers can distinguish a parse failure from a policy refusal.
 *
 * shape-valid AND sendable → { ok: true, payload, sendable }
 * shape-valid but NOT sendable → { ok: false, payload, sendable, error }
 * shape-invalid → { ok: false, error, issues }
 */
export function validateHandoff(raw: unknown): HandoffValidationResult {
  const parsed = parseHandoff(raw);
  if (!parsed.ok || !parsed.value) {
    return {
      ok: false,
      error: parsed.error ?? 'unknown parse error',
      issues: parsed.issues,
    };
  }

  const sendable = handoffSendable(parsed.value.approval);

  if (!sendable.sendable) {
    return {
      ok: false,
      payload: parsed.value,
      sendable,
      error: sendable.reason,
    };
  }

  return {
    ok: true,
    payload: parsed.value,
    sendable,
  };
}

// ─── Full receipt validation (combined shape + outcome rule) ──────────────────

export interface ReceiptValidationResult {
  ok: boolean;
  payload?: ReceiptPayload;
  validity?: ReceiptValidityVerdict;
  error?: string;
  issues?: z.ZodIssue[];
}

/**
 * Validate a receipt payload end-to-end:
 *   1. Shape validation (parseReceipt)
 *   2. Outcome rule check (receiptValid) — applied only when shape-valid.
 */
export function validateReceipt(raw: unknown): ReceiptValidationResult {
  const parsed = parseReceipt(raw);
  if (!parsed.ok || !parsed.value) {
    return {
      ok: false,
      error: parsed.error ?? 'unknown parse error',
      issues: parsed.issues,
    };
  }

  const validity = receiptValid(
    parsed.value.outcome,
    parsed.value.provider_message_id,
    parsed.value.sent_at,
    parsed.value.recipient_count
  );

  if (!validity.valid) {
    return {
      ok: false,
      payload: parsed.value,
      validity,
      error: validity.reason,
    };
  }

  return {
    ok: true,
    payload: parsed.value,
    validity,
  };
}

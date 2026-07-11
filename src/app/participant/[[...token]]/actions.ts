'use server';

/**
 * The participant token page's ONE write path. A form submit lands here, we
 * rebuild the visitor's credential from the (capability) hidden fields, and shell
 * the engine's both-door endpoint via the server-only bridge. The engine — not
 * this action — is the authority: it re-verifies the HMAC token/PIN, enforces
 * single-use (a replay is refused even after the gate closes), checks the action
 * is legal at the open gate, and runs the sole ledger writer. We never re-derive
 * gate truth or touch ANTHOLOGY_GATE_TOKEN_SECRET here.
 *
 * Everything returned is already client-clean (serialize.ts): no ids, no reason
 * codes, no plumbing.
 */

import { decide, type DecideFields, type GateCredential } from '../_lib/gate-engine';
import {
  serializeFailure,
  serializeSubmitSuccess,
  type GateKind,
  type SubmitView,
} from '../_lib/serialize';

/** Engine action → which gate kind it belongs to (for the success copy). */
const ACTION_KIND: Record<string, GateKind> = {
  select: 'title',
  approve: 'outline',
  approve_as_is: 'chapter',
  request_rewrite_with_notes: 'chapter',
};

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function readCredential(formData: FormData): GateCredential | null {
  const kind = str(formData, 'cred_kind');
  if (kind === 'token') {
    const token = str(formData, 'token');
    return token ? { kind: 'token', token } : null;
  }
  if (kind === 'pin') {
    const subjectKey = str(formData, 'subject');
    const pin = str(formData, 'pin');
    const exp = str(formData, 'exp');
    const gate = str(formData, 'gate');
    if (!subjectKey || !pin || !exp) return null;
    return { kind: 'pin', subjectKey, pin, exp, gate: gate || undefined };
  }
  return null;
}

/**
 * Server action bound to the gate form. `useFormState` signature:
 * (prevState, formData) => nextState.
 */
export async function submitGateDecision(
  _prev: SubmitView | null,
  formData: FormData
): Promise<SubmitView> {
  const credential = readCredential(formData);
  const action = str(formData, 'action');
  if (!credential || !action || !(action in ACTION_KIND)) {
    return refusal(serializeFailure('invalid'));
  }

  const fields: DecideFields = {
    title: str(formData, 'title') || undefined,
    subtitle: str(formData, 'subtitle') || undefined,
    notes: str(formData, 'notes') || undefined,
  };

  // Friendly pre-checks for required fields (the engine also enforces these, but
  // an opaque "invalid" is a poor experience for an empty box).
  if (action === 'select' && !fields.title) {
    return { ok: false, heading: 'Add a title', message: 'Please enter a title before saving.', retryable: true };
  }
  if (action === 'request_rewrite_with_notes' && !fields.notes) {
    return {
      ok: false,
      heading: 'Add your notes',
      message: 'Please describe what you’d like changed so the team can act on it.',
      retryable: true,
    };
  }

  const result = decide(credential, action, fields);
  if (!result.ok) return refusal(serializeFailure(result.status));

  return serializeSubmitSuccess(ACTION_KIND[action], action === 'request_rewrite_with_notes');
}

function refusal(v: { heading: string; message: string; retryable: boolean }): SubmitView {
  return { ok: false, heading: v.heading, message: v.message, retryable: v.retryable };
}

/**
 * Client-clean serializer for the participant token page (SPEC 11.5).
 *
 * Every value that reaches a participant's browser passes through here. It is
 * the single choke point that guarantees the public page NEVER leaks:
 *   • internal ids — participant_key / contact_id / anthology_id, gate ids
 *     ("s5_participant"), approval ids, jti nonces, stage cursors;
 *   • plumbing — engine reason codes, tool names, model names, file paths,
 *     exit codes, which of several refusal causes actually fired;
 *   • secrets — ANTHOLOGY_GATE_TOKEN_SECRET is never even in this process.
 *
 * It emits only human-facing copy and a CLOSED set of action descriptors the
 * form knows how to render, and it says "Convert and Flow" as the only platform
 * name. The refusal copy is deliberately generic (one message for the whole
 * forged/foreign/replayed/malformed family) so the page is not an oracle for an
 * attacker probing tokens.
 */

import type { GateFailure, GateLoad, ParticipantGateId } from './gate-engine';

export const PLATFORM_NAME = 'Convert and Flow';

/** The action kinds the client form knows how to render. Closed set. */
export type ActionKind = 'select_title' | 'approve' | 'approve_as_is' | 'request_rewrite';

export interface ActionDescriptor {
  /** Engine action name, passed straight back to `decide` (not shown as-is). */
  readonly action: string;
  readonly kind: ActionKind;
  readonly label: string;
  /** True when this action is the affirmative/primary path. */
  readonly primary: boolean;
}

/** What kind of gate the participant is being asked to act on. */
export type GateKind = 'title' | 'outline' | 'chapter';

export interface ParticipantGateView {
  readonly ok: true;
  readonly kind: GateKind;
  /** Focal heading, e.g. "Choose your chapter title". */
  readonly heading: string;
  /** One-line supporting sentence under the heading. */
  readonly lede: string;
  readonly actions: ReadonlyArray<ActionDescriptor>;
  /** Friendly "valid through <date>" string, or null when unknown. */
  readonly validThrough: string | null;
}

export interface ParticipantRefusalView {
  readonly ok: false;
  readonly heading: string;
  readonly message: string;
  /** A soft failure the operator can fix (held); tells the page to say "try later". */
  readonly retryable: boolean;
}

export type ParticipantView = ParticipantGateView | ParticipantRefusalView;

// --------------------------------------------------------------------------- //
// Gate copy. Maps the internal gate id → visitor-facing kind + copy. The gate
// id itself never crosses to the client.
// --------------------------------------------------------------------------- //

const GATE_COPY: Record<ParticipantGateId, { kind: GateKind; heading: string; lede: string }> = {
  s3_selection: {
    kind: 'title',
    heading: 'Choose your title',
    lede: 'Set the title and optional subtitle for your chapter.',
  },
  s4_participant: {
    kind: 'outline',
    heading: 'Approve your outline',
    lede: 'Review the outline for your chapter and approve it to continue.',
  },
  s5_participant: {
    kind: 'chapter',
    heading: 'Review your chapter',
    lede: 'Approve your chapter as written, or request a rewrite with your notes.',
  },
};

// Engine action name → client action descriptor. Only participant-gate actions
// appear here; anything else is dropped (never rendered on the public page).
function describeAction(action: string): ActionDescriptor | null {
  switch (action) {
    case 'select':
      return { action, kind: 'select_title', label: 'Save title', primary: true };
    case 'approve':
      return { action, kind: 'approve', label: 'Approve', primary: true };
    case 'approve_as_is':
      return { action, kind: 'approve_as_is', label: 'Approve as-is', primary: true };
    case 'request_rewrite_with_notes':
      return { action, kind: 'request_rewrite', label: 'Request a rewrite', primary: false };
    default:
      return null;
  }
}

function friendlyDate(epochSeconds: number | null): string | null {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(epochSeconds * 1000));
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- //
// Refusal copy. One coarse bucket → one honest, generic message. No reason
// codes, no distinction between forged vs foreign vs replayed.
// --------------------------------------------------------------------------- //

const REFUSAL_COPY: Record<GateFailure, { heading: string; message: string; retryable: boolean }> =
  {
    expired: {
      heading: 'This link has expired',
      message:
        'The link you used is no longer active. Ask your producer to send you a fresh link and you can pick up right where you left off.',
      retryable: false,
    },
    invalid: {
      heading: 'This link isn’t valid',
      message:
        'We couldn’t open this link. Please use the most recent link your producer sent you, or ask them to resend it.',
      retryable: false,
    },
    nothing_open: {
      heading: 'Nothing to review right now',
      message:
        'There’s nothing waiting for you at the moment. If you were expecting to approve something, your producer will send a new link when it’s ready.',
      retryable: false,
    },
    not_ready: {
      heading: 'Not quite ready yet',
      message:
        'This page isn’t ready to load just yet. Please try your link again in a few minutes.',
      retryable: true,
    },
    error: {
      heading: 'Something went wrong',
      message: 'We hit an unexpected problem opening this page. Please try your link again.',
      retryable: true,
    },
  };

// --------------------------------------------------------------------------- //
// The two serializers.
// --------------------------------------------------------------------------- //

/** Serialize a resolved gate load into the visitor-facing gate view. */
export function serializeGate(load: GateLoad): ParticipantView {
  if (!load.ok) return serializeFailure(load.status);

  const copy = GATE_COPY[load.gate];
  if (!copy) return serializeFailure('nothing_open');

  const actions = load.actions
    .map(describeAction)
    .filter((a): a is ActionDescriptor => a !== null);

  if (actions.length === 0) return serializeFailure('nothing_open');

  return {
    ok: true,
    kind: copy.kind,
    heading: copy.heading,
    lede: copy.lede,
    actions,
    validThrough: friendlyDate(load.expiresAt),
  };
}

/** Serialize a coarse failure bucket into the visitor-facing refusal view. */
export function serializeFailure(failure: GateFailure): ParticipantRefusalView {
  const copy = REFUSAL_COPY[failure] ?? REFUSAL_COPY.error;
  return { ok: false, heading: copy.heading, message: copy.message, retryable: copy.retryable };
}

/** The result of a submitted decision, already client-clean. */
export type SubmitView =
  | { ok: true; heading: string; message: string }
  | { ok: false; heading: string; message: string; retryable: boolean };

export function serializeSubmitSuccess(kind: GateKind, requestedRewrite: boolean): SubmitView {
  if (requestedRewrite) {
    return {
      ok: true,
      heading: 'Rewrite requested',
      message:
        'Thanks — your notes are on their way to the team. You’ll get a fresh link to review the next version.',
    };
  }
  const done: Record<GateKind, string> = {
    title: 'Your title is saved. Thanks — that’s all we need for this step.',
    outline: 'Your outline is approved. Thanks — we’ll take it from here.',
    chapter: 'Your chapter is approved. Thanks — that’s everything we needed from you.',
  };
  return { ok: true, heading: 'All set', message: done[kind] };
}

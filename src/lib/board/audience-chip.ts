/** Client-safe helpers for the "who will read this?" board surfaces. */

/** The approved plain-language question shown when the box cannot tell who will read a task. */
export const AUDIENCE_ASK_TEXT =
  'Who will be reading this? For example: a client, a business partner, your email list, or your social media followers. ' +
  'We ask so we can write it in the right tone. This task is waiting until you answer.';

/** audience_source values written when the board answered the question itself. */
export const AUTO_AUDIENCE_SOURCES = ['task_named', 'owner_default'] as const;

/** Label for the "Written for X - Change" chip, or null when nothing was assumed. */
export function writtenForLabel(t: { audience_source?: string | null; audience_label?: string | null }): string | null {
  const label = t.audience_label?.trim();
  return label && (AUTO_AUDIENCE_SOURCES as readonly string[]).includes(t.audience_source ?? '') ? label : null;
}

/** Every audience_source that means someone already answered "who will read this?". */
export const ANSWERED_AUDIENCE_SOURCES = ['task_named', 'owner_default', 'operator_confirmed'] as const;

/**
 * True only while the question is genuinely open. An answered task whose voice
 * refresh is still landing keeps confirm_state 'pending' but must not ask again.
 */
export function needsAudienceAnswer(t: { blend_confirm_state?: string | null; audience_source?: string | null }): boolean {
  return t.blend_confirm_state === 'pending' && !(ANSWERED_AUDIENCE_SOURCES as readonly string[]).includes(t.audience_source ?? '');
}

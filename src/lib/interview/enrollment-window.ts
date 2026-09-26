import { readBuildState, type BuildState } from '@/lib/interview/seam';

/**
 * The one condition that ends an interview invitation's validity.
 *
 * An enrollment link has no clock expiry (see lib/interview/session-policy.ts):
 * it stays usable until the interview it opens is finished. "Finished" is what
 * the canonical build state says — interviewComplete, or a recorded
 * buildCompletedAt — never elapsed time.
 *
 * Two deliberate asymmetries:
 *   • UNREADABLE OR ABSENT state is UNDETERMINED, not complete. An unreadable
 *     file must never lock an owner out of an interview nobody has proven is
 *     over; the mint side already refuses to issue a link once the interview
 *     is complete, and the middleware gate keeps a finished client out of the
 *     interview shell on its own.
 *   • State that names a DIFFERENT company is not this grant's state and says
 *     nothing about it. State with no company recorded is still honoured, so a
 *     completed interview cannot be re-opened just because the field is absent.
 */
export function enrollmentWindowClosed(companyId?: string): boolean {
  return interviewFinished(readBuildState(), companyId);
}

/** A recorded owner is any present, non-blank companyId. Absent/blank means
 *  "no company recorded" and is still honoured; anything recorded that is not
 *  this grant's company is foreign and says nothing about it. Non-string
 *  values count as recorded (fail-open: a value we cannot match is foreign). */
function isRecorded(owner: unknown): boolean {
  return typeof owner === 'string' ? owner.trim() !== '' : owner !== undefined && owner !== null;
}

/** Pure half of enrollmentWindowClosed, for callers that already hold state. */
export function interviewFinished(state: BuildState | null, companyId?: string): boolean {
  if (!state) return false;
  const owner = state.companyId;
  if (companyId && isRecorded(owner) && owner !== companyId) return false;
  if (state.interviewComplete === true) return true;
  return typeof state.buildCompletedAt === 'string' && state.buildCompletedAt.trim() !== '';
}

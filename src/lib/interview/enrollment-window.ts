import { readBuildState, type BuildState } from '@/lib/interview/seam';
import { INTERVIEW_COMPLETION_GRACE_SECONDS } from './session-policy';

/** Invitation access is unbounded before completion, then lasts exactly 24h.
 * Reading never changes completion state or starts a new grace period. A legacy
 * completed record without a trustworthy interview timestamp fails closed;
 * build completion and a later browser visit must never move the deadline.
 * Missing/unreadable or foreign-company state retains its existing undetermined
 * behavior, and does not claim that this tenant finished an interview.
 */
export function enrollmentWindowClosed(companyId?: string): boolean {
  return enrollmentExpired(readBuildState(), companyId);
}

/** Pure admission rule; completion itself remains a separate, unchanged fact. */
export function enrollmentExpired(state: BuildState | null, companyId?: string, now = Date.now()): boolean {
  if (!interviewFinished(state, companyId)) return false;
  const timestamp = state?.interviewCompletedAt;
  if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) return true;
  const completedAt = Date.parse(timestamp);
  if (!Number.isFinite(completedAt) || completedAt > now) return true;
  return now >= completedAt + INTERVIEW_COMPLETION_GRACE_SECONDS * 1000;
}

/** A recorded owner is any present, non-blank companyId. Absent/blank means
 *  "no company recorded" and is still honoured; anything recorded that is not
 *  this grant's company is foreign and says nothing about it. Non-string
 *  values count as recorded (fail-open: a value we cannot match is foreign). */
function isRecorded(owner: unknown): boolean {
  return typeof owner === 'string' ? owner.trim() !== '' : owner !== undefined && owner !== null;
}

/** Completion fact only: enrollment grace never reopens a completed interview. */
export function interviewFinished(state: BuildState | null, companyId?: string): boolean {
  if (!state) return false;
  const owner = state.companyId;
  if (companyId && isRecorded(owner) && owner !== companyId) return false;
  if (state.interviewComplete === true) return true;
  return typeof state.buildCompletedAt === 'string' && state.buildCompletedAt.trim() !== '';
}

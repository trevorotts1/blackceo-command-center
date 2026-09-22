/**
 * Build-state identity classification (2026-09-22).
 *
 * WHY THIS EXISTS — measured on a client box (rescue-leanne-dolce):
 * `.workforce-build-state.json` carried `interviewComplete: true` written in
 * June, months before the tenant identity stamps (companyId/installationId/
 * tenantId) were ever added to that file. Every call site that verifies scope
 * hand-rolled the same triple equality:
 *
 *     state.companyId===context.companyId && state.installationId===… && …
 *
 * `undefined === 'wakeuphappysis'` is false, so a COMPLETED interview was
 * indistinguishable from an ABSENT one: /api/auth/interview-ready reported
 * `interviewComplete: null` and the client was told her AI Workforce interview
 * was not complete when it demonstrably was.
 *
 * "Not yet stamped" and "stamped for someone else" are different facts and must
 * not collapse into one verdict:
 *
 *   - `unstamped`   — legacy state predating the stamps. The interview flag is
 *                     still trustworthy for THIS tenant (single-tenant box, the
 *                     file lives in this installation's own workspace), so the
 *                     caller may self-stamp it and carry on.
 *   - `mismatched`  — a stamp is PRESENT and names a different company /
 *                     installation / tenant. That is a real scope violation and
 *                     still fails closed, exactly as before. Never weakened: a
 *                     present-and-disagreeing stamp is never backfilled over.
 *
 * Absence of information is not permission (the fleet's fail-closed doctrine),
 * but absence of a FIELD THAT DID NOT EXIST when the file was written is not
 * evidence of a foreign tenant either.
 */

import fs from 'node:fs';
import { buildStatePath } from './paths';
import type { BuildState } from './seam';

export type StateIdentityVerdict = 'scoped' | 'unstamped' | 'mismatched' | 'absent';

/** The three identity stamps, in the shape resolveTenantContext produces. */
export interface StateIdentityContext {
  companyId: string;
  installationId: string;
  tenantId: string;
}

const STAMPS = ['companyId', 'installationId', 'tenantId'] as const;

/**
 * Classify a build state against the verified tenant context.
 *
 * A stamp that is present and DISAGREES short-circuits to `mismatched` — one
 * foreign stamp is a scope violation even if the other two happen to match.
 */
export function classifyStateIdentity(
  state: BuildState | null | undefined,
  context: StateIdentityContext,
): StateIdentityVerdict {
  if (!state) return 'absent';
  let stamped = 0;
  for (const key of STAMPS) {
    const value = state[key];
    if (value === undefined || value === null || value === '') continue;
    if (value !== context[key]) return 'mismatched';
    stamped++;
  }
  return stamped === STAMPS.length ? 'scoped' : 'unstamped';
}

/**
 * Backfill the missing identity stamps from the verified context.
 *
 * Re-reads the file first and REFUSES on `mismatched`, so this can never
 * overwrite a foreign tenant's stamp with the caller's own. Returns false on
 * any failure (unreadable, unwritable, bad JSON) — the caller then reports the
 * unstamped state honestly rather than claiming a scope it could not record.
 *
 * ponytail: last-writer-wins against the skill scripts that also write this
 * file. The re-read narrows the window to the serialize+rename; add a lockfile
 * only if a concurrent-write collision is ever actually observed.
 */
export function stampStateIdentity(context: StateIdentityContext): boolean {
  const target = buildStatePath();
  const tmp = `${target}.identity-${process.pid}.tmp`;
  try {
    const mode = fs.statSync(target).mode & 0o777;
    const state = JSON.parse(fs.readFileSync(target, 'utf-8')) as BuildState;
    if (classifyStateIdentity(state, context) === 'mismatched') return false;
    for (const key of STAMPS) state[key] = context[key];
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

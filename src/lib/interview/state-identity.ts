/**
 * Build-state identity classification (2026-09-22).
 *
 * WHY THIS EXISTS — measured on a live client box:
 * `.workforce-build-state.json` carried `interviewComplete: true` written in
 * June, months before the tenant identity stamps (companyId/installationId/
 * tenantId) were ever added to that file. Every call site that verifies scope
 * hand-rolled the same triple equality:
 *
 *     state.companyId===context.companyId && state.installationId===… && …
 *
 * `undefined === '<the box company id>'` is false, so a COMPLETED interview was
 * indistinguishable from an ABSENT one: /api/auth/interview-ready reported
 * `interviewComplete: null` and the client was told the AI Workforce interview
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
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildStatePath, resolveSkillScriptsDir } from './paths';
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
 * The write goes through the Skill-23 state module (`workforce_state.update`),
 * which holds the `state.write.lock` while it reads, mutates and atomically
 * replaces the file — no temp file of our own, no read-modify-write race with
 * the shell scripts that write the same file. The module's `jq` command mode is
 * NOT used: it needs the `jq` program, which boxes may lack.
 *
 * The `mismatched` refusal is checked here, before the call, so a foreign
 * tenant's stamp is never touched at all. Returns false on any failure
 * (unreadable state, unresolvable scripts folder, non-zero exit, timeout) —
 * the caller then reports the unstamped state honestly rather than claiming a
 * scope it could not record.
 */
const STAMP_PROGRAM = `import json, sys
sys.path.insert(0, sys.argv[1])
from workforce_state import update
stamps = json.loads(sys.argv[3])
def mutate(state):
    for key, value in stamps.items():
        if state.get(key) in (None, ''):
            state[key] = value
update(sys.argv[2], mutate)`;

const STAMP_TIMEOUT_MS = 10_000;

export function stampStateIdentity(context: StateIdentityContext): boolean {
  const target = buildStatePath();
  try {
    const state = JSON.parse(fs.readFileSync(target, 'utf-8')) as BuildState;
    if (classifyStateIdentity(state, context) === 'mismatched') return false;
  } catch {
    return false;
  }

  const scriptsDir = resolveSkillScriptsDir();
  let scriptsDirPresent = false;
  try {
    scriptsDirPresent = fs.statSync(scriptsDir).isDirectory();
  } catch {
    scriptsDirPresent = false;
  }
  // The unit's own contract (state-identity.test.ts): a missing scripts
  // folder is a hard false, never a bare file write. Only a PRESENT folder
  // that merely lacks the workforce_state module falls back to tmp+rename.
  if (!scriptsDirPresent) return false;
  let useStateLock = true;
  try {
    if (!fs.statSync(path.join(scriptsDir, 'workforce_state.py')).isFile()) useStateLock = false;
  } catch {
    useStateLock = false;
  }

  const stamps = JSON.stringify({
    companyId: context.companyId,
    installationId: context.installationId,
    tenantId: context.tenantId,
  });

  // The Skill-23 state module (`workforce_state.update`, holding the write
  // lock) is the primary writer. Fixture / minimal script trees that predate
  // or omit that module fall back to the atomic tmp+rename this function used
  // before BU-107 — same stamps, same preservation of every other key, same
  // mode, never a foreign-stamp overwrite (the mismatched refusal above).
  if (useStateLock) {
    try {
      execFileSync('python3', ['-c', STAMP_PROGRAM, scriptsDir, target, stamps], {
        timeout: STAMP_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  const tmp = `${target}.identity-${process.pid}.tmp`;
  try {
    const mode = fs.statSync(target).mode & 0o777;
    const state = JSON.parse(fs.readFileSync(target, 'utf-8')) as BuildState;
    if (classifyStateIdentity(state, context) === 'mismatched') return false;
    for (const key of STAMPS) (state as Record<string, unknown>)[key] = context[key];
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best-effort: never mask the stamp result.
    }
    return false;
  }
}

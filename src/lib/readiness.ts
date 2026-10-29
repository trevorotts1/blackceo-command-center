/**
 * Shared per-surface readiness checklist (R-28).
 *
 * ONE derivation of the installation-readiness `missing[]` list, consumed by
 * every surface that shows setup readiness:
 *   - src/app/api/auth/tenant-ready/route.ts      (operator installation handshake)
 *   - src/app/api/readiness/checklist/route.ts   (the caller's own tenant — client-facing)
 *   - src/app/readiness/page.tsx                 (client-facing surface)
 *
 * Invalidation contract (D-29): the checklist is re-derived from live probes on
 * EVERY request and every response is `cache-control: private, no-store`, so a
 * rebind/disconnect/upgrade can never be masked by a cached green. An input that
 * cannot be determined is listed as missing — never silently green.
 */
import { queryOne } from '@/lib/db';
import { personaCompanyContext } from '@/lib/persona-company';
import fs from 'node:fs';

/** Raw facts gathered from live probes. Null means "could not be determined". */
export interface ReadinessInputs {
  kind: 'self' | 'client';
  installationId: string;
  companyId: string;
  installationIdMatches: boolean;
  companyRecordPresent: boolean;
  /** false when personaCompanyContext/catalog could not be resolved at all */
  personaResolved: boolean;
  /** false when the catalog was resolved but is not a JSON object */
  personaCatalogIsObject: boolean;
  sessionSecretPresent: boolean;
  requireRemoteReceiver: boolean;
  remoteSecretPresent: boolean | null;
  receiverScriptsPresent: boolean | null;
}

/**
 * The exact missing[] derivation the operator handshake has always returned.
 * Pure: no I/O — every fact arrives in `inputs`, so all surfaces share one list.
 */
export function collectReadinessMissing(inputs: ReadinessInputs): string[] {
  const missing: string[] = [];
  if (inputs.kind !== 'self') missing.push('dedicated_self_registration');
  if (!inputs.installationIdMatches) missing.push('installation_id');
  if (!inputs.companyRecordPresent) missing.push('company_record');
  if (!inputs.personaResolved) {
    missing.push('persona_company_context_or_catalog');
  } else if (!inputs.personaCatalogIsObject) {
    missing.push('persona_catalog');
  }
  if (!inputs.sessionSecretPresent) missing.push('session_secret');
  if (inputs.requireRemoteReceiver) {
    if (!inputs.remoteSecretPresent) missing.push('remote_receiver_secret');
    if (inputs.receiverScriptsPresent === false) missing.push('interview_receiver_scripts');
  }
  return missing;
}

/**
 * Probe the live state for one tenant context and return the raw facts.
 * Async only because the interview receiver-script probe is; every read here is
 * fresh (no cache layer), which is the R-28 invalidation guarantee.
 */
export async function gatherReadinessInputs(
  context: { kind: 'self' | 'client'; installationId: string; companyId: string },
  opts: { requireRemoteReceiver?: boolean } = {},
): Promise<ReadinessInputs> {
  const requireRemoteReceiver = opts.requireRemoteReceiver === true;
  let personaResolved = true;
  let personaCatalogIsObject = false;
  try {
    const persona = personaCompanyContext(context.companyId);
    const catalog = JSON.parse(fs.readFileSync(persona.personaCatalog, 'utf8'));
    personaCatalogIsObject = !!catalog && typeof catalog === 'object';
  } catch {
    personaResolved = false;
    personaCatalogIsObject = false;
  }
  let receiverScriptsPresent: boolean | null = null;
  if (requireRemoteReceiver) {
    receiverScriptsPresent = false;
    try {
      const paths = await import('@/lib/interview/paths');
      receiverScriptsPresent = !!(
        paths.scriptExists(paths.updateInterviewStateScript()) &&
        paths.scriptExists(paths.recordDeptDecisionScript()) &&
        paths.scriptExists(paths.listCanonicalDepartmentsScript())
      );
    } catch {
      receiverScriptsPresent = false;
    }
  }
  return {
    kind: context.kind,
    installationId: context.installationId,
    companyId: context.companyId,
    installationIdMatches: process.env.MC_INSTALLATION_ID === context.installationId,
    companyRecordPresent: !!queryOne('SELECT id FROM companies WHERE id=?', [context.companyId]),
    personaResolved,
    personaCatalogIsObject,
    sessionSecretPresent: !!(
      process.env.MC_TENANT_SESSION_SECRET ||
      process.env.MC_INTERVIEW_COOKIE_SECRET ||
      process.env.MC_API_TOKEN
    ),
    requireRemoteReceiver,
    remoteSecretPresent: requireRemoteReceiver ? !!process.env.MC_INTERVIEW_REMOTE_SECRET : null,
    receiverScriptsPresent,
  };
}

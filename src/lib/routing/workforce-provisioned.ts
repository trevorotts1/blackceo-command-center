import { queryOne } from '@/lib/db';
import { getSelfClient } from '@/lib/clients';

/**
 * W3.1 — INTERVIEW-COMPLETED ROUTING GATE (spec §3).
 *
 * "Task routing applies ONLY to owners who COMPLETED the interview (have a
 * Zero Human Company with roles+SOPs). Not-completed = exempt (no routing
 * obligation)." A box is "workforce-provisioned" when it has BOTH:
 *
 *   1. A completed AI-Workforce interview (DB-backed self-client flag), AND
 *   2. Materialized, non-shell departments (per N37): at least one department
 *      workspace — not the CEO/master or the general catch-all — that has a
 *      live, non-master agent. A fresh/shell install has only the CEO shell and
 *      no specialist roster, so it is exempt: there is nowhere to route into.
 *
 * Fail-safe on the interview flag: when the self-client row is ABSENT (a legacy
 * box that predates the clients table) we cannot read the flag, so we defer to
 * the materialized-departments signal alone rather than wrongly exempting a box
 * that is clearly built out. When the row EXISTS we honour its flag exactly.
 *
 * When NOT provisioned, the CEO answers directly with NO routing obligation —
 * the ingest still captures the task (nothing is lost) but does NOT force it
 * through automatic department classification.
 */
export function isWorkforceProvisioned(companyId: string): { provisioned: boolean; reason: string } {
  // (2) Materialized, non-shell departments with a live specialist agent.
  const materialized = queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT w.id) AS n
       FROM workspaces w
       JOIN agents a
         ON a.workspace_id = w.id
        AND a.is_master = 0
        AND a.status != 'offline'
      WHERE w.company_id = ? AND lower(w.slug) NOT IN
              ('master-orchestrator', 'ceo', 'dept-ceo',
               'general-task', 'dept-general-task', 'general')
        AND lower(w.name) NOT IN
              ('ceo', 'master orchestrator', 'general task', 'general')`,
    [companyId],
  );
  const hasMaterializedDepts = (materialized?.n ?? 0) > 0;

  // (1) Interview completion — DB-backed self-client flag (null when no row).
  let interviewComplete: boolean | null = null;
  try {
    const self = getSelfClient();
    interviewComplete = self ? self.interview_complete : null;
  } catch {
    // clients table absent / unreadable on a legacy box — treat as unknown.
    interviewComplete = null;
  }

  // Unknown interview flag → defer to the materialized-departments signal.
  const interviewOk = interviewComplete === null ? hasMaterializedDepts : interviewComplete;
  const provisioned = hasMaterializedDepts && interviewOk;

  const reason =
    `interview=${interviewComplete === null ? 'unknown' : interviewComplete}, ` +
    `materialized_depts=${hasMaterializedDepts}`;
  return { provisioned, reason };
}

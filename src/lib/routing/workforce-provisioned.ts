import { queryOne } from '@/lib/db';
import { getSelfClient } from '@/lib/clients';
import { readBuildState } from '@/lib/interview/seam';
import { standardPlaceholderActive, verifiedBuild } from '@/lib/interview/build-verification';

/**
 * W3.1 — INTERVIEW-COMPLETED ROUTING GATE (spec §3; CC-037).
 *
 * "Task routing applies ONLY to owners who COMPLETED the interview (have a
 * Zero Human Company with roles+SOPs). Not-completed = exempt (no routing
 * obligation)." A box is "workforce-provisioned" when it has BOTH:
 *
 *   1. A finished AI-Workforce interview, AND
 *   2. Materialized, non-shell departments (per N37): at least one department
 *      workspace — not the CEO/master or the general catch-all — that has a
 *      live, non-master agent. A fresh/shell install has only the CEO shell and
 *      no specialist roster, so it is exempt: there is nowhere to route into.
 *
 * ONE ANSWER TO "IS THIS COMPANY'S WORKFORCE LIVE?" (CC-037). The dashboard
 * locks on the canonical build-state FILE; task routing used to lock on the
 * `clients.interview_complete` DATABASE flag. The two disagreed in both
 * directions: a flag of 0 with an open dashboard filed every task under General
 * Task, and a flag of 1 set by a stray analytics read during an unfinished
 * interview routed work that had no workforce behind it. The rule is:
 *
 *   When the build-state file can be read, IT DECIDES — in both directions.
 *   The database flag counts only when the file cannot be read.
 *
 * A readable file says "complete" (interviewComplete true, or a verified build
 * receipt), "placeholder" (an owner-ordered standard company, which admits the
 * dashboard without claiming the interview finished), or "incomplete". A
 * missing/unreadable file leaves the database flag as the only evidence left; a
 * legacy box with neither a client row nor a readable file defers to the
 * materialized-departments signal alone, so a clearly built-out box is never
 * wrongly exempted.
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

  // (1) Interview completion. For this box's own company the canonical FILE is
  // the authority (the same source the dashboard lock reads). The database flag
  // is a fallback when the file is unreadable; it is neither an extra yes nor a veto.
  let dbFlag: boolean | null = null;
  try {
    const self = getSelfClient();
    dbFlag = self ? self.interview_complete : null;
  } catch {
    dbFlag = null;
  }
  let fileSays: 'complete' | 'placeholder' | 'incomplete' | 'unreadable' = 'unreadable';
  try {
    const bs = readBuildState() as Record<string, unknown> | null;
    if (bs) {
      fileSays =
        bs.interviewComplete === true || verifiedBuild(bs) ? 'complete'
        : standardPlaceholderActive(bs) ? 'placeholder'
        : 'incomplete';
    }
  } catch {
    fileSays = 'unreadable';
  }
  const interviewOk =
    fileSays === 'complete' ||
    fileSays === 'placeholder' ||
    // File unreadable or absent: the database flag is the only evidence left.
    (fileSays === 'unreadable' && dbFlag === true) ||
    // Legacy box: no client row and no readable file — defer to departments.
    (fileSays === 'unreadable' && dbFlag === null && hasMaterializedDepts);
  const provisioned = hasMaterializedDepts && interviewOk;
  const reason =
    `interview_db=${dbFlag === null ? 'unknown' : dbFlag}, interview_file=${fileSays}, ` +
    `materialized_depts=${hasMaterializedDepts}`;
  return { provisioned, reason };
}

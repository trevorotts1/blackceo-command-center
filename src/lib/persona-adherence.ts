/**
 * persona-adherence.ts — D26 (spec 11.2-11.3, second half): substantive
 * independent adherence review.
 *
 * WHAT: collect, for one execution, the FIVE completion-time evidence items
 * spec 11.2 demands — (1) registered deliverables of the CURRENT execution,
 * (2) worker-reported used decision/bundle identifiers, (3) blueprint load
 * evidence, (4) methods/standards account + material deviations, (5)
 * INDEPENDENT artifact review — and fold them into ONE verdict. Items 1-3
 * reuse the existing artifact/snapshot paths (completion-evidence,
 * persona-conformance, execution-load-evidence); item 5 is the existing
 * independent QC authority (task_qc_results), consumed read-only, never
 * re-judged here.
 *
 * READS ONLY (consumer module): task_deliverables, task_activities,
 * task_qc_results, task_persona_bundle(_scope), task_executions via the
 * helpers above. Own table: none. Never touches tasks.ts, dispatch,
 * auto-route, or execution-attempts.
 *
 * Acceptance: A40 (load evidence + adherence checked, identity alone
 * insufficient — a matching sha with a missing load section or a missing
 * independent review still fails), A42 (exact checks and mandatory QC stay
 * in code/independent reviewers: the review item requires an INDEPENDENT
 * reviewer row — LLM-judged or a passing structural record — never the
 * producer's own claim).
 *
 * The worker's free-text methods account (item 4) is read from the root
 * `persona_used` report's `methods` field when present; absent account =
 * `methods_account_missing` (fail-closed for governed tasks, soft for
 * non-content tasks that never filed a report).
 *
 * D24 (producer/dispatch parity) is PENDING: the dispatch-side requirement
 * that item 4 be promptable/sollicitable ships with D24, not here.
 */

import { getDb } from '@/lib/db';
import {
  currentExecutionDeliverables,
  expectedPersonaManifest,
} from '@/lib/persona-conformance';
import { verifyExecutionLoadEvidence } from '@/lib/execution-load-evidence';
import type Database from 'better-sqlite3';

export interface AdherenceInputs {
  /** Producer's load report (spec 11.2 item 3); absent = unchecked. */
  loadReport?: {
    execution_id?: string | null;
    bundle_sha?: string | null;
    loaded_sections?: string[] | null;
    scopes?: Record<string, string[]> | null;
  } | null;
  /** Free-text methods/standards account + deviations (spec 11.2 item 4). */
  methodsAccount?: string | null;
}

export interface AdherenceItem {
  name:
    | 'registered_deliverables'
    | 'used_identifiers'
    | 'blueprint_load'
    | 'methods_account'
    | 'independent_review';
  pass: boolean;
  reason: string;
}

export interface AdherenceVerdict {
  pass: boolean;
  reason: string;
  items: AdherenceItem[];
}

function tableExists(db: Database.Database, name: string): boolean {
  try {
    return !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  } catch {
    return false;
  }
}

/**
 * Fold the five spec-11.2 completion items into one fail-closed verdict.
 * governed=false (no bundle row) keeps the deliverable/review items but
 * softens identity-only items, mirroring requirePersonaConformanceForCompletion.
 */
export function reviewPersonaAdherence(
  taskId: string,
  executionId: string,
  inputs: AdherenceInputs = {},
  db: Database.Database = getDb(),
): AdherenceVerdict {
  const items: AdherenceItem[] = [];
  try {
    if (!tableExists(db, 'tasks'))
      return { pass: false, reason: 'adherence_unavailable', items };
    const task = db
      .prepare('SELECT persona_contract_version FROM tasks WHERE id=?')
      .get(taskId) as { persona_contract_version?: number | null } | undefined;
    if (!task) return { pass: false, reason: 'task_missing', items };
    const governed = !!task.persona_contract_version;

    // (1) Registered deliverable(s) of the CORRECT (current) execution.
    try {
      const rows = currentExecutionDeliverables(taskId, executionId, db);
      if (rows.length)
        items.push({
          name: 'registered_deliverables',
          pass: true,
          reason: 'current_execution_deliverables_registered',
        });
      else
        items.push({
          name: 'registered_deliverables',
          pass: false,
          reason: 'no_current_execution_deliverables',
        });
    } catch {
      items.push({
        name: 'registered_deliverables',
        pass: false,
        reason: 'deliverables_unreadable',
      });
    }

    // (2) Worker-reported USED identifiers match the stored decision.
    if (!governed) {
      items.push({
        name: 'used_identifiers',
        pass: true,
        reason: 'non_content_no_identifiers_required',
      });
    } else if (!tableExists(db, 'task_persona_bundle')) {
      items.push({
        name: 'used_identifiers',
        pass: true,
        reason: 'execution_before_persona_bundle',
      });
    } else {
      const row = db
        .prepare('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?')
        .get(taskId) as { bundle_json: string } | undefined;
      const reports = tableExists(db, 'task_activities')
        ? (db
            .prepare(
              "SELECT metadata FROM task_activities WHERE task_id=? AND json_valid(metadata) AND json_extract(metadata,'$.kind')='persona_used' ORDER BY created_at DESC,rowid DESC",
            )
            .all(taskId) as { metadata: string }[])
            .map((r) => {
              try {
                return JSON.parse(r.metadata) as Record<string, unknown>;
              } catch {
                return null;
              }
            })
            .filter(
              (r): r is Record<string, unknown> =>
                !!r && r.execution_id === executionId,
            )
        : [];
      const root = reports.find((r) => !r.page && !r.scope);
      if (!row) {
        items.push({
          name: 'used_identifiers',
          pass: true,
          reason: 'non_content_no_identifiers_required',
        });
      } else if (!root) {
        items.push({
          name: 'used_identifiers',
          pass: false,
          reason: 'used_identifiers_not_reported',
        });
      } else {
        const expected = expectedPersonaManifest(JSON.parse(row.bundle_json));
        const match =
          root.bundle_sha === expected.bundle_sha &&
          (root.voice_persona_id ?? null) === (expected.voice_persona_id ?? null) &&
          (root.topic_persona_id ?? null) === (expected.topic_persona_id ?? null) &&
          root.conformance_passed === true;
        items.push(
          match
            ? {
                name: 'used_identifiers',
                pass: true,
                reason: 'used_identifiers_match_stored_decision',
              }
            : {
                // Identity alone is never proof of adherence (11.2), but a
                // MISMATCHED identity is proof of non-adherence (A39).
                name: 'used_identifiers',
                pass: false,
                reason: 'used_identifiers_mismatch',
              },
        );
      }
    }

    // (3) Blueprint load evidence (spec 11.2 item 3; A40).
    if (!governed) {
      items.push({
        name: 'blueprint_load',
        pass: true,
        reason: 'non_content_no_load_required',
      });
    } else if (!inputs.loadReport) {
      items.push({
        name: 'blueprint_load',
        pass: false,
        reason: 'blueprint_load_unreported',
      });
    } else {
      const v = verifyExecutionLoadEvidence(taskId, executionId, inputs.loadReport, db);
      items.push({
        name: 'blueprint_load',
        pass: v.pass,
        reason: v.pass
          ? 'blueprint_load_evidence_verified'
          : v.reason,
      });
    }

    // (4) Methods/standards account + material deviations (spec 11.2 item 4).
    const account = (inputs.methodsAccount ?? '').trim();
    if (!governed) {
      items.push({
        name: 'methods_account',
        pass: true,
        reason: 'non_content_no_account_required',
      });
    } else if (!account) {
      items.push({
        name: 'methods_account',
        pass: false,
        reason: 'methods_account_missing',
      });
    } else {
      items.push({
        name: 'methods_account',
        pass: true,
        reason: account.toLowerCase().includes('deviat')
          ? 'methods_account_with_noted_deviations'
          : 'methods_account_recorded',
      });
    }

    // (5) INDEPENDENT artifact review (spec 11.2 item 5; A42). The producer's
    // own report is never the authority: require a task_qc_results row from a
    // non-producer path (llm scoring path, or a heuristic pass PLUS a passing
    // structural record is NOT enough — heuristic never auto-passes by
    // design, so only llm-pass counts; absent table/row = unchecked).
    if (!tableExists(db, 'task_qc_results')) {
      items.push({
        name: 'independent_review',
        pass: governed ? false : true,
        reason: governed
          ? 'independent_review_unavailable'
          : 'non_content_no_review_required',
      });
    } else {
      const qc = db
        .prepare(
          'SELECT passed, scoring_path FROM task_qc_results WHERE task_id=? ORDER BY scored_at DESC,rowid DESC LIMIT 1',
        )
        .get(taskId) as
        | { passed: number; scoring_path: string }
        | undefined;
      if (qc?.passed === 1 && qc.scoring_path === 'llm')
        items.push({
          name: 'independent_review',
          pass: true,
          reason: 'independent_qc_pass',
        });
      else
        items.push({
          name: 'independent_review',
          pass: false,
          reason: !qc
            ? 'independent_review_missing'
            : 'independent_review_not_passed',
        });
    }

    const failed = items.filter((i) => !i.pass);
    if (!failed.length)
      return {
        pass: true,
        reason: 'persona_adherence_verified',
        items,
      };
    return {
      pass: false,
      reason: `persona_adherence_gap:${failed.map((i) => i.reason).join(',')}`,
      items,
    };
  } catch {
    return { pass: false, reason: 'adherence_unavailable', items };
  }
}

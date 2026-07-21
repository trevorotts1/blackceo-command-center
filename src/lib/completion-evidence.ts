/**
 * completion-evidence.ts — the ONE definition of "this task produced something".
 *
 * ── WHY THIS MODULE EXISTS (T0-01 / T0-42) ────────────────────────────────────
 * `done` is the only terminal, durable state a task has. A `done` row plus its
 * `task_completed` event stand afterwards as evidence the work was performed —
 * they are read by the board, the owner report, grading, and every downstream
 * audit. So the ONE fact that must be true before that record is written is that
 * the work LANDED SOMEWHERE a human can go look at.
 *
 * Before this module, that fact was checked for exactly two task shapes (image
 * and deck) and assumed for every other. `deriveAcceptanceCriteria()` returned
 * `[]` for a document / book / report / operations / video / content task, which
 * made `isArtifactTask` false, which skipped the "no artifact registered"
 * invariant, which dropped scoring into a description-only mode where the judge
 * graded the same prose the executing agent had just written. A passing score
 * then wrote a durable completion for a deliverable that never existed.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────
 * A task may be recorded `done` only if at least one deliverable is registered
 * against it and that deliverable is REACHABLE:
 *
 *   file | artifact | image  →  a filesystem path that exists and is non-empty
 *   url                      →  a syntactically valid http(s) URL
 *
 * This is deliberately an EXISTENCE check, not a quality check. Quality is the
 * QC scorer's job and is judged separately against acceptance criteria. This
 * gate answers only the question a language model must never be asked to
 * adjudicate about its own output: "is there anything here at all?"
 *
 * ── WHY FAIL-CLOSED, AND WHY THIS IS NOT A NEW BURDEN ─────────────────────────
 * Every dispatched task already receives this instruction verbatim, for every
 * task type, from `renderWriteBackInstructions()` (src/lib/mc-auth.ts):
 *
 *     "**IMPORTANT:** After completing work, you MUST call these APIs.
 *      ...
 *      2. Register deliverable: POST <url>/api/tasks/<id>/deliverables"
 *
 * So the contract was already stated to every agent on every dispatch; it was
 * simply never enforced. This module enforces the instruction the system already
 * gives. It does not invent a new requirement, and it needs no per-task-type
 * taxonomy to decide who it applies to — which is exactly why it cannot be
 * talked past by a persuasive task description.
 *
 * ── THE ARTIFACT-FREE TASK ────────────────────────────────────────────────────
 * Some work genuinely produces no FILE: a decision, a review, a conversation, an
 * account change made in someone else's system. Those are not exempted, because
 * an exemption is a hole and holes are what this module closes. They are served
 * by the `url` deliverable type, which already exists in the schema and in
 * `CreateDeliverableSchema`: register the link to the decision, the thread, the
 * record, the changed resource. That is a real, checkable criterion — "say where
 * it landed" — rather than a category that skips the check entirely.
 */

import { queryAll } from '@/lib/db';
import { existsSync, statSync } from 'fs';

/**
 * Deliverable types that can serve as completion evidence.
 *
 * NOTE this is deliberately WIDER than the QC scorer's historical
 * `FILE_BACKED_DELIVERABLE_TYPES` (file/artifact/image), which omitted `url`.
 * That omission meant an agent which correctly registered a URL deliverable —
 * the right move for artifact-free work — still presented an empty manifest to
 * QC and fell through to description-only scoring. A URL is evidence.
 */
export const EVIDENCE_DELIVERABLE_TYPES = new Set(['file', 'artifact', 'image', 'url']);

export interface EvidenceRow {
  id: string;
  title: string;
  path: string | null;
  deliverable_type: string;
}

export interface CompletionEvidence {
  /** True when at least one registered deliverable is reachable. */
  hasEvidence: boolean;
  /** Deliverable rows of an evidence-bearing type (reachable or not). */
  rows: EvidenceRow[];
  /** Human-readable reasons each registered row failed to count, if any. */
  problems: string[];
}

/** True for a syntactically valid http(s) URL. */
export function isUsableUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** True when a filesystem path exists and holds more than zero bytes. */
export function isUsableFile(rawPath: string | null | undefined): boolean {
  if (!rawPath) return false;
  const resolved = rawPath.replace(/^~/, process.env.HOME || '');
  if (!existsSync(resolved)) return false;
  try {
    return statSync(resolved).size > 0;
  } catch {
    return false;
  }
}

/**
 * Collect the completion evidence registered against a task.
 *
 * Never throws: a DB error yields `hasEvidence: false` with the error recorded
 * in `problems`. Fail-closed is the point — an evidence check that cannot run
 * has not proven anything, and "we could not check" must never read as "it is
 * fine". A transient DB fault therefore holds the task rather than completing
 * it; the task stays where it is and can be retried, which is recoverable,
 * whereas a false `done` is durable and is not.
 */
export function collectCompletionEvidence(taskId: string): CompletionEvidence {
  let rows: EvidenceRow[] = [];
  try {
    rows = queryAll<EvidenceRow>(
      `SELECT id, title, path, deliverable_type FROM task_deliverables WHERE task_id = ?`,
      [taskId],
    ).filter((d) => EVIDENCE_DELIVERABLE_TYPES.has(d.deliverable_type));
  } catch (err) {
    return {
      hasEvidence: false,
      rows: [],
      problems: [`could not read task_deliverables: ${(err as Error).message}`],
    };
  }

  if (rows.length === 0) {
    return { hasEvidence: false, rows: [], problems: [] };
  }

  const problems: string[] = [];
  let usable = 0;

  for (const row of rows) {
    if (row.deliverable_type === 'url') {
      if (isUsableUrl(row.path)) usable += 1;
      else problems.push(`"${row.title}": not a valid http(s) URL (${row.path ?? 'no path'})`);
      continue;
    }
    if (isUsableFile(row.path)) usable += 1;
    else problems.push(`"${row.title}": file missing or empty (${row.path ?? 'no path'})`);
  }

  return { hasEvidence: usable > 0, rows, problems };
}

/**
 * The operator-facing explanation for a refused completion. Written to be
 * ACTIONABLE: a gate that only says "no" gets routed around, so this states the
 * exact call that clears it. Same text on every path so the refusal reads
 * identically whichever door it came from.
 */
export function noEvidenceMessage(taskId: string, evidence: CompletionEvidence): string {
  const detail =
    evidence.rows.length === 0
      ? 'No deliverable of any kind is registered against this task.'
      : `Registered deliverables are all unreachable: ${evidence.problems.join('; ')}.`;

  return (
    `Cannot record this task as done: no completion evidence. ${detail} ` +
    `A task may only be completed once the work it produced is registered and reachable. ` +
    `Register it with POST /api/tasks/${taskId}/deliverables ` +
    `— {"deliverable_type":"file","title":"<name>","path":"<absolute path>"} for a produced file, ` +
    `or {"deliverable_type":"url","title":"<name>","path":"https://..."} for work that lives ` +
    `somewhere else (a decision, a review, a record or resource changed in another system). ` +
    `This requirement is the same one the dispatch brief already states for every task.`
  );
}

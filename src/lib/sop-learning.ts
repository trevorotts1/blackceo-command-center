/**
 * SOP Layer 3 — learning-loop helpers.
 *
 * Three things live here:
 *   1. `recordFeedback`  — write a thumbs row into `sop_feedback`
 *   2. `computePerformance` — aggregate score for a SOP over the last N days
 *   3. `detectPatternsAndPropose` — nightly job: cluster recent un-SOP'd tasks,
 *      draft a candidate SOP from the highest-signal cluster member, insert
 *      into `sop_proposals` for owner review.
 *
 * Deliberately framework-light: pure functions on top of the db helpers so
 * the cron endpoint, the standalone script, and tests can all reuse them.
 */
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import type { SOP } from '@/lib/sops';

// ---------- types ----------

export interface SOPFeedbackRow {
  id: string;
  sop_id: string;
  task_id: string;
  rating: number; // 1 = thumbs up, -1 = thumbs down, 0 = skipped
  notes: string | null;
  agent_id: string | null;
  created_at: string;
}

export interface SOPProposalRow {
  id: string;
  proposed_name: string;
  proposed_department: string | null;
  draft_steps: string; // JSON SOPStep[]
  based_on_task_ids: string; // JSON string[]
  evidence_summary: string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  approved_sop_id: string | null;
}

export interface PerformanceReport {
  sop_id: string;
  window_days: number;
  feedback_count: number;
  positive_count: number;
  negative_count: number;
  skip_count: number;
  score: number; // sum(rating) / count
  positive_notes: string[];
  negative_notes: string[];
  ranking_signal: 'boost' | 'flag' | 'neutral';
  suggested_revisions: string[];
}

// ---------- 1. Feedback ----------

export interface RecordFeedbackInput {
  sop_id: string;
  task_id: string;
  rating: 1 | -1 | 0;
  notes?: string | null;
  agent_id?: string | null;
}

export function recordFeedback(input: RecordFeedbackInput): SOPFeedbackRow {
  const id = uuidv4();
  run(
    `INSERT INTO sop_feedback (id, sop_id, task_id, rating, notes, agent_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.sop_id, input.task_id, input.rating, input.notes ?? null, input.agent_id ?? null]
  );
  const row = queryOne<SOPFeedbackRow>('SELECT * FROM sop_feedback WHERE id = ?', [id]);
  if (!row) throw new Error('feedback row vanished after insert');
  return row;
}

// ---------- 2. Performance scoring ----------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'for', 'to', 'in', 'on', 'with',
  'this', 'that', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'as',
  'by', 'at', 'from', 'i', 'we', 'they', 'you', 'my', 'your', 'our', 'their',
  'do', 'did', 'done', 'use', 'used', 'using', 'task', 'tasks', 'work', 'works',
]);

export function computePerformance(sopId: string, windowDays = 30): PerformanceReport {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = queryAll<SOPFeedbackRow>(
    `SELECT * FROM sop_feedback WHERE sop_id = ? AND created_at >= ? ORDER BY created_at DESC`,
    [sopId, since]
  );

  const positive = rows.filter((r) => r.rating === 1);
  const negative = rows.filter((r) => r.rating === -1);
  const skip = rows.filter((r) => r.rating === 0);
  const ratingCount = positive.length + negative.length; // skips don't count toward score
  const score = ratingCount === 0 ? 0 : (positive.length - negative.length) / ratingCount;

  let signal: PerformanceReport['ranking_signal'] = 'neutral';
  if (ratingCount >= 3 && score > 0.7) signal = 'boost';
  else if (ratingCount >= 3 && score < -0.3) signal = 'flag';

  const positiveNotes = positive.map((r) => r.notes).filter((n): n is string => !!n && n.trim().length > 0).slice(0, 5);
  const negativeNotes = negative.map((r) => r.notes).filter((n): n is string => !!n && n.trim().length > 0).slice(0, 5);

  const suggestedRevisions: string[] = [];
  if (signal === 'flag') {
    if (negativeNotes.length > 0) {
      suggestedRevisions.push(`Address recurring complaints: ${negativeNotes.slice(0, 3).join(' | ')}`);
    } else {
      suggestedRevisions.push('SOP is being thumbed-down but no notes were left. Capture WHY on next failure.');
    }
  }

  return {
    sop_id: sopId,
    window_days: windowDays,
    feedback_count: rows.length,
    positive_count: positive.length,
    negative_count: negative.length,
    skip_count: skip.length,
    score,
    positive_notes: positiveNotes,
    negative_notes: negativeNotes,
    ranking_signal: signal,
    suggested_revisions: suggestedRevisions,
  };
}

// ---------- 3. Pattern detection + proposal generation ----------

export interface PatternDetectionOptions {
  lookback_days?: number; // how far back to scan completed tasks
  min_cluster_size?: number; // min tasks per cluster (default 5)
  min_unsoped_in_cluster?: number; // min tasks WITHOUT a sop_id (default 3)
  max_proposals?: number; // safety cap per run
}

interface CompletedTaskLite {
  id: string;
  title: string;
  description: string | null;
  workspace_id: string | null;
  department: string | null;
  sop_id: string | null;
  completed_at: string | null;
}

interface KeywordCluster {
  department: string;
  signature_keywords: string[];
  task_ids: string[];
  unsoped_task_ids: string[];
  exemplar_task_id: string;
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

function topKeywords(text: string, n = 5): string[] {
  const freq = new Map<string, number>();
  for (const w of extractKeywords(text)) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

function clusterTasks(tasks: CompletedTaskLite[]): KeywordCluster[] {
  // Group by (department, top-keyword). Each task contributes to AT MOST one
  // cluster — its single highest-frequency keyword. Simple and predictable;
  // resists overcounting noisy multi-keyword titles.
  const groups = new Map<string, CompletedTaskLite[]>();

  for (const t of tasks) {
    const dept = t.department || t.workspace_id || 'unknown';
    const combined = `${t.title || ''} ${t.description || ''}`;
    const kw = topKeywords(combined, 1)[0];
    if (!kw) continue;
    const key = `${dept}::${kw}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const clusters: KeywordCluster[] = [];
  groups.forEach((list: CompletedTaskLite[], key: string) => {
    const [dept, primaryKw] = key.split('::');
    const unsoped = list.filter((t: CompletedTaskLite) => !t.sop_id);
    // Use the combined corpus of the cluster to find shared signature keywords
    const corpus = list.map((t: CompletedTaskLite) => `${t.title || ''} ${t.description || ''}`).join(' ');
    const signature = topKeywords(corpus, 5);
    if (!signature.includes(primaryKw)) signature.unshift(primaryKw);

    // Exemplar = the unsoped task with the longest description, since we'll
    // use its content as the seed for the draft steps.
    const candidates: CompletedTaskLite[] = unsoped.length > 0 ? unsoped : list;
    const exemplar = [...candidates].sort(
      (a: CompletedTaskLite, b: CompletedTaskLite) => (b.description?.length || 0) - (a.description?.length || 0)
    )[0];

    clusters.push({
      department: dept,
      signature_keywords: signature.slice(0, 5),
      task_ids: list.map((t: CompletedTaskLite) => t.id),
      unsoped_task_ids: unsoped.map((t: CompletedTaskLite) => t.id),
      exemplar_task_id: exemplar.id,
    });
  });
  return clusters;
}

function draftStepsFromTask(task: CompletedTaskLite, keywords: string[]): { name: string; description?: string; checklist?: string[] }[] {
  const desc = (task.description || '').trim();

  // Heuristic step extraction: if the description has numbered or dashed
  // bullets, use them. Otherwise, generate a 3-step skeleton.
  const lines = desc.split('\n').map((l) => l.trim()).filter(Boolean);
  const bulletLines = lines.filter((l) => /^(\d+[.)]\s|-\s|\*\s)/.test(l));

  if (bulletLines.length >= 2) {
    return bulletLines.slice(0, 8).map((l, i) => ({
      name: `Step ${i + 1}: ${l.replace(/^(\d+[.)]\s|-\s|\*\s)/, '').slice(0, 80)}`,
    }));
  }

  const kw = keywords.slice(0, 3).join(', ');
  return [
    {
      name: `1. Scope the work (${kw || 'inputs'})`,
      checklist: ['Confirm inputs and acceptance criteria', 'Identify owner and SLA'],
    },
    {
      name: `2. Execute the procedure`,
      checklist: ['Follow the documented steps', 'Capture artifacts as you go'],
    },
    {
      name: `3. Hand off / close out`,
      checklist: ['Verify success criteria', 'Notify stakeholders', 'Update CRM/Notion as applicable'],
    },
  ];
}

export interface DetectionResult {
  scanned_tasks: number;
  clusters_found: number;
  proposals_created: number;
  proposal_ids: string[];
}

export function detectPatternsAndPropose(opts: PatternDetectionOptions = {}): DetectionResult {
  const lookbackDays = opts.lookback_days ?? 30;
  const minClusterSize = opts.min_cluster_size ?? 5;
  const minUnsoped = opts.min_unsoped_in_cluster ?? 3;
  const maxProposals = opts.max_proposals ?? 10;

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const tasks = queryAll<CompletedTaskLite>(
    `SELECT id, title, description, workspace_id,
            COALESCE(NULL, workspace_id) AS department, sop_id,
            updated_at AS completed_at
     FROM tasks
     WHERE status = 'done' AND updated_at >= ?`,
    [since]
  );

  const clusters = clusterTasks(tasks);

  // Only clusters big enough AND with enough un-SOP'd tasks count as
  // "candidates" — that's the signal that real recurring work is happening
  // without a documented procedure.
  const candidates = clusters
    .filter((c) => c.task_ids.length >= minClusterSize && c.unsoped_task_ids.length >= minUnsoped)
    .sort((a, b) => b.unsoped_task_ids.length - a.unsoped_task_ids.length);

  const created: string[] = [];

  // Don't propose duplicates: skip a cluster if a pending proposal already
  // exists with the same dept + overlapping signature keywords.
  const existingPending = queryAll<{ proposed_name: string; proposed_department: string | null }>(
    `SELECT proposed_name, proposed_department FROM sop_proposals WHERE status = 'pending'`,
    []
  );

  for (const cluster of candidates) {
    if (created.length >= maxProposals) break;

    const duplicate = existingPending.some((p) => {
      if ((p.proposed_department || '') !== cluster.department) return false;
      const existingTokens = p.proposed_name.toLowerCase().split(/\s+/);
      return cluster.signature_keywords.some((kw) => existingTokens.includes(kw));
    });
    if (duplicate) continue;

    const exemplar = tasks.find((t) => t.id === cluster.exemplar_task_id);
    if (!exemplar) continue;

    const steps = draftStepsFromTask(exemplar, cluster.signature_keywords);
    const proposedName = `${cluster.signature_keywords.slice(0, 3).map(capitalize).join(' ')} SOP`;
    const evidence = [
      `Detected ${cluster.task_ids.length} completed tasks in ${cluster.department} matching keywords: ${cluster.signature_keywords.join(', ')}`,
      `${cluster.unsoped_task_ids.length} of those tasks ran WITHOUT an attached SOP`,
      `Exemplar task: ${exemplar.title}`,
    ].join('\n');

    const id = uuidv4();
    run(
      `INSERT INTO sop_proposals (id, proposed_name, proposed_department, draft_steps, based_on_task_ids, evidence_summary, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [
        id,
        proposedName,
        cluster.department,
        JSON.stringify(steps),
        JSON.stringify(cluster.task_ids),
        evidence,
      ]
    );
    created.push(id);
  }

  return {
    scanned_tasks: tasks.length,
    clusters_found: candidates.length,
    proposals_created: created.length,
    proposal_ids: created,
  };
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- 3b. Triad-block → on-demand draft proposal ----------

export interface TriadDraftInput {
  task_id: string;
  title: string;
  description?: string | null;
  department?: string | null;
  persona_id?: string | null;
}

export interface TriadDraftResult {
  created: boolean;
  proposal_id: string | null;
  reason?: string;
}

/**
 * Marker prefix written into a draft proposal's `evidence_summary` when it was
 * born from a Triad block (a task was blocked from leaving backlog because it
 * had no SOP). Lets the proposals UI / queries identify these and lets THIS
 * function dedupe so a repeatedly-blocked task does not spawn a pile of drafts.
 */
const TRIAD_DRAFT_MARKER = '[TRIAD-BLOCK DRAFT — needs-review]';

/**
 * Create a DRAFT SOP proposal from a task that the Triad Rule just blocked for
 * having no SOP. The draft is pre-filled from the task title/description (+ the
 * task's department and intended persona) and inserted as a normal `pending`
 * proposal so it shows up in the existing /sops/proposals review queue, where
 * the dept head approves it into a real SOP (approveProposal) and then attaches
 * it to the task.
 *
 * Idempotent: if a pending Triad-block draft already exists for this exact
 * task_id we return {created:false} instead of inserting a duplicate. Never
 * throws into the request path — callers treat a failure as best-effort.
 */
export function proposeDraftFromTask(input: TriadDraftInput): TriadDraftResult {
  const title = (input.title || '').trim();
  if (!title) {
    return { created: false, proposal_id: null, reason: 'task has no title to seed a draft from' };
  }

  // Dedupe: one pending Triad-block draft per task. based_on_task_ids carries
  // the originating task id; the marker scopes the LIKE to triad drafts only.
  const existing = queryOne<{ id: string }>(
    `SELECT id FROM sop_proposals
       WHERE status = 'pending'
         AND evidence_summary LIKE ?
         AND based_on_task_ids LIKE ?
       LIMIT 1`,
    [`${TRIAD_DRAFT_MARKER}%`, `%${input.task_id}%`]
  );
  if (existing) {
    return { created: false, proposal_id: existing.id, reason: 'a pending Triad-block draft already exists for this task' };
  }

  const department = input.department || null;
  const combined = `${title} ${input.description || ''}`;
  const keywords = topKeywords(combined, 5);

  // Reuse the same heuristic step-drafter the nightly loop uses, fed by this
  // single task as the exemplar.
  const exemplar: CompletedTaskLite = {
    id: input.task_id,
    title,
    description: input.description ?? null,
    workspace_id: department,
    department,
    sop_id: null,
    completed_at: null,
  };
  const steps = draftStepsFromTask(exemplar, keywords);

  const proposedName = `${title.slice(0, 60)} SOP`;
  const personaLine = isValidTriadPersona(input.persona_id)
    ? `Intended persona: ${input.persona_id}`
    : 'No persona set on the task yet — assign one when approving.';
  const evidence = [
    TRIAD_DRAFT_MARKER,
    `Task "${title}" was blocked from leaving backlog by the Triad Rule because it has no SOP.`,
    `Department: ${department || 'unassigned'}`,
    personaLine,
    `This is a pre-filled DRAFT seeded from the task title/description. Review the steps, edit as needed, then approve to author the SOP and unblock the task.`,
    input.description ? `\nTask description:\n${input.description.slice(0, 1500)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const id = uuidv4();
  run(
    `INSERT INTO sop_proposals (id, proposed_name, proposed_department, draft_steps, based_on_task_ids, evidence_summary, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [id, proposedName, department, JSON.stringify(steps), JSON.stringify([input.task_id]), evidence]
  );
  return { created: true, proposal_id: id };
}

/**
 * Local persona validity check mirroring sops.ts isValidPersonaId without
 * importing the route-layer module into the learning helpers. Used only to
 * decide how to word the draft's evidence line.
 */
function isValidTriadPersona(personaId: string | null | undefined): boolean {
  if (!personaId) return false;
  const v = personaId.toLowerCase().trim();
  return !['schemaversion', 'schema_version', 'null', 'none', 'undefined', ''].includes(v);
}

// ---------- Approval (creates the actual SOP row) ----------

export interface ApproveProposalResult {
  proposal: SOPProposalRow;
  sop: SOP;
}

export function approveProposal(proposalId: string, reviewer: string | null): ApproveProposalResult {
  const proposal = queryOne<SOPProposalRow>('SELECT * FROM sop_proposals WHERE id = ?', [proposalId]);
  if (!proposal) throw new Error('proposal not found');
  if (proposal.status !== 'pending') throw new Error(`proposal already ${proposal.status}`);

  const sopId = uuidv4();
  const slug =
    proposal.proposed_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || `proposed-${sopId.slice(0, 8)}`;

  // Ensure slug uniqueness; if collision, suffix the short proposal id.
  const collision = queryOne<{ id: string }>('SELECT id FROM sops WHERE slug = ?', [slug]);
  const finalSlug = collision ? `${slug}-${sopId.slice(0, 6)}` : slug;

  const now = new Date().toISOString();
  run(
    `INSERT INTO sops (id, name, slug, description, version, department, task_keywords, steps, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      sopId,
      proposal.proposed_name,
      finalSlug,
      proposal.evidence_summary,
      proposal.proposed_department,
      null,
      proposal.draft_steps,
      now,
      now,
    ]
  );

  run(
    `UPDATE sop_proposals
     SET status = 'approved', reviewed_at = ?, reviewed_by = ?, approved_sop_id = ?
     WHERE id = ?`,
    [now, reviewer, sopId, proposalId]
  );

  const updatedProposal = queryOne<SOPProposalRow>('SELECT * FROM sop_proposals WHERE id = ?', [proposalId])!;
  const sop = queryOne<SOP>('SELECT * FROM sops WHERE id = ?', [sopId])!;
  return { proposal: updatedProposal, sop };
}

export function rejectProposal(proposalId: string, reviewer: string | null, reason?: string): SOPProposalRow {
  const proposal = queryOne<SOPProposalRow>('SELECT * FROM sop_proposals WHERE id = ?', [proposalId]);
  if (!proposal) throw new Error('proposal not found');
  if (proposal.status !== 'pending') throw new Error(`proposal already ${proposal.status}`);

  const now = new Date().toISOString();
  const note = reason ? `${proposal.evidence_summary || ''}\n\n[REJECTED] ${reason}` : proposal.evidence_summary;

  run(
    `UPDATE sop_proposals
     SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, evidence_summary = ?
     WHERE id = ?`,
    [now, reviewer, note, proposalId]
  );
  return queryOne<SOPProposalRow>('SELECT * FROM sop_proposals WHERE id = ?', [proposalId])!;
}

/**
 * Track S — Auto-research and auto-replace deleted SOPs.
 *
 * Flow:
 *   1. Operator soft-deletes a SOP that has impacted tasks.
 *   2. The DELETE handler calls `enqueueAutoReplace(deletedSopId)` which
 *      checks the recursive-safety cap and either:
 *        a. Runs the research synchronously and writes an
 *           `auto-generated-pending-review` proposal, OR
 *        b. Writes an `escalated` row + Telegram alert when the safety cap
 *           is hit (>= 3 attempts on the same slug in the last 7 days).
 *   3. Operator approves on `/sops/proposals` → atomically inserts a v2
 *      SOP and re-points every task referencing the deleted v1.
 *
 * Side-effects (Tavily, Gemini, Telegram) are gated by env vars so tests
 * can run end-to-end on fixtures at $0 cost.
 */

import { v4 as uuidv4 } from 'uuid';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { parseAndValidateSteps, type SOP, type SOPStep } from '@/lib/sops';
import { tavilySearch, type TavilyResult } from '@/lib/tavily';
import { geminiGenerate } from '@/lib/gemini';

export interface AutoReplaceProposalRow {
  id: string;
  proposed_name: string;
  proposed_department: string | null;
  draft_steps: string;
  based_on_task_ids: string;
  evidence_summary: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'auto-generated-pending-review' | 'escalated';
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  approved_sop_id: string | null;
  replaces_sop_id: string | null;
  confidence: number | null;
  auto_research_attempts: number;
  research_sources: string | null;
}

export interface AutoReplaceResult {
  proposal_id: string;
  status: AutoReplaceProposalRow['status'];
  attempts: number;
  escalated: boolean;
  notified: boolean;
}

const WORKSPACE_BASE = process.env.OPENCLAW_WORKSPACE_PATH || '/data/.openclaw/workspace';

function safeReadWorkspaceFile(filename: string): string {
  // Workspace files live outside the Next.js sandbox on the VPS. Try direct
  // fs read first (dev path), fall back to `cat` via execFileSync when
  // Node lacks direct read permission (prod sandbox).
  const full = path.join(WORKSPACE_BASE, filename);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch {
    try {
      return execFileSync('cat', [full], { encoding: 'utf8', timeout: 5_000 });
    } catch {
      return ''; // graceful — voice context is optional
    }
  }
}

function readSoulAndUser(): { soul: string; user: string } {
  return {
    soul: safeReadWorkspaceFile('SOUL.md').slice(0, 8_000),
    user: safeReadWorkspaceFile('USER.md').slice(0, 4_000),
  };
}

function buildResearchQuery(sop: SOP): string {
  const year = new Date().getFullYear();
  const dept = sop.department || '';
  return `${dept} ${sop.name} best practices ${year}`.trim();
}

function buildSynthesisPrompt(opts: {
  deletedSop: SOP;
  soul: string;
  user: string;
  tavilyResults: TavilyResult[];
  tavilyAnswer?: string;
}): string {
  const { deletedSop, soul, user, tavilyResults, tavilyAnswer } = opts;
  const research = tavilyResults
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || '').slice(0, 600)}`)
    .join('\n\n');

  return [
    `You are drafting a v2 SOP to replace one an operator just deleted.`,
    `Your output MUST be a single JSON object matching this schema (no markdown, no commentary):`,
    `{`,
    `  "name": "string",`,
    `  "description": "string",`,
    `  "department": "string",`,
    `  "task_keywords": "comma,separated,keywords",`,
    `  "success_criteria": "string",`,
    `  "steps": [ { "name": "string", "checklist": ["string"], "success_criteria": "string" } ],`,
    `  "confidence": 0.0-1.0`,
    `}`,
    ``,
    `### Deleted v1 (the operator rejected this; produce a DIFFERENT approach)`,
    `Name: ${deletedSop.name}`,
    `Department: ${deletedSop.department || 'n/a'}`,
    `Steps JSON: ${deletedSop.steps}`,
    ``,
    `### Client voice (SOUL.md excerpt)`,
    soul ? soul : '(no SOUL.md available; use a neutral professional tone)',
    ``,
    `### Client values / operator (USER.md excerpt)`,
    user ? user : '(no USER.md available)',
    ``,
    `### Tavily research results`,
    tavilyAnswer ? `Summary: ${tavilyAnswer}\n` : '',
    research,
    ``,
    `### Drafting rules`,
    `1. Steps must be concrete, sequenced, and actionable, not platitudes.`,
    `2. Each step has a checklist of 2-5 atomic items and a success_criteria sentence.`,
    `3. Match the client's voice. If SOUL.md is empty, default to plain professional English.`,
    `4. Produce a DIFFERENT approach from the deleted v1; assume v1 failed for some reason.`,
    `5. Confidence is your honest 0-1 estimate based on how grounded the research was.`,
    `6. Output the JSON object only. No prose, no markdown fences.`,
  ].join('\n');
}

interface DraftedSOP {
  name: string;
  description?: string;
  department?: string;
  task_keywords?: string;
  success_criteria?: string;
  steps: SOPStep[];
  confidence?: number;
}

function parseDraftedSOP(raw: string): DraftedSOP {
  // Strip ```json``` fences Gemini sometimes emits despite response_mime_type.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Synthesizer returned non-JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Synthesizer output must be a JSON object');
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.name !== 'string' || !p.name.trim()) {
    throw new Error('Synthesizer output missing required field: name');
  }
  const steps = parseAndValidateSteps(p.steps);
  const confidence = typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : null;
  return {
    name: p.name.trim(),
    description: typeof p.description === 'string' ? p.description : undefined,
    department: typeof p.department === 'string' ? p.department : undefined,
    task_keywords: typeof p.task_keywords === 'string' ? p.task_keywords : undefined,
    success_criteria: typeof p.success_criteria === 'string' ? p.success_criteria : undefined,
    steps,
    confidence: confidence ?? undefined,
  };
}

function getRecentAttemptCount(deletedSop: SOP): number {
  // "Same slug" = same department + name match within the last 7 days.
  // Counts both successful auto-research proposals AND rejected ones —
  // a rejected proposal still consumed Tavily + Gemini budget.
  const namePattern = `%${deletedSop.name.split(/\s+/).slice(0, 3).join(' ')}%`;
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sop_proposals
       WHERE proposed_department = ?
         AND proposed_name LIKE ?
         AND created_at > datetime('now', '-7 days')
         AND status IN ('auto-generated-pending-review', 'rejected', 'escalated')`,
    [deletedSop.department, namePattern]
  );
  return row?.n ?? 0;
}

function countImpactedTasks(sopId: string): number {
  const row = queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM tasks WHERE sop_id = ?',
    [sopId]
  );
  return row?.n ?? 0;
}

function findClientChatId(): string | null {
  // Per MEMORY.md: source of truth for paired Telegram chat IDs is
  // agents/main/sessions/sessions.json under `agent:main:telegram:direct:<id>`.
  const sessionsPath = path.join(WORKSPACE_BASE, 'agents/main/sessions/sessions.json');
  try {
    let raw = '';
    if (fs.existsSync(sessionsPath)) {
      raw = fs.readFileSync(sessionsPath, 'utf8');
    } else {
      raw = execFileSync('cat', [sessionsPath], { encoding: 'utf8', timeout: 5_000 });
    }
    const data = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(data).filter((k) => k.startsWith('agent:main:telegram:direct:'));
    // Skip Trevor's known operator ID — we want the client's ID.
    const TREVOR_ID = '5252140759';
    for (const k of keys) {
      const id = k.split(':').pop();
      if (id && id !== TREVOR_ID) return id;
    }
    return keys[0]?.split(':').pop() || null;
  } catch {
    return null;
  }
}

function notifyTelegram(opts: { chatId: string; message: string }): boolean {
  // Per MEMORY.md, never bypass OpenClaw's gateway. Always shell to
  // `openclaw message send`. Honor a disable flag for tests.
  if (process.env.SOP_AUTO_REPLACE_TELEGRAM_DISABLED === '1') {
    return false;
  }
  try {
    execFileSync(
      'openclaw',
      ['message', 'send', '--channel', 'telegram', '--to', opts.chatId, '--text', opts.message],
      { stdio: 'pipe', timeout: 10_000 }
    );
    return true;
  } catch (err) {
    console.error('[sop-auto-replace] Telegram send failed:', (err as Error).message);
    return false;
  }
}

export interface EnqueueAutoReplaceOptions {
  /** Override impacted-task count (the DELETE handler usually already has it). */
  impactedTasks?: number;
  /** Disable Telegram during smoke tests. */
  notify?: boolean;
}

export async function enqueueAutoReplace(
  deletedSopId: string,
  opts: EnqueueAutoReplaceOptions = {}
): Promise<AutoReplaceResult> {
  const deletedSop = queryOne<SOP>(
    'SELECT * FROM sops WHERE id = ? OR slug = ?',
    [deletedSopId, deletedSopId]
  );
  if (!deletedSop) throw new Error(`SOP not found: ${deletedSopId}`);

  const impactedTasks = opts.impactedTasks ?? countImpactedTasks(deletedSop.id);
  const recentAttempts = getRecentAttemptCount(deletedSop);
  const proposalId = uuidv4();
  const now = new Date().toISOString();

  // ----- Recursive safety cap -----
  if (recentAttempts >= 3) {
    const evidence = `Auto-research safety cap hit: ${recentAttempts} prior attempts on "${deletedSop.name}" (${deletedSop.department}) in the last 7 days. Manual authoring required.`;
    run(
      `INSERT INTO sop_proposals
         (id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
          evidence_summary, status, created_at, replaces_sop_id, confidence,
          auto_research_attempts, research_sources)
       VALUES (?, ?, ?, ?, ?, ?, 'escalated', ?, ?, NULL, ?, NULL)`,
      [
        proposalId,
        `[ESCALATED] ${deletedSop.name}`,
        deletedSop.department,
        deletedSop.steps,
        JSON.stringify([]),
        evidence,
        now,
        deletedSop.id,
        recentAttempts + 1,
      ]
    );
    let notified = false;
    if (opts.notify !== false) {
      const chatId = findClientChatId();
      if (chatId) {
        notified = notifyTelegram({
          chatId,
          message: `Auto-research escalation: "${deletedSop.name}" has hit the 3-attempt safety cap. ${impactedTasks} tasks are blocked. Manual author required.`,
        });
      }
    }
    return { proposal_id: proposalId, status: 'escalated', attempts: recentAttempts + 1, escalated: true, notified };
  }

  // ----- Research + synthesis -----
  const { soul, user } = readSoulAndUser();
  const query = buildResearchQuery(deletedSop);
  const tavily = await tavilySearch(query, { max_results: 5 });
  const synthesisPrompt = buildSynthesisPrompt({
    deletedSop,
    soul,
    user,
    tavilyResults: tavily.results,
    tavilyAnswer: tavily.answer,
  });
  const raw = await geminiGenerate(synthesisPrompt, { response_mime_type: 'application/json' });
  const drafted = parseDraftedSOP(raw);

  const sources = tavily.results.slice(0, 5).map((r) => ({ title: r.title, url: r.url }));
  const evidenceSummary = [
    `Auto-researched replacement for deleted SOP "${deletedSop.name}".`,
    `Tavily query: ${query}`,
    tavily.answer ? `Synthesis hint: ${tavily.answer}` : '',
    `Top sources:`,
    ...sources.map((s, i) => `  [${i + 1}] ${s.title} (${s.url})`),
    ``,
    `Operator: review the diff vs v1, verify the sources, then approve to atomically swap.`,
  ]
    .filter(Boolean)
    .join('\n');

  run(
    `INSERT INTO sop_proposals
       (id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
        evidence_summary, status, created_at, replaces_sop_id, confidence,
        auto_research_attempts, research_sources)
     VALUES (?, ?, ?, ?, ?, ?, 'auto-generated-pending-review', ?, ?, ?, ?, ?)`,
    [
      proposalId,
      drafted.name,
      drafted.department || deletedSop.department,
      JSON.stringify(drafted.steps),
      JSON.stringify([]),
      evidenceSummary,
      now,
      deletedSop.id,
      drafted.confidence ?? null,
      recentAttempts + 1,
      JSON.stringify(sources),
    ]
  );

  let notified = false;
  if (opts.notify !== false) {
    const chatId = findClientChatId();
    if (chatId) {
      const message = [
        `Quick heads-up:`,
        ``,
        `You deleted the SOP "${deletedSop.name}". ${impactedTasks} tasks reference it and are now blocked.`,
        ``,
        `I researched current best practices and drafted a replacement.`,
        `Confidence: ${drafted.confidence ?? 'unscored'}`,
        `Top sources:`,
        ...sources.slice(0, 3).map((s) => `  • ${s.url}`),
        ``,
        `Review: /sops/proposals/${proposalId}`,
        `One click approve unblocks the ${impactedTasks} tasks.`,
      ].join('\n');
      notified = notifyTelegram({ chatId, message });
    }
  }

  return {
    proposal_id: proposalId,
    status: 'auto-generated-pending-review',
    attempts: recentAttempts + 1,
    escalated: false,
    notified,
  };
}

// ----------------------------------------------------------------------
// Approval — atomically inserts v2 SOP and re-points impacted tasks.
// ----------------------------------------------------------------------

export interface ApproveAutoResearchInput {
  proposalId: string;
  reviewer?: string | null;
  edits?: {
    name?: string;
    description?: string;
    department?: string;
    task_keywords?: string;
    steps?: SOPStep[];
    success_criteria?: string;
  };
}

export interface ApproveAutoResearchResult {
  sop_id: string;
  proposal_id: string;
  retargeted_tasks: number;
}

export function approveAutoResearchProposal(input: ApproveAutoResearchInput): ApproveAutoResearchResult {
  const proposal = queryOne<AutoReplaceProposalRow>(
    'SELECT * FROM sop_proposals WHERE id = ?',
    [input.proposalId]
  );
  if (!proposal) throw new Error('proposal not found');
  if (proposal.status !== 'auto-generated-pending-review') {
    throw new Error(`proposal status is ${proposal.status}, expected auto-generated-pending-review`);
  }

  const sopId = uuidv4();
  const now = new Date().toISOString();

  const finalName = input.edits?.name?.trim() || proposal.proposed_name;
  const finalDept = input.edits?.department ?? proposal.proposed_department;
  const finalSteps = input.edits?.steps ? JSON.stringify(input.edits.steps) : proposal.draft_steps;
  const finalDescription = input.edits?.description ?? proposal.evidence_summary;
  const finalKeywords = input.edits?.task_keywords ?? null;
  const finalSuccess = input.edits?.success_criteria ?? null;

  const baseSlug =
    finalName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || `auto-${sopId.slice(0, 8)}`;
  const collision = queryOne<{ id: string }>('SELECT id FROM sops WHERE slug = ?', [baseSlug]);
  const finalSlug = collision ? `${baseSlug}-${sopId.slice(0, 6)}` : baseSlug;

  const v1 = proposal.replaces_sop_id
    ? queryOne<SOP>('SELECT * FROM sops WHERE id = ?', [proposal.replaces_sop_id])
    : null;
  const newVersion = (v1?.version ?? 1) + 1;

  const result = transaction(() => {
    run(
      `INSERT INTO sops
         (id, name, slug, description, version, department, task_keywords,
          steps, success_criteria, persona_hints, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        sopId,
        finalName,
        finalSlug,
        finalDescription,
        newVersion,
        finalDept,
        finalKeywords,
        finalSteps,
        finalSuccess,
        now,
        now,
      ]
    );

    let retargeted = 0;
    if (proposal.replaces_sop_id) {
      const upd = run('UPDATE tasks SET sop_id = ? WHERE sop_id = ?', [sopId, proposal.replaces_sop_id]);
      retargeted = upd.changes;
    }

    run(
      `UPDATE sop_proposals
         SET status = 'approved', reviewed_at = ?, reviewed_by = ?, approved_sop_id = ?
       WHERE id = ?`,
      [now, input.reviewer ?? null, sopId, input.proposalId]
    );

    return { retargeted };
  });

  return {
    sop_id: sopId,
    proposal_id: input.proposalId,
    retargeted_tasks: result.retargeted,
  };
}

/**
 * Side-by-side diff helper used by `/sops/proposals/[id]` page.
 */
export function loadProposalWithV1(
  proposalId: string
): { proposal: AutoReplaceProposalRow; v1: SOP | null; impacted_tasks: number } | null {
  const proposal = queryOne<AutoReplaceProposalRow>(
    'SELECT * FROM sop_proposals WHERE id = ?',
    [proposalId]
  );
  if (!proposal) return null;
  const v1 = proposal.replaces_sop_id
    ? queryOne<SOP>('SELECT * FROM sops WHERE id = ?', [proposal.replaces_sop_id]) || null
    : null;
  const impactedTasks = proposal.replaces_sop_id ? countImpactedTasks(proposal.replaces_sop_id) : 0;
  return { proposal, v1, impacted_tasks: impactedTasks };
}

export function loadAllAutoResearchProposals(
  status: AutoReplaceProposalRow['status'] = 'auto-generated-pending-review'
) {
  const proposals = queryAll<AutoReplaceProposalRow>(
    'SELECT * FROM sop_proposals WHERE status = ? ORDER BY created_at DESC',
    [status]
  );
  return proposals.map((p) => {
    const v1 = p.replaces_sop_id
      ? queryOne<SOP>('SELECT * FROM sops WHERE id = ?', [p.replaces_sop_id]) || null
      : null;
    return { proposal: p, v1 };
  });
}

export { countImpactedTasks };

/**
 * Fail-safe for an unanswered "Who will be reading this?" past the deadline.
 * Instead of the neutral house-voice release, best-guess the audience:
 *   (a) the most frequently confirmed audience on this box (last 90 days);
 *   (b) an LLM inference from what the box knows about the client;
 * and only when both fail does the caller fall back to the house-voice release.
 * Never messages the client. Hard-hold departments never reach this module.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { resolveCompanyConfigHint } from '@/lib/persona-selector';
import { decryptOrPassthrough } from '@/lib/interview/crypto';
import { shortCompletion } from '@/lib/intake/short-completion';
import { confirmTaskAudience, rescoreAudienceBlend } from '@/lib/tasks';
import type { Task } from '@/lib/types';

export const BEST_GUESS_LLM_TIMEOUT_MS = 20_000;
const MAX_LABEL = 80;

export type BestGuessLlm = (system: string, user: string, timeoutMs: number) => Promise<string>;

/** Tier (a): most frequent confirmed audience on this box, last 90 days. */
export function mostCommonConfirmedAudience(excludeTaskId: string): { label: string; count: number } | null {
  try {
    const row = queryOne<{ label: string; n: number }>(
      `SELECT MIN(TRIM(audience_label)) AS label, COUNT(*) AS n FROM tasks
        WHERE id != ? AND audience_label IS NOT NULL AND TRIM(audience_label) != ''
          AND audience_source IN ('operator_confirmed','task_named','owner_default')
          AND created_at >= datetime('now','-90 days')
        GROUP BY LOWER(TRIM(audience_label)) ORDER BY n DESC, MAX(created_at) DESC LIMIT 1`,
      [excludeTaskId],
    );
    return row?.label ? { label: row.label, count: row.n } : null;
  } catch { return null; }
}

/** Accept a single short plain label; reject instructions / refusals. */
export function validateAudienceLabel(raw: string | null | undefined): string | null {
  let s = (raw ?? '').trim().replace(/^["'`]+|["'`.]+$/g, '').trim();
  if (!s || s.includes('\n') || s.length > MAX_LABEL) return null;
  if (/\b(ignore|instruction|as an ai|i cannot|i can't|sorry|unable|unknown|n\/a)\b|[{}<>]/i.test(s)) return null;
  s = s.replace(/^(audience|label)\s*:\s*/i, '');
  return s || null;
}

function readSnippet(file: string, max: number): string {
  try { return fs.readFileSync(file, 'utf-8').slice(0, max); } catch { return ''; }
}

/** What the box knows about the client, as bounded plain text. Best-effort. */
export function assembleClientKnowledge(task: Pick<Task, 'title' | 'description'>): string {
  const parts: string[] = [];
  const cfgPath = resolveCompanyConfigHint();
  const dirs = new Set<string>([path.join(os.homedir(), '.openclaw', 'workspace')]);
  if (cfgPath) {
    parts.push(`company-config: ${readSnippet(cfgPath, 2500)}`);
    dirs.add(path.dirname(cfgPath));
  }
  for (const d of dirs) for (const f of ['SOUL.md', 'IDENTITY.md']) {
    const t = readSnippet(path.join(d, f), 1200);
    if (t) parts.push(`${f}: ${t}`);
  }
  try {
    const t = queryOne<{ tenant_id: string }>('SELECT tenant_id FROM tenant_interviews LIMIT 1');
    if (t) {
      const rows = queryAll<{ question_text: string; answer_text: string }>(
        'SELECT question_text, answer_text FROM tenant_interview_answers WHERE tenant_id=? ORDER BY revision DESC LIMIT 12', [t.tenant_id]);
      const qa = rows.map((r) => `Q: ${decryptOrPassthrough(r.question_text) ?? ''} A: ${(decryptOrPassthrough(r.answer_text) ?? '').slice(0, 300)}`).join('\n');
      if (qa) parts.push(`interview answers:\n${qa}`);
    }
  } catch { /* table absent */ }
  parts.push(`task title: ${task.title}`, `task description: ${(task.description ?? '').slice(0, 1000)}`);
  return parts.join('\n\n').slice(0, 9000);
}

const SYSTEM =
  'You infer who will read a piece of content for a business client. ' +
  'Reply with ONE short audience label only (max 12 words), e.g. "women entrepreneurs in the coaching community". ' +
  'No sentences, no quotes, no explanation.';

/** Tier (b): LLM inference. Returns a validated label or null. */
export async function inferAudienceFromClientKnowledge(
  task: Pick<Task, 'title' | 'description'>,
  llm: BestGuessLlm = shortCompletion,
): Promise<string | null> {
  try {
    const out = await llm(SYSTEM, assembleClientKnowledge(task), BEST_GUESS_LLM_TIMEOUT_MS);
    return validateAudienceLabel(out);
  } catch { return null; }
}

/**
 * Tier a then b. On success confirms through the normal confirm path with
 * source 'best_guess', logs one audience_best_guess event and returns the label;
 * returns null (nothing written) when both tiers fail so the caller releases on house voice.
 */
export async function bestGuessAudienceForTask(
  taskId: string,
  agentId: string | null,
  llm: BestGuessLlm = shortCompletion,
  rescore: typeof rescoreAudienceBlend = rescoreAudienceBlend,
): Promise<{ label: string; tier: 'most_common' | 'inferred' } | null> {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) return null;
  let label: string | null = null;
  let tier: 'most_common' | 'inferred' = 'most_common';
  let why = '';
  const common = mostCommonConfirmedAudience(taskId);
  if (common) { label = common.label; why = `most frequently confirmed audience on this box (${common.count} tasks in 90 days)`; }
  else {
    label = await inferAudienceFromClientKnowledge(task, llm);
    tier = 'inferred';
    why = 'inferred from company config, owner identity files, interview answers and the task text';
  }
  if (!label) return null;
  confirmTaskAudience(taskId, { audienceLabel: label, source: 'best_guess' });
  const dept = canonicalDeptSlug(task.department || task.workspace_id || '') || 'general';
  await rescore(taskId, `${task.title}${task.description ? `. ${task.description}` : ''}`.trim(), dept, label);
  try { run('UPDATE tasks SET audience_source = ?, audience_label = ? WHERE id = ?', ['best_guess', label, taskId]); } catch { /* pre-090 tolerant */ }
  try {
    run('INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), 'audience_best_guess', agentId, taskId,
        `Nobody answered "who will read this?" in time. Best guess: "${label}" (tier: ${tier}; ${why}).`, new Date().toISOString()]);
  } catch { /* audit best-effort */ }
  return { label, tier };
}

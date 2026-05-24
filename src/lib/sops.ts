/**
 * Hybrid SOP system helpers.
 *
 * Trevor confirmed (2026-05-24): `task.sop_id` (UUID) → row in `sops` table
 * with structured JSON steps. SOPs are the second leg of the Triad Rule
 * (Task + SOP + Persona) that gates non-backlog status transitions.
 */

import { queryAll, queryOne } from '@/lib/db';
import type { Task } from '@/lib/types';

export interface SOPStep {
  name: string;
  checklist?: string[];
  success_criteria?: string;
  persona_hint?: string;
}

export interface SOP {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  version: number;
  department?: string | null;
  task_keywords?: string | null;
  steps: string; // JSON-serialized SOPStep[]
  success_criteria?: string | null;
  persona_hints?: string | null; // JSON-serialized string[]
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SOPSuggestion {
  sop: SOP;
  score: number;
  reasons: string[];
}

/**
 * Validate that the `steps` value is a JSON array of SOPStep-shaped objects.
 * Returns the parsed array on success or throws with a clear message.
 */
export function parseAndValidateSteps(stepsRaw: unknown): SOPStep[] {
  let parsed: unknown;
  if (typeof stepsRaw === 'string') {
    try {
      parsed = JSON.parse(stepsRaw);
    } catch (err) {
      throw new Error(`steps must be valid JSON: ${(err as Error).message}`);
    }
  } else {
    parsed = stepsRaw;
  }

  if (!Array.isArray(parsed)) {
    throw new Error('steps must be a JSON array');
  }
  if (parsed.length === 0) {
    throw new Error('steps must contain at least one step');
  }

  const out: SOPStep[] = [];
  parsed.forEach((step, idx) => {
    if (typeof step !== 'object' || step === null) {
      throw new Error(`steps[${idx}] must be an object`);
    }
    const s = step as Record<string, unknown>;
    if (typeof s.name !== 'string' || !s.name.trim()) {
      throw new Error(`steps[${idx}].name is required`);
    }
    const checklist = s.checklist;
    if (checklist !== undefined && checklist !== null) {
      if (!Array.isArray(checklist) || !checklist.every((c) => typeof c === 'string')) {
        throw new Error(`steps[${idx}].checklist must be string[]`);
      }
    }
    if (s.success_criteria !== undefined && s.success_criteria !== null && typeof s.success_criteria !== 'string') {
      throw new Error(`steps[${idx}].success_criteria must be string`);
    }
    if (s.persona_hint !== undefined && s.persona_hint !== null && typeof s.persona_hint !== 'string') {
      throw new Error(`steps[${idx}].persona_hint must be string`);
    }
    out.push({
      name: s.name.trim(),
      checklist: Array.isArray(checklist) ? (checklist as string[]) : undefined,
      success_criteria: typeof s.success_criteria === 'string' ? s.success_criteria : undefined,
      persona_hint: typeof s.persona_hint === 'string' ? s.persona_hint : undefined,
    });
  });
  return out;
}

/**
 * Score a SOP against a task. Higher = better match.
 *
 *  - Department exact match: +0.5
 *  - Each keyword overlap with task title/description: +0.1 (cap 0.5)
 *
 * Range: 0 to ~1.0
 */
export function scoreSOPForTask(
  sop: Pick<SOP, 'department' | 'task_keywords'>,
  task: Pick<Task, 'title' | 'description'> & { department?: string | null; workspace_id?: string | null }
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const taskDept = (task.department || task.workspace_id || '').toLowerCase();
  if (sop.department && taskDept && sop.department.toLowerCase() === taskDept) {
    score += 0.5;
    reasons.push(`department match (${sop.department})`);
  }

  if (sop.task_keywords) {
    const keywords = sop.task_keywords
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    const haystack = `${task.title || ''} ${task.description || ''}`.toLowerCase();
    const hits = keywords.filter((k) => haystack.includes(k));
    if (hits.length > 0) {
      const kwScore = Math.min(0.5, hits.length * 0.1);
      score += kwScore;
      reasons.push(`keywords: ${hits.join(', ')}`);
    }
  }

  return { score, reasons };
}

/**
 * Return the top N SOP suggestions for a given task.
 * Excludes soft-deleted SOPs.
 */
export function suggestSOPsForTask(
  task: Pick<Task, 'title' | 'description'> & { department?: string | null; workspace_id?: string | null },
  limit = 3
): SOPSuggestion[] {
  const sops = queryAll<SOP>(
    `SELECT * FROM sops WHERE deleted_at IS NULL`,
    []
  );
  const scored = sops
    .map((sop) => {
      const { score, reasons } = scoreSOPForTask(sop, task);
      return { sop, score, reasons };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Returns the best SOP for a task only if the top match scores above the
 * threshold. Otherwise returns null (operator picks manually).
 */
export function getBestSOPForTask(
  task: Pick<Task, 'title' | 'description'> & { department?: string | null; workspace_id?: string | null },
  threshold = 0.5
): SOP | null {
  const suggestions = suggestSOPsForTask(task, 1);
  if (suggestions.length === 0) return null;
  if (suggestions[0].score < threshold) return null;
  return suggestions[0].sop;
}

/**
 * Sentinel values that should be treated as "no persona set" even if the
 * field is non-null. Earned from prior incidents where 'schemaVersion' and
 * similar harness leftovers ended up in persona_id.
 */
const PERSONA_SENTINELS = new Set([
  'schemaversion',
  'schema_version',
  'null',
  'none',
  'undefined',
  '',
]);

export function isValidPersonaId(personaId: string | null | undefined): boolean {
  if (!personaId) return false;
  return !PERSONA_SENTINELS.has(personaId.toLowerCase().trim());
}

/**
 * Triad Rule gate. Validates that a task has the three things required to
 * leave backlog: a real description, a non-deleted SOP, and a real persona.
 *
 * Returns the list of missing keys (empty = good to go).
 */
export interface TriadCheckInput {
  description?: string | null;
  sop_id?: string | null;
  persona_id?: string | null;
}

export function checkTriad(task: TriadCheckInput): { missing: string[] } {
  const missing: string[] = [];

  if (!task.description || !task.description.trim()) {
    missing.push('description');
  }

  if (!task.sop_id) {
    missing.push('sop_id');
  } else {
    const sop = queryOne<{ id: string; deleted_at: string | null }>(
      'SELECT id, deleted_at FROM sops WHERE id = ?',
      [task.sop_id]
    );
    if (!sop || sop.deleted_at) {
      missing.push('sop_id');
    }
  }

  if (!isValidPersonaId(task.persona_id)) {
    missing.push('persona_id');
  }

  return { missing };
}

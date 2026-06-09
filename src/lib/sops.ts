/**
 * Hybrid SOP system helpers.
 *
 * Trevor confirmed (2026-05-24): `task.sop_id` (UUID) → row in `sops` table
 * with structured JSON steps. SOPs are the second leg of the Triad Rule
 * (Task + SOP + Persona) that gates non-backlog status transitions.
 */

import { queryAll, queryOne } from '@/lib/db';
import type { Task } from '@/lib/types';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { isEmbeddingAvailable, rankSOPsBySemantic } from '@/lib/sop-embeddings';

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
  role?: string | null; // role-folder slug (NULL for department-level SOPs); migration 050
  source?: string | null; // 'role-library' for on-disk imports, NULL otherwise; migration 050
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
 *  - Department exact match (canonical): +0.5
 *  - Role match (sop.role === agentRoleSlug): +0.5 (Tier 2 item 7)
 *  - Each keyword overlap with task title/description: +0.1 (cap 0.5)
 *
 * Range: 0 to ~1.5
 */
export function scoreSOPForTask(
  sop: Pick<SOP, 'department' | 'task_keywords' | 'role'>,
  task: Pick<Task, 'title' | 'description'> & {
    department?: string | null;
    workspace_id?: string | null;
    /** Optional: the assigned agent's role slug. When supplied, sop.role matching adds +0.5. */
    agentRoleSlug?: string | null;
  }
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Use canonical slug normalization so "dept-marketing", "billing", "ceo-com"
  // etc. all match the canonical SOP department slug.
  const taskDeptRaw = task.department || task.workspace_id || '';
  const taskDeptCanon = canonicalDeptSlug(taskDeptRaw);
  const sopDeptCanon = canonicalDeptSlug(sop.department ?? '');
  if (sopDeptCanon && taskDeptCanon && sopDeptCanon === taskDeptCanon) {
    score += 0.5;
    reasons.push(`department match (${sopDeptCanon})`);
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

  // Tier 2 item 7: role-weighted SOP scoring.
  // When the SOP carries a role slug and it matches the assigned agent's role,
  // boost by +0.5 so specialist how-to wins over generic department SOPs.
  if (sop.role && task.agentRoleSlug) {
    const sopRoleNorm = sop.role.trim().toLowerCase();
    const agentRoleNorm = task.agentRoleSlug.trim().toLowerCase();
    if (sopRoleNorm && agentRoleNorm && (sopRoleNorm === agentRoleNorm || agentRoleNorm.includes(sopRoleNorm) || sopRoleNorm.includes(agentRoleNorm))) {
      score += 0.5;
      reasons.push(`role match (${sop.role})`);
    }
  }

  return { score, reasons };
}

/**
 * Return the top N SOP suggestions for a given task.
 * Excludes soft-deleted SOPs.
 */
/**
 * Return the top N SOP suggestions for a given task — keyword path only.
 *
 * This is the synchronous baseline that is always available. The async
 * `suggestSOPsForTask` extends it with semantic (embedding) ranking when a
 * key is configured. Both share this core implementation so the keyword path
 * is never silently bypassed.
 */
export function suggestSOPsForTaskKeyword(
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
 * Return the top N SOP suggestions for a given task.
 *
 * HYBRID MODE (when OPENAI_API_KEY is configured + embeddings exist):
 *   1. Compute cosine similarity between the task text and all stored SOP
 *      embeddings (brute-force JS, ~5ms over 2,578 rows).
 *   2. Blend with keyword score:
 *        blended = semantic_similarity * 0.7 + keyword_score_normalized * 0.3
 *      This lets a semantically similar SOP with zero keyword overlap still
 *      surface, while an exact-keyword + department match gets a boost.
 *   3. Include any keyword-only hits (score > 0) that the semantic pass
 *      might have ranked too low, so we never regress vs. the old path.
 *
 * FALLBACK (no key or no embeddings in DB):
 *   Identical to the previous pure-keyword path — zero behavior change.
 *
 * The function is async because embedding the query text requires a network
 * call to OpenAI. The fallback is synchronous-equivalent (Promise.resolve).
 */
export async function suggestSOPsForTask(
  task: Pick<Task, 'title' | 'description'> & { department?: string | null; workspace_id?: string | null },
  limit = 3
): Promise<SOPSuggestion[]> {
  // Always compute keyword scores — they're the guaranteed fallback.
  const sops = queryAll<SOP>(`SELECT * FROM sops WHERE deleted_at IS NULL`, []);
  const keywordMap = new Map<string, { score: number; reasons: string[] }>();
  for (const sop of sops) {
    const { score, reasons } = scoreSOPForTask(sop, task);
    keywordMap.set(sop.id, { score, reasons });
  }

  // Attempt semantic ranking.
  if (isEmbeddingAvailable()) {
    const queryText = `${task.title ?? ''} ${task.description ?? ''}`.trim();
    if (queryText.length > 0) {
      const semanticHits = await rankSOPsBySemantic(queryText);

      if (semanticHits.length > 0) {
        // Build a fast lookup: sopId → semantic rank position (0-based) + similarity
        const semanticMap = new Map<string, number>();
        for (const hit of semanticHits) {
          semanticMap.set(hit.sopId, hit.similarity);
        }

        // Max keyword score for normalization (avoid div-by-zero)
        const maxKw = Math.max(...Array.from(keywordMap.values()).map((v) => v.score), 0.001);

        const blended: SOPSuggestion[] = sops.map((sop) => {
          const kw = keywordMap.get(sop.id) ?? { score: 0, reasons: [] };
          const sem = semanticMap.get(sop.id) ?? 0;
          // Map cosine similarity [-1,1] → [0,1]; then weight 70% semantic, 30% keyword
          const semNorm = (sem + 1) / 2;
          const kwNorm = kw.score / maxKw;
          const blendedScore = semNorm * 0.7 + kwNorm * 0.3;
          const reasons = [...kw.reasons];
          if (sem > 0.3) {
            reasons.push(`semantic similarity ${sem.toFixed(3)}`);
          }
          return { sop, score: blendedScore, reasons };
        });

        // Include everything with either a meaningful semantic signal or a keyword hit.
        // Threshold: semantic contribution > 0.35 (roughly cosine > 0) OR any keyword match.
        const filtered = blended.filter(
          (s) => s.score > 0.35 || (keywordMap.get(s.sop.id)?.score ?? 0) > 0
        );
        filtered.sort((a, b) => b.score - a.score);
        return filtered.slice(0, limit);
      }
    }
  }

  // Pure keyword fallback — identical to the old synchronous path.
  const kwResults = sops
    .map((sop) => {
      const { score, reasons } = keywordMap.get(sop.id)
        ? { ...keywordMap.get(sop.id)! }
        : scoreSOPForTask(sop, task);
      return { sop, score, reasons };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return kwResults.slice(0, limit);
}

/**
 * Returns the best SOP for a task only if the top match scores above the
 * threshold. Otherwise returns null (operator picks manually).
 */
export async function getBestSOPForTask(
  task: Pick<Task, 'title' | 'description'> & { department?: string | null; workspace_id?: string | null },
  threshold = 0.5
): Promise<SOP | null> {
  const suggestions = await suggestSOPsForTask(task, 1);
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

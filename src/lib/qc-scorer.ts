/**
 * QC Agent Auto-Scorer
 *
 * Scores a completed task against the assigned SOP's success_criteria using a
 * 1–10 rubric. Called automatically when a task transitions to `review` status.
 *
 * Gate: ≥8.5 → auto-approve (mark done); <8.5 → kick back to in_progress with
 * specific gap notes as a task event.
 *
 * Per-department QC: the scorer resolves the ITEM'S OWN department QC agent
 * (role_type='qc', workspace_id = task's workspace) and uses that agent's
 * model (if set) and identity in the scoring prompt and event log. This ensures
 * that the Marketing QC Specialist scores marketing tasks, the Sales QC
 * Specialist scores sales tasks, etc. — as defined by the onboarding role
 * library (one QC specialist per department).
 *
 * Scoring paths:
 *   1. LLM-backed (primary): uses OPENAI_API_KEY / GOOGLE_API_KEY to call the
 *      configured model and score the work against success_criteria.
 *      Model selection: dept QC agent's model field → QC_SCORER_MODEL env →
 *      TIEBREAK_MODEL env → gpt-4o-mini (OpenAI) or gemini-flash (Google).
 *   2. Heuristic fallback (no API key / LLM error): structural checks on the
 *      deliverable meta (description non-empty, SOP assigned, persona assigned,
 *      title non-trivial). Returns a conservative score in [6.0, 8.0].
 *
 * The QC event is always written to the `events` table regardless of pass/fail
 * so the board + agent can see the reasoning.
 *
 * Auto-approval is BEST-EFFORT: any scoring error → leave the task in review
 * (human decides) and log a warning. Never crashes the PATCH route.
 */

import { queryOne, queryAll, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum score (inclusive) to auto-approve. Matches the ≥8.5 gate. */
export const QC_PASS_THRESHOLD = 8.5;

/** Disable the whole QC-agent auto-scorer by setting this env to "1". */
const DISABLE_QC_SCORER =
  process.env.DISABLE_QC_AUTO_SCORER === '1' ||
  process.env.DISABLE_QC_AUTO_SCORER === 'true';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QCScorerInput {
  taskId: string;
  taskTitle: string;
  taskDescription: string | null;
  sopSuccessCriteria: string | null;
  sopName: string | null;
  sopSteps: string | null; // JSON stringified steps array from sops table
  departmentSlug: string | null;
  /** Per-department QC agent resolved for this task (null = use global scorer) */
  qcAgentId?: string | null;
  qcAgentName?: string | null;
  qcAgentModel?: string | null;
}

export interface QCResult {
  score: number; // 1.0–10.0
  pass: boolean; // score >= QC_PASS_THRESHOLD
  reason: string; // human-readable explanation (shown in event)
  gaps: string[]; // specific gaps when !pass
  scoringPath: 'llm' | 'heuristic' | 'no-criteria'; // which path was used
}

// ---------------------------------------------------------------------------
// Heuristic scorer (fallback when no API key available)
// ---------------------------------------------------------------------------

/**
 * Score the task using only structural heuristics — no API call needed.
 * Returns a score in [6.0, 8.0] so it never auto-passes (≥8.5 gate).
 * The human reviewer always sees the score and can manually promote.
 */
function heuristicScore(input: QCScorerInput): QCResult {
  const gaps: string[] = [];
  let score = 8.0;

  // Check 1: Description exists and is non-trivial
  if (!input.taskDescription || input.taskDescription.trim().length < 20) {
    gaps.push('Task description is missing or too brief to verify completion');
    score -= 1.0;
  }

  // Check 2: SOP was assigned
  if (!input.sopSuccessCriteria && !input.sopSteps) {
    gaps.push('No SOP assigned — completion criteria cannot be verified');
    score -= 0.5;
  }

  // Check 3: Title is non-trivial
  if (input.taskTitle.trim().length < 5 || /^(test|todo|task|new task)$/i.test(input.taskTitle.trim())) {
    gaps.push('Task title is generic — deliverable scope unclear');
    score -= 0.5;
  }

  // Clamp to [6.0, 8.0] — heuristic path never auto-passes
  score = Math.max(6.0, Math.min(8.0, score));

  return {
    score,
    pass: false, // heuristic path never auto-passes
    reason: `Heuristic QC (no LLM API key configured). Score: ${score.toFixed(1)}/10. Human review required.`,
    gaps,
    scoringPath: 'heuristic',
  };
}

// ---------------------------------------------------------------------------
// LLM scorer (primary path)
// ---------------------------------------------------------------------------

/**
 * Build the QC scoring prompt.
 * Returns a structured prompt that asks the model to rate 1–10 and list gaps.
 * When a per-department QC agent is available, its identity is used as the
 * QC persona so the model scores from that specialist's perspective.
 */
function buildQCPrompt(input: QCScorerInput): string {
  const sopSection = input.sopSuccessCriteria
    ? `**SOP Success Criteria:**\n${input.sopSuccessCriteria}`
    : input.sopSteps
    ? `**SOP Steps (no explicit success_criteria defined):**\n${input.sopSteps}`
    : '**No SOP success criteria available — score based on task description completeness only.**';

  const agentIdentity = input.qcAgentName
    ? `You are ${input.qcAgentName}, the QC Specialist for the ${input.departmentSlug ?? 'General'} department.`
    : `You are a QC agent scoring a completed task for the ${input.departmentSlug ?? 'General'} department.`;

  return `${agentIdentity}

**Task Title:** ${input.taskTitle}
**Task Description / Deliverable Notes:**
${input.taskDescription ?? '(no description provided)'}

${sopSection}

**Instructions:**
Score this task on a scale of 1–10 based on how completely the task description + deliverable notes satisfy the SOP success criteria.

Rubric:
- 9–10: All criteria clearly met, deliverable is complete and verifiable.
- 8–8.9: Most criteria met, minor polish needed but no blocking gaps.
- 7–7.9: Some criteria met but 1–2 notable gaps that should be addressed.
- 5–6.9: Significant gaps — 2+ criteria unmet or deliverable unclear.
- 1–4.9: Does not meet criteria / incomplete / cannot verify.

**Gate:** ≥8.5 = PASS (auto-approve), <8.5 = RETURN (kick back for rework).

Reply in this EXACT JSON format (no other text):
{
  "score": <number 1.0–10.0>,
  "pass": <boolean>,
  "reason": "<1–2 sentence summary>",
  "gaps": ["<specific gap 1>", "<specific gap 2>"]
}

If score ≥8.5, "gaps" should be [] or contain only minor polish notes.
If score <8.5, "gaps" must list specific, actionable rework items.`;
}

/**
 * Call the LLM API to score the task.
 * Returns null on any error (caller falls back to heuristic).
 * @param modelOverride - Per-dept QC agent's model field (beats env vars)
 */
async function llmScoreViaOpenAI(
  prompt: string,
  apiKey: string,
  modelOverride?: string | null,
): Promise<QCResult | null> {
  try {
    const model = modelOverride || process.env.QC_SCORER_MODEL || process.env.TIEBREAK_MODEL || 'gpt-4o-mini';
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a precise QC agent. Reply only with valid JSON.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
        temperature: 0,
      }),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) return null;

    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned) as {
      score: number;
      pass: boolean;
      reason: string;
      gaps: string[];
    };

    const score = typeof parsed.score === 'number' ? Math.max(1, Math.min(10, parsed.score)) : 5;
    return {
      score,
      pass: score >= QC_PASS_THRESHOLD,
      reason: typeof parsed.reason === 'string' ? parsed.reason : `Score: ${score.toFixed(1)}/10`,
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter((g) => typeof g === 'string') : [],
      scoringPath: 'llm',
    };
  } catch (err) {
    console.warn('[QCScorer] OpenAI scoring failed:', (err as Error).message);
    return null;
  }
}

/**
 * Call the Google Gemini API to score the task.
 * Returns null on any error.
 * @param modelOverride - Per-dept QC agent's model field (beats env vars)
 */
async function llmScoreViaGoogle(
  prompt: string,
  apiKey: string,
  modelOverride?: string | null,
): Promise<QCResult | null> {
  try {
    const model = modelOverride || process.env.QC_SCORER_MODEL || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 300 },
      }),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    if (!raw) return null;

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned) as {
      score: number;
      pass: boolean;
      reason: string;
      gaps: string[];
    };

    const score = typeof parsed.score === 'number' ? Math.max(1, Math.min(10, parsed.score)) : 5;
    return {
      score,
      pass: score >= QC_PASS_THRESHOLD,
      reason: typeof parsed.reason === 'string' ? parsed.reason : `Score: ${score.toFixed(1)}/10`,
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter((g) => typeof g === 'string') : [],
      scoringPath: 'llm',
    };
  } catch (err) {
    console.warn('[QCScorer] Google scoring failed:', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main scorer
// ---------------------------------------------------------------------------

/**
 * Score a task for QC auto-approval.
 *
 * Resolution order for LLM:
 *   1. OPENAI_API_KEY → OpenAI gpt-4o-mini (or QC_SCORER_MODEL)
 *   2. GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY → Gemini flash
 *   3. No key → heuristic fallback
 *
 * Falls back to heuristic on any LLM error (never throws).
 */
export async function scoreTaskForQC(input: QCScorerInput): Promise<QCResult> {
  // If no SOP success criteria and no SOP steps — score based on structure only.
  if (!input.sopSuccessCriteria && !input.sopSteps) {
    return {
      score: 7.5,
      pass: false,
      reason: 'No SOP assigned to this task — cannot auto-score against success criteria. Routing to human review.',
      gaps: ['Assign an SOP with success_criteria before auto-scoring is possible.'],
      scoringPath: 'no-criteria',
    };
  }

  const prompt = buildQCPrompt(input);

  // Model selection: per-dept QC agent's model field beats env vars.
  // Only use the agent's model when it looks like an OpenAI model id
  // (starts with 'gpt-' or 'o1' etc.) for the OpenAI path; otherwise
  // let the env-var defaults handle provider routing.
  const agentModel = input.qcAgentModel || null;

  // Try LLM paths
  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) {
    const result = await llmScoreViaOpenAI(prompt, openAiKey, agentModel);
    if (result) return result;
  }

  const googleKey =
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GEMINI_API_KEY;
  if (googleKey) {
    const result = await llmScoreViaGoogle(prompt, googleKey, agentModel);
    if (result) return result;
  }

  // Fallback: heuristic
  return heuristicScore(input);
}

// ---------------------------------------------------------------------------
// Integration: run QC and write result to events table
// ---------------------------------------------------------------------------

interface TaskRowForQC {
  id: string;
  title: string;
  description: string | null;
  sop_id: string | null;
  department: string | null;
  workspace_id: string | null;
  assigned_agent_id: string | null;
  status: string;
}

interface SOPRowForQC {
  id: string;
  name: string;
  success_criteria: string | null;
  steps: string | null; // JSON
  department: string | null;
}

interface QCAgentRow {
  id: string;
  name: string;
  model: string | null;
}

/**
 * Resolve the per-department QC agent for a given task.
 *
 * Lookup order (name-agnostic — works for master-orchestrator, general-task,
 * and all 23 operational depts):
 *   1. agents WHERE workspace_id = task.workspace_id AND role_type = 'qc'
 *   2. agents WHERE workspace_id = canonicalSlug(task.department) AND role_type = 'qc'
 *   3. null (heuristic fallback — no QC agent seeded yet)
 *
 * Returns null when role_type column doesn't exist yet (pre-migration-060
 * database) so the heuristic fallback stays active with zero breakage.
 */
function resolveQCAgent(task: TaskRowForQC): QCAgentRow | null {
  try {
    // Check if role_type column exists (guard for pre-migration-060 DBs)
    const cols = queryAll<{ name: string }>('PRAGMA table_info(agents)', []);
    const hasRoleType = cols.some((c) => c.name === 'role_type');
    if (!hasRoleType) return null;

    // 1. Direct workspace_id match
    if (task.workspace_id) {
      const agent = queryOne<QCAgentRow>(
        "SELECT id, name, model FROM agents WHERE workspace_id = ? AND role_type = 'qc' LIMIT 1",
        [task.workspace_id],
      );
      if (agent) return agent;
    }

    // 2. Canonical slug match via task.department
    if (task.department) {
      const canonical = canonicalDeptSlug(task.department);
      // Try workspace id = canonical slug (post-migration-051 layout)
      const agent = queryOne<QCAgentRow>(
        "SELECT id, name, model FROM agents WHERE lower(workspace_id) = ? AND role_type = 'qc' LIMIT 1",
        [canonical],
      );
      if (agent) return agent;
    }

    return null;
  } catch {
    // Any error (missing table, missing column) → no QC agent, use heuristic
    return null;
  }
}

/**
 * Run QC scoring for a task that just entered `review` status.
 *
 * Per-department: resolves the task's OWN department QC agent (role_type='qc')
 * and uses that agent's persona and model for the scoring LLM call + event.
 * Falls back to heuristic when no QC agent is found or no API key is set.
 *
 * Side effects:
 *   - Writes a `qc_review` event to the events table (always), including the
 *     QC agent's name when resolved (audit trail shows WHICH specialist scored)
 *   - If PASS: moves task to `done` (writes another `task_completed` event)
 *   - If FAIL: moves task back to `in_progress` with gap notes
 *
 * BEST-EFFORT: any error is logged; the task stays in `review` if we can't score.
 * Designed to be called fire-and-forget after the PATCH route responds.
 *
 * @returns QCResult | null (null = QC was disabled or errored)
 */
export async function runQCOnReview(taskId: string): Promise<QCResult | null> {
  if (DISABLE_QC_SCORER) {
    console.log('[QCScorer] DISABLE_QC_AUTO_SCORER is set, skipping auto-QC');
    return null;
  }

  try {
    const task = queryOne<TaskRowForQC>(
      'SELECT id, title, description, sop_id, department, workspace_id, assigned_agent_id, status FROM tasks WHERE id = ?',
      [taskId],
    );

    if (!task) {
      console.warn(`[QCScorer] Task ${taskId} not found — cannot QC`);
      return null;
    }

    // Only QC tasks in review status
    if (task.status !== 'review') {
      console.log(`[QCScorer] Task ${taskId} is not in review (status: ${task.status}) — skipping`);
      return null;
    }

    // Resolve per-department QC agent (name-agnostic, canonical-slug-safe)
    const qcAgent = resolveQCAgent(task);
    if (qcAgent) {
      console.log(`[QCScorer] Resolved QC agent: "${qcAgent.name}" (id: ${qcAgent.id}) for task "${task.title}"`);
    } else {
      console.log(`[QCScorer] No dept QC agent found for task "${task.title}" — using global heuristic fallback`);
    }

    // Fetch SOP if assigned
    let sopRow: SOPRowForQC | null = null;
    if (task.sop_id) {
      sopRow = queryOne<SOPRowForQC>(
        'SELECT id, name, success_criteria, steps, department FROM sops WHERE id = ? AND deleted_at IS NULL',
        [task.sop_id],
      ) ?? null;
    }

    const input: QCScorerInput = {
      taskId: task.id,
      taskTitle: task.title,
      taskDescription: task.description,
      sopSuccessCriteria: sopRow?.success_criteria ?? null,
      sopName: sopRow?.name ?? null,
      sopSteps: sopRow?.steps ?? null,
      departmentSlug: task.department ?? task.workspace_id ?? null,
      // Per-dept QC agent fields (null when no agent resolved)
      qcAgentId: qcAgent?.id ?? null,
      qcAgentName: qcAgent?.name ?? null,
      qcAgentModel: qcAgent?.model ?? null,
    };

    const result = await scoreTaskForQC(input);
    const now = new Date().toISOString();

    // Write QC event — include QC agent identity so audit trail shows who scored
    const scoredBy = qcAgent ? ` [scorer:${qcAgent.name}]` : ' [scorer:global-heuristic]';
    const gapNote = result.gaps.length > 0 ? ` Gaps: ${result.gaps.join('; ')}` : '';
    const eventMessage =
      `[QC-AUTO] Score: ${result.score.toFixed(1)}/10 | ${result.pass ? 'PASS → moved to Done' : 'FAIL → returned to In Progress'} | ${result.reason}${gapNote} [path:${result.scoringPath}]${scoredBy}`;

    run(
      `INSERT INTO events (id, type, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'qc_review', taskId, eventMessage, now],
    );

    if (result.pass) {
      // Auto-approve: move to done
      run(
        `UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ? AND status = 'review'`,
        [now, taskId],
      );
      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'task_completed', taskId, `[QC-AUTO] Task "${task.title}" auto-approved (score ${result.score.toFixed(1)}/10 ≥ ${QC_PASS_THRESHOLD})`, now],
      );
      console.log(`[QCScorer] Task "${task.title}" (${taskId}): PASS ${result.score.toFixed(1)}/10 → done`);
    } else {
      // Kick back: return to in_progress with gap note
      const kickbackNote = result.gaps.length > 0
        ? `[QC-FAIL] Score ${result.score.toFixed(1)}/10. Rework needed: ${result.gaps.join('; ')}`
        : `[QC-FAIL] Score ${result.score.toFixed(1)}/10. ${result.reason}`;

      run(
        `UPDATE tasks SET status = 'in_progress', description = CASE
           WHEN description IS NULL OR description = '' THEN ?
           ELSE description || char(10) || char(10) || ?
         END, updated_at = ? WHERE id = ? AND status = 'review'`,
        [kickbackNote, kickbackNote, now, taskId],
      );
      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'task_status_changed', taskId, `[QC-AUTO] Task "${task.title}" returned to In Progress — score ${result.score.toFixed(1)}/10 < ${QC_PASS_THRESHOLD}. ${result.reason}`, now],
      );
      console.log(`[QCScorer] Task "${task.title}" (${taskId}): FAIL ${result.score.toFixed(1)}/10 → in_progress`);
    }

    return result;
  } catch (err) {
    console.error('[QCScorer] Auto-QC errored — leaving task in review for human review:', (err as Error).message);
    return null;
  }
}

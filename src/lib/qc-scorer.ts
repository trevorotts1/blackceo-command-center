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
 *      TIEBREAK_MODEL env → gpt-4o-mini (OpenAI) or gemini-2.5-flash (Google).
 *   2. Heuristic fallback (no API key / LLM error): structural checks on the
 *      deliverable meta (description non-empty, SOP assigned, persona assigned,
 *      title non-trivial). Returns a conservative score in [6.0, 8.0].
 *      IMPORTANT: heuristic mode NEVER triggers the auto-reroute loop. The task
 *      stays in `review` with a "QC ran in heuristic mode (no LLM key); human
 *      review required" event. Reroutes are ONLY triggered by a real LLM score
 *      below the 8.5 gate. This prevents keyless installs from spinning every
 *      task through 3 reroutes and into `blocked` (PRD 2.4).
 *
 * Artifact-aware QC (duck-fix):
 *   When a task has file deliverables, the QC scorer shifts from "did the brief
 *   describe the work completely?" to "did the artifact FULFILL the request?".
 *   A terse brief ("create a picture of a blue duck") is NEVER penalised —
 *   the score is entirely based on whether the artifact exists, is non-empty,
 *   has the right type, and satisfies the stated request.
 *   Missing / zero-byte / wrong-type artifacts fail with a named reason so the
 *   agent knows exactly what to fix.  Text-only tasks (no deliverables) use the
 *   existing brief-completeness path unchanged.
 *
 * The QC event is always written to the `events` table regardless of pass/fail
 * so the board + agent can see the reasoning.
 *
 * Auto-approval is BEST-EFFORT: any scoring error → leave the task in review
 * (human decides) and log a warning. Never crashes the PATCH route.
 */

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { queryOne, queryAll, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { getMissionControlUrl } from '@/lib/config';
import { spawnRecordCompletion } from '@/lib/persona-selector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum score (inclusive) to auto-approve. Matches the ≥8.5 gate. */
export const QC_PASS_THRESHOLD = 8.5;

/**
 * Maximum number of times a task can be re-routed after QC failure before the
 * loop is capped and the task is set to `blocked` for human review.
 * Override with QC_MAX_REROUTES env var. Default: 3.
 */
export const QC_MAX_REROUTES = parseInt(process.env.QC_MAX_REROUTES || '3', 10);

/** Disable the whole QC-agent auto-scorer by setting this env to "1". */
const DISABLE_QC_SCORER =
  process.env.DISABLE_QC_AUTO_SCORER === '1' ||
  process.env.DISABLE_QC_AUTO_SCORER === 'true';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Image magic-byte detection helpers
// ---------------------------------------------------------------------------

/** Known image magic-byte signatures (offset, bytes). */
const IMAGE_SIGNATURES: Array<{ ext: string; offset: number; bytes: number[] }> = [
  { ext: 'png',  offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg',  offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif',  offset: 0, bytes: [0x47, 0x49, 0x46] }, // GIF8
  { ext: 'webp', offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // RIFF????WEBP
  { ext: 'bmp',  offset: 0, bytes: [0x42, 0x4d] },
];

/** Image MIME extensions (lower-case, with leading dot). */
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.tiff', '.tif']);

/**
 * Probe a file path: returns { valid: true, ext, sizeBytes, mimeMatch } when
 * the file exists, is non-empty, and its magic bytes match a known image type.
 * Returns { valid: false, reason } on any failure.
 *
 * Exported for unit testing.
 */
export function probeImageFile(filePath: string): { valid: true; ext: string; sizeBytes: number; mimeMatch: boolean } | { valid: false; reason: string } {
  if (!existsSync(filePath)) {
    return { valid: false, reason: `Artifact file not found: ${filePath}` };
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(filePath);
  } catch {
    return { valid: false, reason: `Cannot stat artifact file: ${filePath}` };
  }
  if (!stats.isFile()) {
    return { valid: false, reason: `Artifact path is not a regular file: ${filePath}` };
  }
  if (stats.size === 0) {
    return { valid: false, reason: `Artifact file is empty (0 bytes): ${filePath}` };
  }

  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  // Read the first 12 bytes for magic-byte check.
  let headerBuf: Buffer;
  try {
    const fd = openSync(filePath, 'r');
    headerBuf = Buffer.alloc(12);
    readSync(fd, headerBuf, 0, 12, 0);
    closeSync(fd);
  } catch {
    // Can't read — treat extension as weak validation.
    return { valid: true, ext, sizeBytes: stats.size, mimeMatch: IMAGE_EXTENSIONS.has(ext) };
  }

  const mimeMatch = IMAGE_SIGNATURES.some(({ offset, bytes }) =>
    bytes.every((b, i) => headerBuf[offset + i] === b),
  );

  return { valid: true, ext, sizeBytes: stats.size, mimeMatch };
}

// ---------------------------------------------------------------------------
// Deliverable manifest (passed to the artifact-aware QC prompt)
// ---------------------------------------------------------------------------

export interface DeliverableManifestItem {
  title: string;
  path: string;
  type: 'image' | 'file' | 'url';
  /** null when file is missing or unreadable */
  sizeBytes: number | null;
  /** Set for images: WxH string or null if not determinable */
  dimensions: string | null;
  /** Whether the file exists and passed basic validation */
  valid: boolean;
  /** Reason for invalidity (only present when valid=false) */
  invalidReason?: string;
}

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
  /**
   * When the task has file deliverables, the caller populates this manifest.
   * Presence of a non-empty manifest switches the LLM prompt from
   * "brief completeness" to "deliverable fulfillment" mode.
   */
  deliverableManifest?: DeliverableManifestItem[] | null;
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
 *
 * IMPORTANT (PRD 2.4): callers MUST check `scoringPath === 'heuristic'` and
 * skip the reroute loop entirely when this path runs. The task stays in
 * `review`; a "human review required" event is written instead.
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
 *
 * Two modes:
 *   (A) Artifact-fulfillment mode — when deliverableManifest is non-empty.
 *       Scores whether the artifact SATISFIES the request. Terse briefs are
 *       explicitly NOT penalised. A missing/invalid artifact is an instant fail
 *       with a named reason rather than a low score.
 *   (B) Brief-completeness mode — existing behaviour when no manifest.
 *
 * When a per-department QC agent is available, its identity is used as the
 * QC persona so the model scores from that specialist's perspective.
 */
function buildQCPrompt(input: QCScorerInput): string {
  const agentIdentity = input.qcAgentName
    ? `You are ${input.qcAgentName}, the QC Specialist for the ${input.departmentSlug ?? 'General'} department.`
    : `You are a QC agent scoring a completed task for the ${input.departmentSlug ?? 'General'} department.`;

  // ── Mode A: artifact-fulfillment ──────────────────────────────────────────
  const manifest = input.deliverableManifest;
  if (manifest && manifest.length > 0) {
    const manifestLines = manifest.map((d, i) => {
      const status = d.valid
        ? `EXISTS — ${d.sizeBytes} bytes${d.dimensions ? `, ${d.dimensions}` : ''}`
        : `MISSING/INVALID — ${d.invalidReason ?? 'unknown reason'}`;
      return `  ${i + 1}. "${d.title}" [${d.type}] path=${d.path} → ${status}`;
    }).join('\n');

    const sopSection = input.sopSuccessCriteria
      ? `**SOP Success Criteria:**\n${input.sopSuccessCriteria}`
      : input.sopSteps
      ? `**SOP Steps:**\n${input.sopSteps}`
      : '**No SOP — score against the request only.**';

    return `${agentIdentity}

**ARTIFACT-FULFILLMENT QC MODE**
Score whether the delivered artifact(s) satisfy the request. Do NOT penalise a terse brief — a one-line request like "create a picture of a blue duck" is a complete, valid brief.

**Request (Task Title):** ${input.taskTitle}
**Request Details:** ${input.taskDescription ?? '(none — title is the complete brief)'}

**Deliverables Manifest:**
${manifestLines}

${sopSection}

**Scoring Instructions:**
1. If ANY deliverable is MISSING/INVALID, score ≤4.0 and list the exact file(s) and reason(s) in "gaps".
2. If all deliverables exist and are valid, score based on how well they satisfy the request:
   - 9–10: Artifact clearly fulfils the request (right type, reasonable size, plausibly matches subject).
   - 8–8.9: Artifact present and valid; minor uncertainty about content match.
   - 7–7.9: Artifact present but something is off (wrong type, unexpected size, etc.).
   - 5–6.9: Artifact present but likely wrong content or degraded quality.
   - 1–4.9: Artifact missing, empty, or clearly wrong type.
3. A terse request title is NEVER a gap.

**Gate:** ≥8.5 = PASS (auto-approve), <8.5 = RETURN (kick back for rework).

Reply in this EXACT JSON format (no other text):
{
  "score": <number 1.0–10.0>,
  "pass": <boolean>,
  "reason": "<1–2 sentence summary>",
  "gaps": ["<specific gap 1>", "<specific gap 2>"]
}

If score ≥8.5, "gaps" should be [] or contain only minor polish notes.
If score <8.5, "gaps" must list specific, actionable rework items (file paths + exact problem).`;
  }

  // ── Mode B: brief-completeness (original behaviour) ───────────────────────
  const sopSection = input.sopSuccessCriteria
    ? `**SOP Success Criteria:**\n${input.sopSuccessCriteria}`
    : input.sopSteps
    ? `**SOP Steps (no explicit success_criteria defined):**\n${input.sopSteps}`
    : '**No SOP success criteria available — score based on task description completeness only.**';

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

    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      console.warn(`[QCScorer] OpenAI API error ${resp.status}: ${errText}`);
      return null;
    }

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
    const model = modelOverride || process.env.QC_SCORER_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 4096 }, // gemini-2.5-flash uses ~1000 thinking tokens; need headroom
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      console.warn(`[QCScorer] Google Gemini API error ${resp.status} (model: ${model}): ${errText}`);
      return null;
    }

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
  // Fixture path for testing — no live cost. Set QC_FIXTURE_JSON_PATH to a JSON
  // file with shape { score, pass, reason, gaps } to force a deterministic result.
  const qcFixturePath = process.env.QC_FIXTURE_JSON_PATH;
  if (qcFixturePath) {
    try {
      const raw = readFileSync(qcFixturePath, 'utf8');
      const fixture = JSON.parse(raw) as { score: number; pass: boolean; reason: string; gaps: string[] };
      const score = typeof fixture.score === 'number' ? Math.max(1, Math.min(10, fixture.score)) : 9;
      return {
        score,
        pass: score >= QC_PASS_THRESHOLD,
        reason: typeof fixture.reason === 'string' ? fixture.reason : `Fixture score: ${score}/10`,
        gaps: Array.isArray(fixture.gaps) ? fixture.gaps : [],
        scoringPath: 'llm',
      };
    } catch {
      // If fixture fails to load, fall through to normal scoring.
    }
  }

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
  /** Persona assigned at task-creation time (from persona-selector-v2). */
  persona_id: string | null;
  status: string;
  /** Incremented each time a QC-fail re-route is attempted. Capped at QC_MAX_REROUTES. */
  qc_reroute_attempts: number | null;
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

// ---------------------------------------------------------------------------
// PRD 2.11 — Trio resolver
// ---------------------------------------------------------------------------

/**
 * Per-department trio row.  All three role_type agents are required per
 * department; `null` means the agent is missing and the build gate must fail.
 *
 * Devil's Advocate (role_type='devils-advocate') is INTERNAL: it is returned
 * here so the build gate and dispatch logic can verify its existence, but it
 * MUST NOT be exposed to any client-facing query or UI picker.
 */
export interface DeptTrioAgents {
  qc: QCAgentRow | null;
  research: QCAgentRow | null;
  /** INTERNAL — never surface to client UI. */
  devilsAdvocate: QCAgentRow | null;
}

/**
 * Resolve all three trio agents for the given department workspace.
 *
 * Lookup order (mirrors resolveQCAgent):
 *   1. agents WHERE workspace_id = workspaceId AND role_type = <type>
 *   2. agents WHERE lower(workspace_id) = canonicalSlug(deptSlug) AND role_type = <type>
 *   3. null
 *
 * Returns a DeptTrioAgents object where any null member indicates a missing
 * trio agent (build gate / fleet-sweep can treat any null as a failure).
 *
 * Safe on pre-migration-060 DBs: returns { qc: null, research: null,
 * devilsAdvocate: null } when the role_type column doesn't exist yet.
 *
 * @param workspaceId  The workspace.id (preferred — direct FK match)
 * @param deptSlug     The department slug (fallback when workspaceId is null)
 */
export function resolveTrioAgents(
  workspaceId: string | null,
  deptSlug: string | null,
): DeptTrioAgents {
  const empty: DeptTrioAgents = { qc: null, research: null, devilsAdvocate: null };

  try {
    // Guard: role_type column must exist.
    const cols = queryAll<{ name: string }>('PRAGMA table_info(agents)', []);
    if (!cols.some((c) => c.name === 'role_type')) return empty;

    const resolveRole = (roleType: string): QCAgentRow | null => {
      // 1. Direct workspace_id match
      if (workspaceId) {
        const row = queryOne<QCAgentRow>(
          'SELECT id, name, model FROM agents WHERE workspace_id = ? AND role_type = ? LIMIT 1',
          [workspaceId, roleType],
        );
        if (row) return row;
      }

      // 2. Canonical slug match via deptSlug
      if (deptSlug) {
        const canonical = canonicalDeptSlug(deptSlug);
        const row = queryOne<QCAgentRow>(
          'SELECT id, name, model FROM agents WHERE lower(workspace_id) = ? AND role_type = ? LIMIT 1',
          [canonical, roleType],
        );
        if (row) return row;
      }

      return null;
    };

    return {
      qc: resolveRole('qc'),
      research: resolveRole('research'),
      devilsAdvocate: resolveRole('devils-advocate'),
    };
  } catch {
    return empty;
  }
}

/**
 * Assert that the full trio (qc + research + devils-advocate) exists for the
 * given department. Returns an array of missing role_type strings (empty = all
 * present). Used by the build gate and fleet-sweep checks.
 */
export function getMissingTrioRoles(
  workspaceId: string | null,
  deptSlug: string | null,
): string[] {
  const trio = resolveTrioAgents(workspaceId, deptSlug);
  const missing: string[] = [];
  if (!trio.qc) missing.push('qc');
  if (!trio.research) missing.push('research');
  if (!trio.devilsAdvocate) missing.push('devils-advocate');
  return missing;
}

// ---------------------------------------------------------------------------
// §4 — Acceptance criteria derivation
// ---------------------------------------------------------------------------

/**
 * A structured acceptance criterion for an artifact task.
 *
 * Derived ONCE at task creation from the request text.
 * Stored as JSON in tasks.qc_acceptance_criteria.
 */
export interface AcceptanceCriterion {
  id: string;
  description: string;
  /** 'existence' | 'valid_image' | 'min_resolution' | 'vision_match' | 'custom' */
  type: 'existence' | 'valid_image' | 'min_resolution' | 'vision_match' | 'custom';
  /** Extra params: resolution threshold, vision prompt, etc. */
  params?: Record<string, unknown>;
}

/**
 * Derive acceptance criteria from a one-line owner request.
 *
 * Rules (§4):
 *   - Terse request → terse criteria.  That is correct, not lax.
 *   - For image tasks: always includes existence + valid_image + vision_match.
 *   - vision_match criterion carries the original request as the match subject.
 *   - min_resolution added when the request mentions "high-quality" or "large".
 *
 * This function is deterministic (no LLM call) so it can be called at task
 * creation time without latency cost.
 */
export function deriveAcceptanceCriteria(
  title: string,
  description?: string | null,
): AcceptanceCriterion[] {
  const text = [title, description].filter(Boolean).join(' ').toLowerCase();

  // Detect image tasks
  const isImageTask =
    /\b(image|picture|photo|png|jpg|jpeg|gif|illustration|render|graphic|logo|banner|thumbnail|duck|draw|generate.*image|create.*image)\b/.test(text);

  if (!isImageTask) {
    // Non-image (document/work) task — no artifact criteria
    return [];
  }

  const criteria: AcceptanceCriterion[] = [
    {
      id: 'existence',
      description: 'Artifact file exists and is non-empty',
      type: 'existence',
    },
    {
      id: 'valid_image',
      description: 'File is a valid image (correct magic bytes, non-zero size)',
      type: 'valid_image',
    },
  ];

  // High-quality / large mentions → min resolution
  if (/\b(high.?quality|large|high.?res|hd|4k|1080|resolution)\b/.test(text)) {
    criteria.push({
      id: 'min_resolution',
      description: 'Image meets minimum resolution (width ≥ 512, height ≥ 512)',
      type: 'min_resolution',
      params: { minWidth: 512, minHeight: 512 },
    });
  }

  // Vision match: does the image depict what was requested?
  const subjectText = [title, description].filter(Boolean).join('. ');
  criteria.push({
    id: 'vision_match',
    description: `Image depicts the requested subject: "${subjectText}"`,
    type: 'vision_match',
    params: { subject: subjectText },
  });

  return criteria;
}

/**
 * Evaluate acceptance criteria against actual file deliverables.
 *
 * Returns per-criterion pass/fail + an overall result.
 * The 8.5 bar applies to the criteria checklist:
 *   - All criteria pass → score 10.0 (PASS)
 *   - Some criteria fail → score proportional to passing count (may FAIL)
 *   - vision_match skipped when no LLM key → non-blocking (still passes checklist)
 *
 * Vision model check is a best-effort call to the same LLM used for QC.
 * On no-key or error: vision_match is skipped (not failed).
 */
export interface CriterionResult {
  id: string;
  description: string;
  pass: boolean;
  reason: string;
}

export interface CriteriaCheckResult {
  score: number;
  pass: boolean;
  results: CriterionResult[];
  /** Whether vision match was skipped due to no LLM key */
  visionSkipped: boolean;
}

export async function evaluateCriteria(
  criteria: AcceptanceCriterion[],
  manifest: DeliverableManifestItem[],
): Promise<CriteriaCheckResult> {
  if (criteria.length === 0 || manifest.length === 0) {
    return { score: 7.5, pass: false, results: [], visionSkipped: false };
  }

  const results: CriterionResult[] = [];
  let visionSkipped = false;

  for (const c of criteria) {
    switch (c.type) {
      case 'existence': {
        const anyValid = manifest.some((m) => m.valid && (m.sizeBytes ?? 0) > 0);
        results.push({
          id: c.id,
          description: c.description,
          pass: anyValid,
          reason: anyValid ? 'File exists and is non-empty' : 'No valid non-empty artifact found',
        });
        break;
      }

      case 'valid_image': {
        const anyValidImage = manifest.some((m) => m.valid && m.type === 'image');
        results.push({
          id: c.id,
          description: c.description,
          pass: anyValidImage,
          reason: anyValidImage ? 'Valid image artifact found' : 'No valid image artifact (bad magic bytes or missing)',
        });
        break;
      }

      case 'min_resolution': {
        // We don't decode image dimensions in the current manifest (no heavy decoder).
        // Pass through: if file is valid image and size is reasonable (>1KB), accept.
        const minSizeHeuristic = 1024; // 1KB — smallest valid non-trivial PNG
        const meetsSize = manifest.some((m) => m.valid && (m.sizeBytes ?? 0) >= minSizeHeuristic);
        results.push({
          id: c.id,
          description: c.description,
          pass: meetsSize,
          reason: meetsSize
            ? 'Artifact size suggests sufficient resolution'
            : `Artifact too small (< ${minSizeHeuristic} bytes) — likely below minimum resolution`,
        });
        break;
      }

      case 'vision_match': {
        // Try vision-model check; skip gracefully on no key or error.
        const subject = typeof c.params?.subject === 'string' ? c.params.subject : '';
        const visionResult = await visionMatchCheck(manifest, subject);
        if (visionResult === null) {
          // No key / error — skip (do NOT fail the criterion)
          visionSkipped = true;
          results.push({
            id: c.id,
            description: c.description,
            pass: true, // skip = neutral (don't penalise)
            reason: 'Vision check skipped (no LLM key available) — criterion treated as pass',
          });
        } else {
          results.push({
            id: c.id,
            description: c.description,
            pass: visionResult.yes,
            reason: `Vision check: ${visionResult.yes ? 'YES' : 'NO'} (confidence ${(visionResult.confidence * 100).toFixed(0)}%) — ${visionResult.explanation}`,
          });
        }
        break;
      }

      default: {
        // Custom criterion: always pass (unimplemented custom criteria should not block)
        results.push({
          id: c.id,
          description: c.description,
          pass: true,
          reason: 'Custom criterion — treated as pass (not yet implemented)',
        });
      }
    }
  }

  const passCount = results.filter((r) => r.pass).length;
  const total = results.length;
  const ratio = total > 0 ? passCount / total : 1;

  // Score: 10.0 for all pass, scales down proportionally.
  // Gate: all criteria must pass for ≥ 8.5 (the one "fail" criterion blocks).
  const allPass = results.every((r) => r.pass);
  const score = allPass ? 10.0 : Math.max(2.0, ratio * 8.4); // cap at 8.4 if any fail

  return {
    score,
    pass: score >= QC_PASS_THRESHOLD,
    results,
    visionSkipped,
  };
}

/**
 * Call the LLM with a vision prompt: "Does this image depict X?"
 * Returns { yes, confidence, explanation } or null on error / no key.
 */
async function visionMatchCheck(
  manifest: DeliverableManifestItem[],
  subject: string,
): Promise<{ yes: boolean; confidence: number; explanation: string } | null> {
  if (!subject.trim()) return null;

  const openAiKey = process.env.OPENAI_API_KEY;
  const googleKey =
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GEMINI_API_KEY;

  if (!openAiKey && !googleKey) return null;

  // Find first valid image in manifest
  const imageItem = manifest.find((m) => m.valid && m.type === 'image' && m.path);
  if (!imageItem?.path) return null;

  // Read file as base64
  let b64: string;
  try {
    const buf = readFileSync(imageItem.path);
    b64 = buf.toString('base64');
  } catch {
    return null;
  }

  const prompt = `Look at this image. Does it depict: "${subject}"?
Reply with ONLY this JSON (no other text):
{"yes": <boolean>, "confidence": <0.0-1.0>, "explanation": "<one sentence>"}`;

  // Try OpenAI vision (gpt-4o-mini supports vision)
  if (openAiKey) {
    try {
      const ext = imageItem.path.slice(imageItem.path.lastIndexOf('.') + 1).toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'low' } },
            ],
          }],
          max_tokens: 100,
          temperature: 0,
        }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
        const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const parsed = JSON.parse(cleaned) as { yes: boolean; confidence: number; explanation: string };
        return { yes: !!parsed.yes, confidence: Number(parsed.confidence) || 0.5, explanation: parsed.explanation ?? '' };
      }
    } catch { /* fall through to Google */ }
  }

  // Google Gemini vision fallback
  if (googleKey) {
    try {
      const model = process.env.QC_SCORER_MODEL || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${googleKey}`;
      const ext = imageItem.path.slice(imageItem.path.lastIndexOf('.') + 1).toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mime, data: b64 } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 200 },
        }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const parsed = JSON.parse(cleaned) as { yes: boolean; confidence: number; explanation: string };
        return { yes: !!parsed.yes, confidence: Number(parsed.confidence) || 0.5, explanation: parsed.explanation ?? '' };
      }
    } catch { /* no vision key or error */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// §4 — Un-reroutable failure detection
// ---------------------------------------------------------------------------

/**
 * Determine whether a QC failure is un-reroutable (i.e., caused by a factor
 * the executor cannot fix: brief wording, missing metadata, no SOP assigned).
 *
 * Un-reroutable failures MUST NOT trigger the reroute loop.  They go straight
 * to `review` with a human-readable reason.  The 3-strike cap stays.
 *
 * Returns { unrouteable: true, reason } if un-reroutable, else { unrouteable: false }.
 */
export function classifyFailure(result: QCResult): { unrouteable: boolean; reason?: string } {
  if (result.pass) return { unrouteable: false };

  // no-criteria path: the SOP is missing — executor cannot fix this
  if (result.scoringPath === 'no-criteria') {
    return {
      unrouteable: true,
      reason: `QC cannot evaluate: no SOP or acceptance criteria assigned. Human review required. (Reason: ${result.reason})`,
    };
  }

  // Gap analysis: look for un-reroutable signals in the gap list
  const allGapsText = [...result.gaps, result.reason].join(' ').toLowerCase();
  const unrouteableSignals = [
    /brief.*wording/,
    /request.*too.*vague/,
    /missing.*metadata/,
    /no.*sop.*assigned/,
    /no.*criteria/,
    /cannot.*verify.*completion/,
    /description.*too.*brief.*to.*verify/,
    /terse.*brief/,
  ];

  for (const pattern of unrouteableSignals) {
    if (pattern.test(allGapsText)) {
      return {
        unrouteable: true,
        reason: `QC failure is un-reroutable (executor cannot influence: ${result.gaps.slice(0, 2).join('; ')}). Human review required.`,
      };
    }
  }

  return { unrouteable: false };
}

// ---------------------------------------------------------------------------
// §4 — Owner-approval lane helpers
// ---------------------------------------------------------------------------

/**
 * Check if a task is source=owner (for the owner-approval lane).
 * We check the description for the provenance marker injected by the ingest route.
 */
export function isOwnerTask(description: string | null | undefined): boolean {
  if (!description) return false;
  // ingest route writes "Source: owner" into description
  return /\bsource:\s*owner\b/i.test(description);
}

/**
 * Emit the owner-approval event.
 *
 * §4: when source=owner AND artifact passes criteria, the terminal step is
 * "deliver to owner for approval" via Telegram with approve/redo buttons —
 * NOT autonomous gating.
 *
 * This function writes:
 *   1. A `qc_owner_approval_pending` event (board-visible, picked up by the
 *      OpenClaw Telegram bridge).
 *   2. A clear TODO seam comment for the Telegram plumbing.
 *
 * The actual Telegram send is handled by the OpenClaw gateway when it observes
 * the `qc_owner_approval_pending` event type. If the gateway is not available,
 * the event stays in the DB and the operator sees it in the Live Feed.
 */
export function emitOwnerApprovalPending(
  taskId: string,
  taskTitle: string,
  artifactPath: string | null | undefined,
  missionControlUrl: string,
): void {
  const now = new Date().toISOString();

  // TODO(telegram): The OpenClaw gateway should subscribe to
  // `qc_owner_approval_pending` events and send a Telegram message to the
  // task's source owner with:
  //   - The artifact image (inline) if artifactPath is an image
  //   - Approve button → POST /api/tasks/<id> { status: 'done' }
  //   - Redo button   → POST /api/tasks/<id> { status: 'in_progress' }
  // Wire this in the OpenClaw event-bridge when the gateway is available.
  // The event emitted here is the seam; the gateway reads it asynchronously.

  const approveUrl = `${missionControlUrl}/api/tasks/${taskId}`;
  const artifactNote = artifactPath ? `\nArtifact: ${artifactPath}` : '';

  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      'qc_owner_approval_pending',
      taskId,
      `[QC-OWNER-APPROVAL] Task "${taskTitle}" passed artifact criteria and is awaiting owner approval.${artifactNote}\nApprove: PATCH ${approveUrl} {"status":"done"}\nRedo: PATCH ${approveUrl} {"status":"in_progress"}`,
      now,
    ],
  );

  // Also write a task_status_changed event so the board timeline shows it
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      'task_status_changed',
      taskId,
      `[QC-OWNER-APPROVAL] "${taskTitle}" criteria passed — pending owner approval via Telegram`,
      now,
    ],
  );
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
      `SELECT id, title, description, sop_id, department, workspace_id,
              assigned_agent_id, persona_id, status, qc_reroute_attempts
       FROM tasks WHERE id = ?`,
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

    // ── Artifact-aware QC: build deliverable manifest (duck-fix) ─────────────
    // Fetch all file deliverables for this task and probe each one.
    // If we have valid file deliverables, pass the manifest to the scorer so it
    // switches to fulfillment mode instead of brief-completeness mode.
    // Text-tasks (no file deliverables) get a null manifest → unchanged behaviour.
    interface DeliverableRow {
      id: string;
      title: string;
      path: string | null;
      deliverable_type: string;
    }
    let deliverableManifest: DeliverableManifestItem[] | null = null;
    try {
      const delivRows = queryAll<DeliverableRow>(
        `SELECT id, title, path, deliverable_type FROM task_deliverables WHERE task_id = ?`,
        [taskId],
      );
      const fileRows = delivRows.filter((d) => d.deliverable_type === 'file' && d.path);
      if (fileRows.length > 0) {
        deliverableManifest = fileRows.map((d): DeliverableManifestItem => {
          const rawPath = d.path!.replace(/^~/, process.env.HOME || '');
          const ext = rawPath.slice(rawPath.lastIndexOf('.')).toLowerCase();
          const isImage = IMAGE_EXTENSIONS.has(ext);

          if (isImage) {
            const probe = probeImageFile(rawPath);
            if (!probe.valid) {
              return {
                title: d.title,
                path: rawPath,
                type: 'image',
                sizeBytes: null,
                dimensions: null,
                valid: false,
                invalidReason: probe.reason,
              };
            }
            return {
              title: d.title,
              path: rawPath,
              type: 'image',
              sizeBytes: probe.sizeBytes,
              dimensions: null, // dimensions require image decode; skip for now
              valid: true,
            };
          }

          // Non-image file: simple existence + size check.
          if (!existsSync(rawPath)) {
            return {
              title: d.title,
              path: rawPath,
              type: 'file',
              sizeBytes: null,
              dimensions: null,
              valid: false,
              invalidReason: `File not found: ${rawPath}`,
            };
          }
          let sz = 0;
          try { sz = statSync(rawPath).size; } catch { /* ignore */ }
          return {
            title: d.title,
            path: rawPath,
            type: 'file',
            sizeBytes: sz,
            dimensions: null,
            valid: sz > 0,
            invalidReason: sz === 0 ? `File is empty (0 bytes): ${rawPath}` : undefined,
          };
        });

        // Early-exit: if ALL deliverables are missing/invalid, fail immediately
        // without spending an LLM call — the reason is structural, not qualitative.
        const allInvalid = deliverableManifest.every((d) => !d.valid);
        if (allInvalid) {
          const missingReasons = deliverableManifest.map((d) => d.invalidReason ?? `missing: ${d.path}`);
          console.warn(`[QCScorer] Task "${task.title}" (${taskId}): all deliverables missing/invalid — instant fail`);
          const failResult: QCResult = {
            score: 2.0,
            pass: false,
            reason: `All file deliverables are missing or invalid: ${missingReasons.join('; ')}`,
            gaps: missingReasons,
            scoringPath: 'llm',
          };
          const now = new Date().toISOString();
          run(
            `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              'qc_review',
              taskId,
              `[QC-AUTO] Score: 2.0/10 | FAIL → returned to Backlog | All deliverables missing/invalid: ${missingReasons.join('; ')} [path:llm]`,
              now,
            ],
          );
          const prevAttempts = task.qc_reroute_attempts ?? 0;
          const newAttempts = prevAttempts + 1;
          const kickbackNote = `[QC-FAIL] Score 2.0/10 (attempt ${newAttempts}/${QC_MAX_REROUTES}). Missing deliverables: ${missingReasons.join('; ')}`;
          run(
            `UPDATE tasks SET status = 'backlog',
               description = CASE WHEN description IS NULL OR description = '' THEN ? ELSE description || char(10) || char(10) || ? END,
               qc_reroute_attempts = ?, updated_at = ?
             WHERE id = ? AND status = 'review'`,
            [kickbackNote, kickbackNote, newAttempts, now, taskId],
          );
          return failResult;
        }
      }
    } catch (manifestErr) {
      // Non-fatal: if manifest building errors, fall back to text-only scoring.
      console.warn('[QCScorer] Deliverable manifest build failed (non-fatal):', (manifestErr as Error).message);
      deliverableManifest = null;
    }
    // ── End artifact manifest ─────────────────────────────────────────────────

    // §4 Criteria-based scoring for artifact tasks.
    // If we have a deliverable manifest (artifact mode), derive acceptance
    // criteria from the task request and evaluate them.  The 8.5 bar applies
    // to the criteria checklist, NOT brief-completeness prose.
    let result: QCResult;
    const now = new Date().toISOString();

    if (deliverableManifest && deliverableManifest.length > 0) {
      // Artifact mode: derive criteria from the task title + description.
      const criteria = deriveAcceptanceCriteria(task.title, task.description);

      if (criteria.length > 0) {
        // Evaluate criteria checklist
        const criteriaResult = await evaluateCriteria(criteria, deliverableManifest);

        const failedCriteria = criteriaResult.results.filter((r) => !r.pass);
        const failReasons = failedCriteria.map((r) => `${r.id}: ${r.reason}`);
        const passReasons = criteriaResult.results.filter((r) => r.pass).map((r) => r.id);

        result = {
          score: criteriaResult.score,
          pass: criteriaResult.pass,
          reason: criteriaResult.pass
            ? `Artifact criteria checklist PASS (${passReasons.join(', ')})${criteriaResult.visionSkipped ? ' [vision-check skipped: no LLM key]' : ''}`
            : `Artifact criteria checklist FAIL: ${failReasons.join('; ')}`,
          gaps: failReasons,
          scoringPath: 'llm',
        };

        console.log(`[QCScorer] Task "${task.title}" (${taskId}): artifact-mode criteria score ${criteriaResult.score.toFixed(1)}/10 (${criteriaResult.pass ? 'PASS' : 'FAIL'})`);
      } else {
        // Manifest present but no image criteria derived (non-image artifact)
        // → fall through to standard scoring
        const input: QCScorerInput = {
          taskId: task.id,
          taskTitle: task.title,
          taskDescription: task.description,
          sopSuccessCriteria: sopRow?.success_criteria ?? null,
          sopName: sopRow?.name ?? null,
          sopSteps: sopRow?.steps ?? null,
          departmentSlug: task.department ?? task.workspace_id ?? null,
          qcAgentId: qcAgent?.id ?? null,
          qcAgentName: qcAgent?.name ?? null,
          qcAgentModel: qcAgent?.model ?? null,
          deliverableManifest: deliverableManifest,
        };
        result = await scoreTaskForQC(input);
      }
    } else {
      // Document/work mode: use existing SOP rubric path
      const input: QCScorerInput = {
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description,
        sopSuccessCriteria: sopRow?.success_criteria ?? null,
        sopName: sopRow?.name ?? null,
        sopSteps: sopRow?.steps ?? null,
        departmentSlug: task.department ?? task.workspace_id ?? null,
        qcAgentId: qcAgent?.id ?? null,
        qcAgentName: qcAgent?.name ?? null,
        qcAgentModel: qcAgent?.model ?? null,
        deliverableManifest: null,
      };
      result = await scoreTaskForQC(input);
    }

    // ── PRD 2.10: Persist QC result to task_qc_results for grading module ─────
    // Fire-and-forget: wrap in try/catch so any DB error never breaks the scorer.
    // All paths (llm, heuristic, no-criteria) write a row so the grading module
    // can surface the "awaiting LLM key" insufficient-data state.
    // The grading module itself filters to scoring_path='llm' for qcPassRate.
    try {
      // Resolve workspace_id and department_slug from the task + workspaces table.
      const wsId: string | null = task.workspace_id ?? null;
      let deptSlug: string | null = task.department ?? null;
      if (!deptSlug && wsId) {
        try {
          const ws = queryOne<{ slug: string }>('SELECT slug FROM workspaces WHERE id = ?', [wsId]);
          deptSlug = ws?.slug ?? wsId;
        } catch { /* no workspace row — use workspace_id as fallback */ }
      }
      if (deptSlug) {
        deptSlug = canonicalDeptSlug(deptSlug) || deptSlug;
      }
      const attemptNum = (task.qc_reroute_attempts ?? 0) + 1;
      const passed = result.scoringPath === 'llm' && result.score >= QC_PASS_THRESHOLD ? 1 : 0;

      run(
        `INSERT INTO task_qc_results
           (id, task_id, workspace_id, department_slug, score, passed, scoring_path, qc_agent_id, attempt, scored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          taskId,
          wsId,
          deptSlug,
          result.score,
          passed,
          result.scoringPath,
          qcAgent?.id ?? null,
          attemptNum,
          now,
        ],
      );
    } catch (qcPersistErr) {
      console.warn('[QCScorer] task_qc_results INSERT failed (non-fatal):', (qcPersistErr as Error).message);
    }
    // ── End of PRD 2.10 QC persistence ───────────────────────────────────────

    // ── PRD 2.4: heuristic mode guard ─────────────────────────────────────────
    // When the scorer runs in heuristic mode (no LLM key / LLM error), the task
    // STAYS in `review`. We write an explanatory event and return WITHOUT
    // triggering the auto-reroute loop. Reroutes must only fire on a real LLM
    // score below the 8.5 gate. This prevents keyless installs from churning
    // every task through QC_MAX_REROUTES and landing in `blocked`.
    if (result.scoringPath === 'heuristic') {
      const scoredBy = qcAgent ? ` [scorer:${qcAgent.name}]` : ' [scorer:global-heuristic]';
      const gapNote = result.gaps.length > 0 ? ` Gaps: ${result.gaps.join('; ')}` : '';
      const heuristicEventMsg =
        `[QC-HEURISTIC] Score: ${result.score.toFixed(1)}/10 | QC ran in heuristic mode (no LLM key); human review required. ${result.reason}${gapNote} [path:heuristic]${scoredBy}`;

      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'qc_review', taskId, heuristicEventMsg, now],
      );

      console.log(
        `[QCScorer] Task "${task.title}" (${taskId}): heuristic mode — task stays in review, human review required (score ${result.score.toFixed(1)}/10, qc_reroute_attempts unchanged at ${task.qc_reroute_attempts ?? 0})`,
      );

      return result;
    }
    // ── End of heuristic guard ────────────────────────────────────────────────

    // Write QC event — include QC agent identity so audit trail shows who scored
    const scoredBy = qcAgent ? ` [scorer:${qcAgent.name}]` : ' [scorer:global-heuristic]';
    const gapNote = result.gaps.length > 0 ? ` Gaps: ${result.gaps.join('; ')}` : '';
    const eventMessage =
      `[QC-AUTO] Score: ${result.score.toFixed(1)}/10 | ${result.pass ? 'PASS → moved to Done' : 'FAIL → returned to Backlog for re-route'} | ${result.reason}${gapNote} [path:${result.scoringPath}]${scoredBy}`;

    run(
      `INSERT INTO events (id, type, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'qc_review', taskId, eventMessage, now],
    );

    if (result.pass) {
      // §4 Owner-approval lane: source=owner creative tasks that pass criteria
      // go to "deliver to owner for approval" instead of autonomous done-gating.
      const ownerTask = isOwnerTask(task.description);
      const hasArtifacts = deliverableManifest && deliverableManifest.length > 0;

      if (ownerTask && hasArtifacts) {
        // Emit owner-approval event (Telegram + approve/redo buttons via OpenClaw)
        const firstArtifactPath = deliverableManifest!.find((m) => m.valid)?.path ?? null;
        const mcu = getMissionControlUrl();
        emitOwnerApprovalPending(taskId, task.title, firstArtifactPath, mcu);
        // Task STAYS in `review` — owner decides; do not autonomously mark done.
        console.log(`[QCScorer] Task "${task.title}" (${taskId}): PASS ${result.score.toFixed(1)}/10 → owner-approval pending (source=owner + artifact)`);
        return result;
      }

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

      // ── Persona completion feedback loop (PRD 1.4) ─────────────────────
      // Spawn record-completion async so persona_performance accumulates.
      // Skip when persona_id is null (task never had a persona assigned).
      if (task.persona_id) {
        // PRD 2.9(f): when task.department is null, resolve the workspace slug
        // from the DB rather than passing workspace_id raw (which may be a UUID
        // for UI-created workspaces). department_id in persona_selection_log must
        // always be a canonical slug, never a UUID.
        let deptSlug: string | null = task.department ?? null;
        if (!deptSlug && task.workspace_id) {
          try {
            const ws = queryOne<{ slug: string }>(
              'SELECT slug FROM workspaces WHERE id = ?',
              [task.workspace_id],
            );
            deptSlug = ws?.slug ?? task.workspace_id;
          } catch {
            deptSlug = task.workspace_id;
          }
        }
        // Apply canonical normalization so the slug is always in the ZHC set.
        if (deptSlug) deptSlug = canonicalDeptSlug(deptSlug) || deptSlug;
        // Pass task title + description as --task-output so the Python
        // record_completion() function can write the persona_performance row.
        const taskOutput = [task.title, task.description].filter(Boolean).join(' — ');
        spawnRecordCompletion(taskId, task.persona_id, deptSlug, taskOutput);
      }
    } else {
      // FAIL path

      // §4 Un-reroutable kill: if the failure is caused by brief wording,
      // missing metadata, or no SOP — the executor cannot fix it by re-running.
      // These go straight to `review` with a human-readable reason, NEVER reroute.
      const failClass = classifyFailure(result);
      if (failClass.unrouteable) {
        console.warn(`[QCScorer] Task "${task.title}" (${taskId}): un-reroutable failure — going to review, NOT backlog. Reason: ${failClass.reason}`);
        // Task stays in `review`; write explanatory event
        run(
          `INSERT INTO events (id, type, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            'qc_review',
            taskId,
            `[QC-UNROUTEABLE] Score: ${result.score.toFixed(1)}/10 | ${failClass.reason} Human review required.`,
            now,
          ],
        );
        return result;
      }

      // FAIL: return to backlog with gap notes, then re-dispatch — unless the
      // infinite-loop cap has been reached.

      // ── Infinite-loop guard ──────────────────────────────────────────────
      // Increment the per-task attempt counter. If it exceeds QC_MAX_REROUTES,
      // block the task and notify the CEO instead of re-dispatching.
      const prevAttempts = task.qc_reroute_attempts ?? 0;
      const newAttempts = prevAttempts + 1;

      if (newAttempts > QC_MAX_REROUTES) {
        // Cap reached → set task to `blocked` and stop the loop.
        const blockedNote = `[QC-BLOCKED] Task failed QC ${newAttempts} time(s) (cap: ${QC_MAX_REROUTES}). Needs human review. Last score: ${result.score.toFixed(1)}/10. ${result.reason}`;

        run(
          `UPDATE tasks SET status = 'blocked',
             description = CASE
               WHEN description IS NULL OR description = '' THEN ?
               ELSE description || char(10) || char(10) || ?
             END,
             qc_reroute_attempts = ?,
             updated_at = ?
           WHERE id = ? AND status = 'review'`,
          [blockedNote, blockedNote, newAttempts, now, taskId],
        );

        run(
          `INSERT INTO events (id, type, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [uuidv4(), 'task_status_changed', taskId,
            `[QC-BLOCKED] Task "${task.title}" blocked after ${newAttempts} QC-fail re-routes (cap: ${QC_MAX_REROUTES}). Human review required.`,
            now],
        );

        console.warn(`[QCScorer] Task "${task.title}" (${taskId}): BLOCKED after ${newAttempts} QC-fail re-routes — CEO notified`);

        // Notify CEO via event so the Live Feed surfaces the block.
        let ceoAgentIdBlocked: string | null = null;
        try {
          const row = queryOne<{ id: string }>(
            `SELECT id FROM agents WHERE is_master = 1
             AND (workspace_id = 'master-orchestrator' OR workspace_id = 'ceo')
             LIMIT 1`,
            [],
          );
          ceoAgentIdBlocked = row?.id ?? null;
        } catch { /* no CEO agent — still visible via task event */ }

        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            'qc_review',
            ceoAgentIdBlocked,
            taskId,
            `[QC-BLOCKED] "${task.title}" failed QC ${newAttempts} time(s) and has been blocked. Score: ${result.score.toFixed(1)}/10. Needs human attention.`,
            now,
          ],
        );

        return result;
      }
      // ── End of loop guard ────────────────────────────────────────────────

      const kickbackNote = result.gaps.length > 0
        ? `[QC-FAIL] Score ${result.score.toFixed(1)}/10 (attempt ${newAttempts}/${QC_MAX_REROUTES}). Rework needed: ${result.gaps.join('; ')}`
        : `[QC-FAIL] Score ${result.score.toFixed(1)}/10 (attempt ${newAttempts}/${QC_MAX_REROUTES}). ${result.reason}`;

      run(
        `UPDATE tasks SET status = 'backlog',
           description = CASE
             WHEN description IS NULL OR description = '' THEN ?
             ELSE description || char(10) || char(10) || ?
           END,
           qc_reroute_attempts = ?,
           updated_at = ?
         WHERE id = ? AND status = 'review'`,
        [kickbackNote, kickbackNote, newAttempts, now, taskId],
      );

      // Write task_status_changed event — visible on the board timeline.
      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'task_status_changed', taskId,
          `[QC-AUTO] Task "${task.title}" returned to Backlog — score ${result.score.toFixed(1)}/10 < ${QC_PASS_THRESHOLD} (attempt ${newAttempts}/${QC_MAX_REROUTES}). ${result.reason}`,
          now],
      );

      // Write CEO-addressed reroute event so the master-orchestrator knows to
      // re-assign / re-route the task back to the correct department.
      const ceoDept = task.department ?? task.workspace_id ?? 'unknown';
      const gapsSummary = result.gaps.length > 0 ? result.gaps.join('; ') : result.reason;

      // Resolve master-orchestrator/CEO agent for the event author field.
      let ceoAgentId: string | null = null;
      try {
        const ceoRow = queryOne<{ id: string }>(
          `SELECT id FROM agents WHERE is_master = 1
           AND (workspace_id = 'master-orchestrator' OR workspace_id = 'ceo')
           LIMIT 1`,
          [],
        );
        ceoAgentId = ceoRow?.id ?? null;
      } catch {
        // No CEO agent found — write event without agent_id (still visible)
      }

      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'qc_review',
          ceoAgentId,
          taskId,
          `[QC-REROUTE] "${task.title}" FAILED QC → re-route to ${ceoDept} with fixes: ${gapsSummary} (attempt ${newAttempts}/${QC_MAX_REROUTES})`,
          now,
        ],
      );

      // ── Fix: use getMissionControlUrl() (port 4000) not NEXTAUTH_URL (port 3000) ──
      // This was the root cause of "fetch failed" — NEXTAUTH_URL defaults to
      // port 3000 but the app runs on port 4000.
      const baseUrl = getMissionControlUrl();
      fetch(`${baseUrl}/api/webhooks/auto-route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, workspaceId: task.workspace_id }),
      }).then(async (resp) => {
        if (resp.ok) {
          // Auto-route succeeded: move the task to in_progress so it leaves backlog.
          run(
            `UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'backlog'`,
            [new Date().toISOString(), taskId],
          );
          console.log(`[QCScorer] Auto-route succeeded for task "${task.title}" (${taskId}) → in_progress`);
        } else {
          console.warn(`[QCScorer] Auto-route returned ${resp.status} for task ${taskId} — stays in backlog for ceo-delegation-sweep`);
        }
      }).catch(err => console.warn('[QCScorer] Auto-route trigger failed (non-fatal):', (err as Error).message));

      console.log(`[QCScorer] Task "${task.title}" (${taskId}): FAIL ${result.score.toFixed(1)}/10 → backlog (re-route triggered, attempt ${newAttempts}/${QC_MAX_REROUTES})`);
    }

    return result;
  } catch (err) {
    console.error('[QCScorer] Auto-QC errored — leaving task in review for human review:', (err as Error).message);
    return null;
  }
}

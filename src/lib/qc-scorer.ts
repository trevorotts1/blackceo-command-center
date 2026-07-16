/**
 * QC Agent Auto-Scorer
 *
 * Scores a completed task against the assigned SOP's success_criteria using a
 * 1–10 rubric. Called automatically when a task transitions to `review` status.
 *
 * Gate: ≥8.5 → auto-approve (mark done); <8.5 → kick back to `backlog`
 * (the task re-enters intake / auto-route from there) with specific gap notes
 * as a task event. NOTE: the kickback target is `backlog`, NOT `in_progress` —
 * the raw status writers below all write `status = 'backlog'` on a QC fail.
 *
 * Per-department QC: the scorer resolves the ITEM'S OWN department QC agent
 * (role_type='qc', workspace_id = task's workspace) and uses that agent's
 * model (if set) and identity in the scoring prompt and event log. This ensures
 * that the Marketing QC Specialist scores marketing tasks, the Sales QC
 * Specialist scores sales tasks, etc. — as defined by the onboarding role
 * library (one QC specialist per department).
 *
 * Scoring paths:
 *   1. LLM-backed (primary): the JUDGE runs on the CLIENT's OWN Ollama Cloud
 *      model (QC-08 operator decision) — the dept QC agent's model or
 *      QC_JUDGE_MODEL, which MUST be an ollama-cloud / :cloud model, called via
 *      the client's OLLAMA_CLOUD_API_KEY. The judge is NEVER an operator/shared
 *      paid OpenAI/Google key, and NEVER the same model that wrote the content
 *      (JUDGE != WRITER). No client judge configured → fail CLOSED to (2).
 *   2. Heuristic fallback (no client judge / judge error): structural checks on the
 *      deliverable meta (description non-empty, SOP assigned, persona assigned,
 *      title non-trivial). Returns a conservative score in [6.0, 8.0].
 *      IMPORTANT: heuristic mode NEVER triggers the auto-reroute loop. Reroutes
 *      are ONLY triggered by a real LLM score below the 8.5 gate. This prevents
 *      keyless installs from spinning every task through 3 reroutes and into
 *      `blocked` (PRD 2.4). The heuristic fallback splits by `heuristicReason`:
 *        - 'no-key'        → keyless install by design: task stays in `review`
 *                            with a "[QC-HEURISTIC] … human review required" event.
 *        - 'provider-down' → a key exists but every LLM call failed (outage/blip):
 *                            task is DEFERRED in `review` with a distinct
 *                            "[QC-DEFERRED-PROVIDER-DOWN]" marker and auto-rescored
 *                            by qc-review-sweep when the provider returns, so a
 *                            provider blip does NOT storm the board into human
 *                            review (Point 6 fix 1).
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

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'fs';
import * as path from 'path';
// TCC-safe accessors for the ARTIFACT tree (PROJECTS_PATH, default
// ~/Documents/Shared — a macOS TCC-protected dir where a raw open()/opendir()
// blocks the qc-review-sweep event loop forever). Session reads under
// ~/.openclaw are NOT protected and keep the direct fs.* calls above.
import { safeReadFileUtf8, safeReadFileBuffer, safeReaddirNames } from '@/lib/fs/safe-fs';
import { queryOne, queryAll, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { TRIO_ROLE_ALIASES } from '@/lib/db/migrations';
import { getMissionControlUrl } from '@/lib/config';
import { missionControlAuthHeaders } from '@/lib/mc-auth';
import { notifyOwner } from '@/lib/notify';
import { notifyOwnerDone } from '@/lib/owner-reports';
import { transition, TransitionError, recordStatusEvent } from '@/lib/task-lifecycle';
import { assertNoFixtureEnvInProduction } from '@/lib/fixture-guard';
import { getProvider } from '@/lib/model-providers';
import {
  chatCompletion as ollamaCloudChat,
  getOllamaCloudChatEndpoint,
} from '@/lib/model-providers/ollama-cloud';
import { resolveProviderApiKey } from '@/lib/provider-key-detection';
import type { ChatCompletionResponse } from '@/lib/model-providers/types';

// ---------------------------------------------------------------------------
// AF-I14 — KIE.ai image-path guardrail for Presentations department
//
// Mandate: the dept-presentations runtime MUST generate all slide images via
// scripts/kie_generate.py (KIE.ai gpt-image-2 endpoint). Using the native
// image_generate tool (openai-image-gen skill, OpenAI DALL·E endpoint) is:
//   (a) a sovereignty leak — uses the operator's OpenAI key instead of the
//       client's KIE.ai key; and
//   (b) a mandate violation — the dead endpoint /api/v1/image/gpt-image
//       returns HTTP 404 and images are silently absent.
//
// This guardrail reads the exec trace (OpenClaw session .jsonl files) for the
// task and auto-fails the image phase with a named violation gap if:
//   VIOLATION-A: the native `image_generate` tool was called in any message
//   VIOLATION-B: the dead endpoint `/api/v1/image/gpt-image` appears in any
//                exec output, assistant text, or tool result
//   VIOLATION-C: neither `kie_generate.py` nor `createTask` (KIE.ai submit
//                endpoint) appear anywhere in the session trace — images were
//                not generated via the mandated script at all
//
// Session trace lookup order:
//   1. openclaw_sessions table: rows WHERE task_id = taskId AND agent_id
//      resolves to 'dept-presentations', ordered by created_at DESC — pick
//      the most recent openclaw_session_id.
//   2. Filesystem: ~/.openclaw/agents/dept-presentations/sessions/<id>.jsonl
//      Scan each line (JSON) for tool_use blocks, exec outputs, text content.
//   3. If no session trace found: skip guardrail (cannot penalise absence of
//      evidence; the deny config already blocks image_generate at the tool
//      layer from this point forward).
//
// Auto-fail result carries scoringPath='llm' so the reroute loop fires and
// the gap notes tell the agent exactly which violation to fix.
// ---------------------------------------------------------------------------

/** Departments where the AF-I14 guardrail ALWAYS applies (legacy hard scope). */
const AF_I14_DEPTS = new Set(['presentations', 'dept-presentations']);

/** Agent IDs that trigger the guardrail (canonical and full form). */
const AF_I14_AGENT_IDS = new Set(['dept-presentations']);

/**
 * Session directory roots to scan for an agent's exec trace.
 *
 * Hole-fix (v4.45.0): the guardrail was hard-scoped to dept-presentations only.
 * Any department that ships an image/deck deliverable must use the mandated
 * KIE.ai pipeline, so we now scan EVERY agent session directory under
 * ~/.openclaw/agents/<agentId>/sessions when the task carries an image/deck
 * deliverable. The presentations dir stays first for backward compatibility.
 */
function af_i14SessionRoots(agentId: string | null): string[] {
  const base = path.join(process.env.HOME || '~', '.openclaw', 'agents');
  const roots: string[] = [];
  // Most-specific first: the task's own assigned agent (any department).
  if (agentId) roots.push(path.join(base, agentId, 'sessions'));
  // Legacy presentations dir (kept first-class for AF-I14 history).
  roots.push(path.join(base, 'dept-presentations', 'sessions'));
  // Last resort: scan every agent's sessions dir so a misattributed task is
  // still caught. De-duped by the caller.
  try {
    if (existsSync(base)) {
      for (const entry of readdirSync(base)) {
        const sessDir = path.join(base, entry, 'sessions');
        if (existsSync(sessDir)) roots.push(sessDir);
      }
    }
  } catch { /* ignore — best-effort enumeration */ }
  // De-dup preserving order.
  return Array.from(new Set(roots));
}

/**
 * AF-I14 / AF-LANG: detect whether a free-text request describes a
 * presentation, deck, slide, or image deliverable. Used to decide whether the
 * KIE.ai image-path guardrail (and the AF-LANG language gate) must fail-closed
 * for this task even when its department is not Presentations.
 */
function describesImageOrDeckDeliverable(title: string, description: string | null): boolean {
  const text = [title, description].filter(Boolean).join(' ').toLowerCase();
  return /\b(image|picture|photo|png|jpg|jpeg|gif|illustration|render|graphic|logo|banner|thumbnail|draw|presentation|deck|slide|slides|slideshow|keynote|powerpoint|infographic|carousel|poster|flyer|cover\s*art|artwork)\b/.test(text);
}

/**
 * AF-PIPELINE-COMPLETE: detect whether a request describes a multi-slide DECK /
 * PRESENTATION deliverable specifically (as opposed to a single image/logo).
 *
 * Narrower than describesImageOrDeckDeliverable on purpose: the pipeline-
 * completeness gate only applies to deck/presentation builds (which must pass
 * through the Presentations-department research → copy → image-QC → GHL-upload
 * pipeline). A standalone logo/banner/photo request has no such pipeline and
 * must NOT be blocked for missing a research brief or a media_library.json.
 */
export function describesDeckDeliverable(title: string, description: string | null): boolean {
  const text = [title, description].filter(Boolean).join(' ').toLowerCase();
  return /\b(presentation|deck|slide|slides|slideshow|keynote|powerpoint|pptx|webinar|pitch\s*deck)\b/.test(text);
}

/**
 * Read and concatenate all text content from an OpenClaw session .jsonl file.
 * Returns the raw (NOT lowercased) file contents so the caller can do both
 * structured JSON parsing of tool_use blocks AND a lowercased substring scan.
 * Searches every candidate session root for `${sessionId}.jsonl`.
 * Returns empty string if the file does not exist or cannot be read.
 */
function readSessionTrace(sessionId: string, sessionRoots: string[]): string {
  for (const dir of sessionRoots) {
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    if (!existsSync(filePath)) continue;
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      /* try next root */
    }
  }
  return '';
}

/**
 * AF-I14 VIOLATION-A — STRUCTURED detection of the native image_generate tool.
 *
 * Hole-fix (v4.45.0): the old check was a substring scan on a lowercased blob,
 * so `image_generate` quoted anywhere in assistant prose produced a false
 * VIOLATION-A, and an obfuscated call could evade it. We now parse each JSONL
 * line and look for an actual tool-call block whose tool name is
 * `image_generate` (covering the shapes OpenClaw / Anthropic / OpenAI emit:
 * {type:'tool_use',name:'image_generate'}, {function:{name:'image_generate'}},
 * {tool_name:'image_generate'}, {tool:'image_generate'}). Falls back to the
 * substring scan ONLY if no line parses as JSON (robustness, never weaker).
 *
 * Returns true when a genuine native image_generate tool call is present.
 */
function af_i14NativeImageToolCalled(rawTrace: string): boolean {
  const NAME_RE = /^image[_-]?generate$/i;

  const nameFromNode = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null;
    const o = node as Record<string, unknown>;
    // Direct tool_use / tool_call shapes
    if ((o.type === 'tool_use' || o.type === 'tool_call' || o.type === 'function_call') && typeof o.name === 'string') {
      return o.name;
    }
    if (typeof o.tool_name === 'string') return o.tool_name;
    if (typeof o.tool === 'string') return o.tool;
    if (typeof o.name === 'string' && (o.input !== undefined || o.arguments !== undefined || o.parameters !== undefined)) {
      return o.name;
    }
    if (o.function && typeof o.function === 'object') {
      const fn = o.function as Record<string, unknown>;
      if (typeof fn.name === 'string') return fn.name;
    }
    return null;
  };

  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(walk);
    if (node && typeof node === 'object') {
      const name = nameFromNode(node);
      if (name && NAME_RE.test(name.trim())) return true;
      return Object.values(node as Record<string, unknown>).some(walk);
    }
    return false;
  };

  let parsedAnyLine = false;
  for (const line of rawTrace.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      parsedAnyLine = true;
      if (walk(obj)) return true;
    } catch {
      /* non-JSON line — skip; substring fallback below covers it */
    }
  }

  // Fallback: only when we could not parse ANY line as JSON, fall back to the
  // legacy substring scan so we never become weaker than the prior behaviour.
  if (!parsedAnyLine) {
    const lower = rawTrace.toLowerCase();
    return lower.includes('"image_generate"') || lower.includes("'image_generate'");
  }
  return false;
}

/**
 * AF-I14 VIOLATION-B/C — STRUCTURED extraction of the command / argument
 * surfaces of every tool call in the trace.
 *
 * Hole-fix (QC-12): VIOLATION-B (dead endpoint invoked) and VIOLATION-C (the
 * KIE.ai pipeline was NOT invoked) used to key on a naive lowercased substring
 * scan over the WHOLE trace. That is wrong in both directions:
 *   - false-positive: a trace that merely QUOTES `/api/v1/image/gpt-image` in
 *     assistant prose tripped VIOLATION-B even though nothing was called.
 *   - EVASION (false-negative): a trace that merely QUOTES `api.kie.ai` /
 *     `kie_generate.py` in prose (e.g. echoing the SOP) satisfied the
 *     `kiePresent` check, so VIOLATION-C did NOT fire even though the KIE
 *     pipeline was never actually run.
 *
 * This walker mirrors af_i14NativeImageToolCalled (VIOLATION-A): it parses each
 * JSONL line and collects ONLY the EXECUTION surfaces of real tool activity —
 * the input/arguments of a tool CALL (the shell command / HTTP url the agent
 * issued) AND the content/output of a tool RESULT (the HTTP response the call
 * actually produced, which legitimately echoes the endpoint that was hit). It
 * deliberately does NOT collect user/assistant message `content` (prose), so B/C
 * key on what the agent DID, not on what it merely quoted.
 *
 * `parsedAnyLine` tells the caller whether ANY JSONL line parsed as JSON; when
 * it did not, the caller MUST fall back to the legacy whole-trace scan so
 * detection is never weaker than the prior behaviour.
 */
function af_i14ToolCallSurfaces(rawTrace: string): { surfaces: string; parsedAnyLine: boolean } {
  const parts: string[] = [];

  // A tool CALL node (the command the agent issued).
  const isToolCallNode = (o: Record<string, unknown>): boolean => {
    if (o.type === 'tool_use' || o.type === 'tool_call' || o.type === 'function_call') return true;
    if (typeof o.tool_name === 'string' || typeof o.tool === 'string') return true;
    if (typeof o.name === 'string' && (o.input !== undefined || o.arguments !== undefined || o.parameters !== undefined)) return true;
    if (o.function && typeof o.function === 'object') return true;
    return false;
  };

  // A tool RESULT node (the output of an actually-executed call). Its content is
  // a real execution surface — e.g. an HTTP response echoing the endpoint hit —
  // NOT prose. Assistant/user message `content` is NOT collected (that is prose).
  const isToolResultNode = (o: Record<string, unknown>): boolean => {
    if (o.type === 'tool_result' || o.type === 'function_call_output' || o.type === 'tool_output') return true;
    if (o.role === 'tool') return true;
    return false;
  };

  const pushSurface = (v: unknown): void => {
    if (v === undefined || v === null) return;
    parts.push(typeof v === 'string' ? v : JSON.stringify(v));
  };

  const collectFromToolCallNode = (o: Record<string, unknown>): void => {
    pushSurface(o.input);
    pushSurface(o.arguments);
    pushSurface(o.parameters);
    if (o.function && typeof o.function === 'object') {
      // OpenAI function-call shape: function.arguments is usually a JSON string.
      pushSurface((o.function as Record<string, unknown>).arguments);
    }
  };

  const collectFromToolResultNode = (o: Record<string, unknown>): void => {
    pushSurface(o.content);
    pushSurface(o.output);
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (isToolCallNode(o)) collectFromToolCallNode(o);
      if (isToolResultNode(o)) collectFromToolResultNode(o);
      Object.values(o).forEach(walk);
    }
  };

  let parsedAnyLine = false;
  for (const line of rawTrace.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      parsedAnyLine = true;
      walk(obj);
    } catch {
      /* non-JSON line — skip; whole-trace fallback covers it when nothing parses */
    }
  }

  return { surfaces: parts.join('\n').toLowerCase(), parsedAnyLine };
}

/**
 * AF-I14 guardrail result.
 * When `violated` is true, `violations` lists the specific AF-I14 sub-rules
 * that were breached. The caller should auto-fail with these as gaps.
 */
export interface AF_I14Result {
  violated: boolean;
  violations: string[];
  /** The session ID that was scanned (for audit trail). */
  sessionId: string | null;
  /** Whether a session trace was found and scanned. */
  traceFound: boolean;
}

/**
 * Run the AF-I14 guardrail for a Presentations department task.
 *
 * Looks up the most recent session trace for the task, scans it for
 * VIOLATION-A (native image_generate tool used), VIOLATION-B (dead endpoint
 * called), and VIOLATION-C (kie_generate.py never invoked).
 *
 * Applies when the task's department/agent is Presentations OR when the task
 * carries an image/deck deliverable from ANY department (hasImageOrDeckDeliverable).
 * Safe to call on any task — returns { violated: false } if not applicable.
 *
 * FAIL-CLOSED (v4.45.0): when the task has an image/deck deliverable and we
 * cannot prove (via the session trace) that the mandated KIE.ai pipeline was
 * used, that is itself VIOLATION-C — we do NOT silently pass. The old "no
 * trace = skip" hole only remains for legacy presentations tasks that have no
 * image/deck deliverable to police.
 */
export function runAFI14Guardrail(
  taskId: string,
  agentId: string | null,
  department: string | null,
  hasImageOrDeckDeliverable: boolean = false,
  /**
   * When true (default), a shipped image/deck deliverable with NO locatable
   * session trace fails CLOSED (VIOLATION-C) — the caller could not prove the
   * mandated KIE.ai pipeline produced it. When false, a missing trace is treated
   * as "no evidence either way" and the guardrail does NOT fire on absence alone
   * (VIOLATION-A/B/C are still detected from any trace that IS found). The caller
   * sets this to true only where an exec trace is genuinely expected/recorded
   * (the Presentations KIE.ai pipeline), so legitimate artifacts on runtimes that
   * don't record OpenClaw sessions are not blocked purely for lack of a trace.
   */
  failClosedWithoutTrace: boolean = true,
): AF_I14Result {
  const notViolated: AF_I14Result = { violated: false, violations: [], sessionId: null, traceFound: false };

  // Apply to: (a) the presentations department/agent (legacy hard scope), OR
  // (b) ANY department whose task ships an image/deck deliverable (hole-fix:
  // the KIE.ai mandate is fleet-wide for image generation, not pres-only).
  const dept = department ? canonicalDeptSlug(department) || department.toLowerCase() : null;
  const isPresTask = dept ? AF_I14_DEPTS.has(dept) : false;
  const isPresAgent = agentId ? AF_I14_AGENT_IDS.has(agentId) : false;
  const inScope = isPresTask || isPresAgent || hasImageOrDeckDeliverable;
  if (!inScope) return notViolated;

  const sessionRoots = af_i14SessionRoots(agentId);

  // Lookup most-recent session for this task
  let sessionId: string | null = null;
  try {
    // Check if openclaw_sessions table exists
    const tables = queryAll<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='openclaw_sessions'`, []);
    if (tables.length > 0) {
      const row = queryOne<{ openclaw_session_id: string }>(
        `SELECT openclaw_session_id FROM openclaw_sessions
         WHERE task_id = ?
         ORDER BY created_at DESC LIMIT 1`,
        [taskId],
      );
      sessionId = row?.openclaw_session_id ?? null;
    }
  } catch {
    // Table might not exist — fall through
  }

  // If no session found via DB, scan EVERY candidate sessions directory for any
  // .jsonl file containing the taskId string (best-effort, fleet-wide).
  if (!sessionId) {
    for (const sessionDir of sessionRoots) {
      try {
        if (!existsSync(sessionDir)) continue;
        const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl') && !f.includes('trajectory'));
        for (const file of files) {
          try {
            const content = readFileSync(path.join(sessionDir, file), 'utf8');
            if (content.includes(taskId)) {
              sessionId = file.replace('.jsonl', '');
              break;
            }
          } catch { /* skip unreadable */ }
        }
        if (sessionId) break;
      } catch { /* skip directory scan error */ }
    }
  }

  if (!sessionId) {
    // No session trace found.
    if (hasImageOrDeckDeliverable && failClosedWithoutTrace) {
      // FAIL-CLOSED: an image/deck was delivered but we cannot prove the
      // mandated KIE.ai pipeline produced it. Treat as VIOLATION-C.
      return {
        violated: true,
        violations: [
          'AF-I14 VIOLATION-C (fail-closed): the task shipped an image/deck deliverable but NO session exec trace ' +
          'could be found to prove it was generated via the mandated KIE.ai pipeline (scripts/kie_generate.py / api.kie.ai). ' +
          'Fix: generate all images via python3 scripts/kie_generate.py and ensure the agent session trace is recorded.',
        ],
        sessionId: null,
        traceFound: false,
      };
    }
    // Legacy presentations-without-deliverable: cannot scan; skip guardrail.
    // The tool-layer deny config (tools.deny:["image"]) blocks future violations.
    return notViolated;
  }

  const trace = readSessionTrace(sessionId, sessionRoots);
  if (!trace) {
    if (hasImageOrDeckDeliverable && failClosedWithoutTrace) {
      return {
        violated: true,
        violations: [
          'AF-I14 VIOLATION-C (fail-closed): an image/deck deliverable was shipped but the located session trace ' +
          `(${sessionId}) was empty/unreadable, so KIE.ai usage could not be confirmed. ` +
          'Fix: generate all images via scripts/kie_generate.py and ensure the session trace is recorded.',
        ],
        sessionId,
        traceFound: false,
      };
    }
    return { violated: false, violations: [], sessionId, traceFound: false };
  }

  const lower = trace.toLowerCase();
  const violations: string[] = [];

  // STRUCTURED tool-call surfaces for VIOLATION-B/C (QC-12). We scan what the
  // agent actually EXECUTED (tool-call command/args), not prose. When no JSONL
  // line parses as JSON we fall back to the whole-trace scan so detection is
  // never weaker than the legacy behaviour.
  const { surfaces: toolSurfaces, parsedAnyLine } = af_i14ToolCallSurfaces(trace);
  const bcScan = parsedAnyLine ? toolSurfaces : lower;

  // VIOLATION-A: native image_generate tool was called.
  // STRUCTURED detection (parses tool_use blocks) — no longer a naive substring
  // scan, so quoting `image_generate` in prose no longer false-fails.
  if (af_i14NativeImageToolCalled(trace)) {
    violations.push(
      'AF-I14 VIOLATION-A: native image_generate tool (openai-image-gen skill) was called. ' +
      'This leaks the operator OpenAI key and bypasses the mandated KIE.ai pipeline. ' +
      'Fix: use ONLY scripts/kie_generate.py for all image generation.',
    );
  }

  // VIOLATION-B: dead endpoint /api/v1/image/gpt-image was actually CALLED
  // (present in a tool-call command/arg surface), not merely quoted in prose.
  if (bcScan.includes('/api/v1/image/gpt-image')) {
    violations.push(
      'AF-I14 VIOLATION-B: dead endpoint /api/v1/image/gpt-image was invoked in the session trace. ' +
      'This endpoint returns HTTP 404 — images were not generated. ' +
      'Fix: use kie_generate.py which calls the live /api/v1/jobs/createTask endpoint.',
    );
  }

  // VIOLATION-C: kie_generate.py / KIE.ai was never actually invoked.
  // Keyed on real tool-call surfaces (structured), so merely QUOTING the script
  // name or `api.kie.ai` in assistant prose no longer masks a missing call.
  const kiePresent =
    bcScan.includes('kie_generate.py') ||
    bcScan.includes('kie_generate') ||
    bcScan.includes('/api/v1/jobs/createtask') ||    // KIE.ai submit endpoint (lowercased)
    bcScan.includes('api.kie.ai');                   // KIE.ai domain
  if (!kiePresent) {
    violations.push(
      'AF-I14 VIOLATION-C: kie_generate.py was not invoked and no KIE.ai API calls detected in session trace. ' +
      'All presentation/deck/image deliverables MUST be generated via scripts/kie_generate.py. ' +
      'Fix: shell out to python3 scripts/kie_generate.py <prompts.json> <renders_dir> for all images.',
    );
  }

  return {
    violated: violations.length > 0,
    violations,
    sessionId,
    traceFound: true,
  };
}

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

/**
 * B-U12 / U26 — QC-contract fix. When set, `runQCOnReview` reads a producer-
 * posted scorecard (the `{qc_gate, qc_score, qc_passed, scorecard_path}`
 * metadata contract `cc_board.py:post_qc_score()` already writes onto a
 * `completed` task_activities row) instead of treating the Command Center
 * judge as the sole source of truth. Additive + flag-gated per the unit's
 * revert contract: unset → today's fully-independent scoring, bit-identical.
 *
 * Read LIVE (function, not a frozen module-load-time const) so the flag can
 * be toggled per-request/per-test without a process restart.
 */
export function isQCProducerScorecardEnabled(): boolean {
  return (
    process.env.QC_PRODUCER_SCORECARD_ENABLED === '1' ||
    process.env.QC_PRODUCER_SCORECARD_ENABLED === 'true'
  );
}

/**
 * Disagreement threshold (score points) between a producer-posted scorecard
 * and the Command Center judge's own score above which a review card is HELD
 * (never silently kicked back) and a single `qc_disagreement` operator event
 * is written. Spec-fixed at 1.0 — not configurable, to keep the contract
 * predictable across boxes.
 */
const QC_DISAGREEMENT_THRESHOLD = 1.0;

/**
 * Department slugs subject to the B-U12 "both-gates" rule: review→done for
 * these source cards requires BOTH the producer's own gate (FAB-QC) AND, when
 * present, Page-QC v2's verdict (`page_qc_passed` — B-U11, not yet shipped as
 * of this unit) to PASS. Stays inert (no card ever carries `page_qc_passed`)
 * until B-U11 lands; wiring it now means no follow-up CC change is needed.
 */
const QC_BOTH_GATES_DEPARTMENTS = new Set(['funnel', 'web-development']);

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
   * QC-08 — the model that WROTE the content being judged (the task's assigned
   * agent / content model). Used to enforce JUDGE != WRITER: the client's Ollama
   * Cloud judge model must differ from this. Optional; when unknown the equality
   * guard is skipped (the primary control — client-owned judge, no operator key —
   * still holds).
   */
  writerModel?: string | null;
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
  /**
   * When scoringPath === 'heuristic', WHY the heuristic fallback ran (Point 6 fix 1):
   *   - 'no-key':        no scoring API key is configured (keyless install by design)
   *                      → genuine human-review fallback (task stays in review).
   *   - 'provider-down': a key IS configured but every LLM call failed (outage /
   *                      network blip) → DEFER and auto-rescore when the provider
   *                      returns, rather than presenting as human-required.
   *   - 'judge-empty-response':     the judge ANSWERED and the provider is UP,
   *                                 but message.content was EMPTY. On a
   *                                 REASONING model this is what completion-
   *                                 budget starvation looks like: the hidden
   *                                 `reasoning` field consumes the whole
   *                                 max_tokens budget and `content` arrives
   *                                 empty. NOT a network fault.
   *   - 'judge-malformed-response': the judge ANSWERED and the provider is UP,
   *                                 but the content did not parse as JSON —
   *                                 typically truncated mid-document by the
   *                                 completion budget (finish_reason=length).
   *                                 NOT a network fault.
   * Undefined for the 'llm' / 'no-criteria' paths.
   *
   * WHY THE LAST TWO EXIST — this is the six-day lesson. Every judge failure
   * used to collapse into `return null`, and the caller labelled ALL of them
   * 'provider-down'. The provider was never down: it answered perfectly and the
   * code blamed the network. That one wrong label sent three consecutive
   * analyses chasing a routing problem that did not exist. An unreachable
   * provider and an empty answer are OPPOSITE failures with OPPOSITE fixes; a
   * wrong diagnosis printed confidently is worse than no diagnosis, because it
   * looks like evidence. These reasons keep them distinguishable.
   */
  heuristicReason?:
    | 'no-key'
    | 'provider-down'
    | 'judge-empty-response'
    | 'judge-malformed-response';
  /**
   * Judge-failure DIAGNOSTICS — WHAT failed and WHERE we called. Populated on
   * every judge-failure path so the deferral, the operator log and the terminal
   * escalation can all report the REAL failure instead of a guessed category.
   */
  judgeModel?: string;
  judgeEndpoint?: string;
  /** Verbatim, human-readable statement of what actually went wrong. */
  judgeFailureDetail?: string;
}

/**
 * The QC judge's completion budget.
 *
 * THIS NUMBER CAUSED A SIX-DAY OUTAGE. It was 300. The configured judge
 * (`deepseek-v4-flash:cloud`) is a REASONING model: its reply carries a hidden
 * `reasoning` field alongside `content`, and reasoning is billed against the
 * SAME completion budget. At 300 tokens the reasoning ate the entire budget and
 * `content` came back EMPTY — which the code then reported as "provider-down".
 * Proven on the live path: 300 → empty content; 1500 → 587 completion tokens →
 * clean parse → a real verdict.
 *
 * So 300 was not marginally low, it was wrong by a factor. The ceiling here is
 * deliberately generous rather than fitted to that one 587-token sample:
 * max_tokens is a CAP, not an allocation — an unused cap costs nothing, while a
 * cap one token too low costs six days of silence. Reasoning length also varies
 * with prompt complexity, so a snug bound would re-arm the same trap on a
 * harder task. 2048 leaves ~3.5x margin over the observed need.
 *
 * Not derived from the model registry on purpose: `ProviderModel` exposes
 * `context_window` (an INPUT bound), not a max-output bound, so there is no
 * capability field that actually answers this question — deriving it would mean
 * inventing one. Overridable per-box via QC_JUDGE_MAX_TOKENS.
 *
 * The budget is a mitigation, NOT the guarantee: a verbose enough model could
 * still truncate. That is why truncation is DETECTED and reported
 * (finish_reason=length → 'judge-malformed-response') rather than swallowed.
 */
export const QC_JUDGE_MAX_TOKENS_DEFAULT = 2048;

/**
 * Floor of 300 keeps a fat-fingered override from re-creating the original bug.
 * Exported so the QC judge PROBE uses the identical budget: the probe is the
 * instrument a human trusts to tell them whether the judge works, and it shipped
 * with `max_tokens: 5` — this same bug's identical twin, guaranteed to starve a
 * reasoning model and then report the credential as dead. One resolver, one
 * budget, no second place for the trap to live.
 */
export function resolveJudgeMaxTokens(): number {
  const parsed = parseInt(process.env.QC_JUDGE_MAX_TOKENS || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return QC_JUDGE_MAX_TOKENS_DEFAULT;
  return Math.max(300, parsed);
}

/**
 * WHY the judge produced no verdict. These are OPPOSITE failures:
 *   - 'unreachable'        → the provider never answered (network/DNS/refused/HTTP error).
 *   - 'empty-response'     → the provider answered; content was empty (budget starvation).
 *   - 'malformed-response' → the provider answered; content was unparseable (truncation).
 * Only the FIRST one means the provider is down.
 */
export type JudgeFailureKind = 'unreachable' | 'empty-response' | 'malformed-response';

type JudgeOutcome =
  | { ok: true; result: QCResult }
  | { ok: false; kind: JudgeFailureKind; detail: string };

/** Map the true failure kind onto the heuristic reason carried in QCResult. */
function judgeKindToHeuristicReason(kind: JudgeFailureKind): NonNullable<QCResult['heuristicReason']> {
  switch (kind) {
    case 'unreachable':
      return 'provider-down';
    case 'empty-response':
      return 'judge-empty-response';
    case 'malformed-response':
      return 'judge-malformed-response';
  }
}

/** Is this heuristic reason a JUDGE FAILURE (bounded-retry + escalation lane)? */
export function isJudgeFailureReason(reason: QCResult['heuristicReason']): boolean {
  return (
    reason === 'provider-down' ||
    reason === 'judge-empty-response' ||
    reason === 'judge-malformed-response'
  );
}

/** Short human label for the operator log / event text. Never guesses. */
function judgeFailureLabel(reason: QCResult['heuristicReason']): string {
  switch (reason) {
    case 'provider-down':
      return 'provider UNREACHABLE (never answered)';
    case 'judge-empty-response':
      return 'judge answered but content was EMPTY (provider is UP)';
    case 'judge-malformed-response':
      return 'judge answered but content was UNPARSEABLE (provider is UP)';
    default:
      return 'judge produced no verdict';
  }
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

// ---------------------------------------------------------------------------
// QC-08 (operator decision) — the QC JUDGE runs on the CLIENT's OWN Ollama
// Cloud model, NEVER an operator/shared paid OpenAI/Google key, and NEVER the
// same model that wrote the content (JUDGE != WRITER). The prior OpenAI /
// Google operator-key scorers were removed so nothing can re-wire the judge to
// a shared paid key.
// ---------------------------------------------------------------------------

/**
 * True when a model id targets the client's Ollama Cloud provider — the ONLY
 * sanctioned QC-judge provider. Matches the registry shape `ollama-cloud/<m>`,
 * the legacy `ollama/<m>:cloud` shape, and a bare `<m>:cloud` tag (the ':cloud'
 * suffix is authoritative). Mirrors model-selector.tierOf()'s tier-1 detection.
 *
 * Exported (P1-05) so the fleet judge-proof probe (src/lib/probes/qc-judge-
 * probe.ts) shares this exact classification instead of re-deriving it —
 * single source of truth for "what counts as a client Ollama Cloud judge id".
 */
export function isOllamaCloudModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.trim().toLowerCase();
  return id.startsWith('ollama-cloud/') || id.includes(':cloud');
}

/**
 * Resolve the CLIENT-OWNED Ollama Cloud judge model. Sources, in order:
 *   1. the per-department QC agent's configured model (input.qcAgentModel)
 *   2. QC_JUDGE_MODEL (a client-configured judge model id)
 * Returns the id ONLY when it is an Ollama Cloud model; otherwise null so the
 * caller fails CLOSED (never an operator/shared paid key).
 */
function resolveClientJudgeModel(input: QCScorerInput): string | null {
  for (const c of [input.qcAgentModel, process.env.QC_JUDGE_MODEL]) {
    if (c && isOllamaCloudModel(c)) return c.trim();
  }
  return null;
}

/** Resolve the client's Ollama Cloud API key across all env/file/config stores. */
function resolveOllamaCloudApiKey(): string | null {
  try {
    const provider = getProvider('ollama-cloud');
    if (!provider) return null;
    const res = resolveProviderApiKey(provider);
    if ('found' in res && res.found && res.value) return res.value;
    return null;
  } catch {
    return null;
  }
}

/**
 * Score the task with the client's Ollama Cloud judge model (OpenAI-compatible
 * via the ollama-cloud connector). Returns null on any error so the caller can
 * treat it as provider-down (defer + retry). Temperature 0 for a stable verdict.
 */
async function llmScoreViaOllamaCloud(
  prompt: string,
  apiKey: string,
  judgeModelId: string,
): Promise<JudgeOutcome> {
  const maxTokens = resolveJudgeMaxTokens();
  const endpoint = getOllamaCloudChatEndpoint();

  // The connector wants the raw Ollama model name; strip the registry
  // 'ollama-cloud/' prefix but keep any ':cloud' tag (that IS the raw name).
  const rawModel = judgeModelId.startsWith('ollama-cloud/')
    ? judgeModelId.slice('ollama-cloud/'.length)
    : judgeModelId;

  // ── UNREACHABLE — and ONLY unreachable ─────────────────────────────────────
  // This try wraps the NETWORK CALL ALONE. It used to wrap the parse too, which
  // is how a perfectly healthy provider's reply got reported as an outage.
  let resp: ChatCompletionResponse;
  try {
    resp = await ollamaCloudChat(apiKey, {
      model: rawModel,
      messages: [
        { role: 'system', content: 'You are a precise QC agent. Reply only with valid JSON.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    });
  } catch (err) {
    const detail =
      `the judge at ${endpoint} never answered: ${(err as Error).message} ` +
      `(model "${judgeModelId}"). The provider is genuinely UNREACHABLE.`;
    console.warn(`[QCScorer] QC judge UNREACHABLE: ${detail}`);
    return { ok: false, kind: 'unreachable', detail };
  }

  // Past this line the provider ANSWERED. Whatever else goes wrong, it is NOT
  // down, and nothing below may ever say that it is.
  const choice = resp?.choices?.[0];
  const finishReason = choice?.finish_reason ?? '(none)';
  const completionTokens = resp?.usage?.completion_tokens;
  // Reasoning models return a third `reasoning` key beside content; it is billed
  // against the SAME completion budget. Not in the OpenAI-compatible interface,
  // so read it defensively — it is the single most diagnostic field we have.
  const message = choice?.message as
    | { role: string; content: string; reasoning?: string }
    | undefined;
  const raw = message?.content?.trim() ?? '';
  const budgetNote =
    `finish_reason=${finishReason}, completion_tokens=${completionTokens ?? 'unknown'}, ` +
    `max_tokens=${maxTokens}`;

  // ── EMPTY RESPONSE — the six-day bug, correctly named ─────────────────────
  if (!raw) {
    const reasoningChars = message?.reasoning?.length ?? 0;
    const detail =
      `the judge "${judgeModelId}" at ${endpoint} ANSWERED, but message.content was EMPTY ` +
      `(${budgetNote}, reasoning_chars=${reasoningChars}). THE PROVIDER IS UP — do not chase ` +
      `routing, addresses or credentials. On a REASONING model this is completion-budget ` +
      `starvation: the hidden reasoning field consumes the whole max_tokens budget and content ` +
      `arrives empty. Raise QC_JUDGE_MAX_TOKENS (default ${QC_JUDGE_MAX_TOKENS_DEFAULT}) or use a ` +
      `non-reasoning judge.`;
    console.warn(`[QCScorer] QC judge EMPTY RESPONSE (provider is UP, NOT down): ${detail}`);
    return { ok: false, kind: 'empty-response', detail };
  }

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // ── MALFORMED RESPONSE — never silently swallowed ─────────────────────────
  let parsed: { score: number; pass: boolean; reason: string; gaps: string[] };
  try {
    parsed = JSON.parse(cleaned) as typeof parsed;
  } catch (err) {
    // finish_reason=length is DEFINITIVE: the reply was cut off by the budget,
    // not malformed by the model. This is the "Unterminated string" signature.
    const truncated = finishReason === 'length';
    const detail =
      `the judge "${judgeModelId}" at ${endpoint} ANSWERED, but its content did not parse as ` +
      `JSON: ${(err as Error).message} (${budgetNote}, content_chars=${cleaned.length})` +
      (truncated
        ? `. finish_reason=length means the reply was CUT OFF by the completion budget — raise ` +
          `QC_JUDGE_MAX_TOKENS (default ${QC_JUDGE_MAX_TOKENS_DEFAULT}).`
        : `. The model returned a complete but non-JSON reply.`) +
      ` THE PROVIDER IS UP — do not chase routing, addresses or credentials.`;
    console.warn(`[QCScorer] QC judge MALFORMED RESPONSE (provider is UP, NOT down): ${detail}`);
    return { ok: false, kind: 'malformed-response', detail };
  }

  const score = typeof parsed.score === 'number' ? Math.max(1, Math.min(10, parsed.score)) : 5;
  return {
    ok: true,
    result: {
      score,
      pass: score >= QC_PASS_THRESHOLD,
      // QC-06: the reason is LLM-authored prose, not a deterministic verdict.
      // Mark it [model-stated] at the source so every downstream surface (board
      // event, Telegram, owner report) shows the owner it is the model's claim,
      // while the numeric score/criteria line stays the authoritative signal.
      reason: typeof parsed.reason === 'string' ? `[model-stated] ${parsed.reason}` : `Score: ${score.toFixed(1)}/10`,
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter((g) => typeof g === 'string') : [],
      scoringPath: 'llm',
    },
  };
}

// ---------------------------------------------------------------------------
// Main scorer
// ---------------------------------------------------------------------------

/**
 * Score a task for QC auto-approval.
 *
 * QC-08 (operator decision) — the QC JUDGE runs ONLY on the CLIENT's OWN Ollama
 * Cloud model. Resolution:
 *   1. client judge model = dept QC agent's model OR QC_JUDGE_MODEL, and it MUST
 *      be an Ollama Cloud model (ollama-cloud/… or a :cloud tag); else fail closed
 *   2. JUDGE != WRITER — judge model id must differ from input.writerModel
 *   3. client Ollama Cloud API key (OLLAMA_CLOUD_API_KEY / OLLAMA_API_KEY)
 *   4. no client judge configured → fail CLOSED to human review (heuristic
 *      'no-key'); NEVER an operator/shared paid OpenAI/Google key
 *
 * Falls back to heuristic on any judge error (never throws).
 */
export async function scoreTaskForQC(input: QCScorerInput): Promise<QCResult> {
  // QC-11: hard-fail if any fixture/simulate bypass env var is set in
  // production. Both QC_FIXTURE_JSON_PATH (below) and QC_SIMULATE_PROVIDER_DOWN
  // (further down) would otherwise let a canned "pass" verdict skip real
  // scoring on a live box. No-op in dev/test, so fixtures keep working there.
  assertNoFixtureEnvInProduction();

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

  // JUDGE-FAILURE vs FAIL-CLOSED: a heuristic fallback means one of two very
  // different things. If the client has NO Ollama Cloud judge model/key
  // configured, this box cannot auto-score → fail CLOSED to human review
  // ('no-key'); we NEVER borrow an operator/shared paid key. If a judge IS
  // configured but the call produced no verdict, DEFER and auto-rescore.
  //
  // The judge-failure branch reports the REAL failure — 'provider-down' ONLY
  // when the provider genuinely never answered, 'judge-empty-response' /
  // 'judge-malformed-response' when it answered and the fault is ours. Calling
  // an empty answer "provider-down" is what cost six days.
  //
  // QC_SIMULATE_PROVIDER_DOWN forces a genuine UNREACHABLE outage (when a judge
  // is configured) for a known outage window or deterministic tests.
  const simulateProviderDown =
    process.env.QC_SIMULATE_PROVIDER_DOWN === '1' ||
    process.env.QC_SIMULATE_PROVIDER_DOWN === 'true';

  // QC-08 (operator decision): the QC JUDGE runs on the CLIENT's OWN Ollama
  // Cloud model — NEVER an operator/shared paid OpenAI/Google key, and NEVER the
  // same model that WROTE the content (JUDGE != WRITER). Fail CLOSED to human
  // review when no client judge is configured; do not silently borrow a key.
  const failClosed = (why: string): QCResult => {
    const h = heuristicScore(input);
    // 'no-key' routes to human review and never auto-approves (see runQCOnReview
    // + QC-02 terminal escalation). It also benefits from the manual-promote lane.
    h.heuristicReason = 'no-key';
    h.reason = `QC judge unavailable — ${why}. Task held for human review; no operator/shared key is ever used as the judge. ${h.reason}`;
    console.warn(`[QCScorer] QC-08 fail-closed (no client judge): ${why}`);
    return h;
  };

  const judgeModel = resolveClientJudgeModel(input);
  if (!judgeModel) {
    return failClosed(
      'no client Ollama Cloud judge model configured (set the dept QC agent model or QC_JUDGE_MODEL to an ollama-cloud / :cloud model)',
    );
  }

  // JUDGE != WRITER: the judge model must differ from the model that wrote the
  // content it grades. Enforced whenever the writer model is known (optional).
  if (
    input.writerModel &&
    input.writerModel.trim().toLowerCase() === judgeModel.toLowerCase()
  ) {
    return failClosed(`judge model equals writer model (${judgeModel}) — JUDGE != WRITER violated`);
  }

  const ollamaKey = resolveOllamaCloudApiKey();
  if (!ollamaKey) {
    return failClosed('no client Ollama Cloud API key found (OLLAMA_CLOUD_API_KEY / OLLAMA_API_KEY)');
  }

  let failure: { kind: JudgeFailureKind; detail: string };
  if (simulateProviderDown) {
    failure = {
      kind: 'unreachable',
      detail: `QC_SIMULATE_PROVIDER_DOWN is set — a genuine provider outage is being simulated for judge "${judgeModel}".`,
    };
  } else {
    const outcome = await llmScoreViaOllamaCloud(prompt, ollamaKey, judgeModel);
    if (outcome.ok) return outcome.result;
    failure = { kind: outcome.kind, detail: outcome.detail };
  }

  // Judge IS configured and a key is present, but the call produced no verdict:
  // DEFER + auto-rescore, bounded, then escalate (see runQCOnReview). Carry the
  // TRUE failure forward — the deferral, the operator log and the escalation all
  // report what actually happened rather than a guessed category.
  const heuristic = heuristicScore(input);
  heuristic.heuristicReason = judgeKindToHeuristicReason(failure.kind);
  heuristic.judgeModel = judgeModel;
  heuristic.judgeEndpoint = getOllamaCloudChatEndpoint();
  heuristic.judgeFailureDetail = failure.detail;
  // heuristicScore() hard-codes "no LLM API key configured" in its reason — TRUE
  // on the no-key path, FALSE here: a client judge IS configured, it just failed.
  // Leaving it would append a lie to every deferral and escalation, flatly
  // contradicting the diagnosis above it. Same defect class as the six-day
  // mislabel, so it gets the same treatment: say what actually happened.
  heuristic.reason =
    `Heuristic QC fallback — a client judge IS configured, but the judge call produced no verdict ` +
    `(${judgeFailureLabel(heuristic.heuristicReason)}). Score: ${heuristic.score.toFixed(1)}/10. ` +
    `Human review required.`;
  return heuristic;
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
      // C3: match EVERY alias spelling of the role, not just CC's own.
      // Skill 23 seeds the research agent as role_type='deep-research'; this
      // resolver matched role_type='research' exactly, so those rows were
      // invisible — which is what convinced the seeder the slot was empty and made
      // it insert a duplicate. Migration 092 canonicalises the existing rows; this
      // keeps the resolver correct if Skill 23 writes the alias again.
      const aliases = Object.keys(TRIO_ROLE_ALIASES).filter(
        (a) => TRIO_ROLE_ALIASES[a] === roleType,
      );
      // An unknown role has no aliases, and `IN ()` is a SQLite syntax error.
      if (aliases.length === 0) return null;
      const placeholders = aliases.map(() => '?').join(',');

      // ORDER BY is load-bearing: a bare LIMIT 1 let SQLite return an ARBITRARY row
      // whenever duplicates existed, so the trio could resolve to a different agent
      // between calls. Oldest-then-id is stable and prefers the richer Skill-23 row.
      // 1. Direct workspace_id match
      if (workspaceId) {
        const row = queryOne<QCAgentRow>(
          `SELECT id, name, model FROM agents
            WHERE workspace_id = ? AND lower(role_type) IN (${placeholders})
            ORDER BY created_at ASC, id ASC LIMIT 1`,
          [workspaceId, ...aliases],
        );
        if (row) return row;
      }

      // 2. Canonical slug match via deptSlug
      if (deptSlug) {
        const canonical = canonicalDeptSlug(deptSlug);
        const row = queryOne<QCAgentRow>(
          `SELECT id, name, model FROM agents
            WHERE lower(workspace_id) = ? AND lower(role_type) IN (${placeholders})
            ORDER BY created_at ASC, id ASC LIMIT 1`,
          [canonical, ...aliases],
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
  /**
   * 'existence' | 'valid_image' | 'min_resolution' | 'vision_match'
   * | 'language_match' | 'numeric_fidelity' | 'custom'
   *
   * language_match (AF-LANG, v4.45.0): for presentation/deck/image deliverables,
   * the rendered text must be legible and in the expected (Latin/English) script.
   * Auto-fails on non-Latin/CJK/garbled glyphs so the deck is re-rendered.
   *
   * numeric_fidelity (AF-NUM, v4.46.0): for presentation/deck/image deliverables,
   * every money/currency amount that the render SHOWS must appear in (or be
   * consistent with) that deliverable's intended spec copy. Catches the slide-39
   * failure mode where a render fabricated per-line dollar figures ($1,197) that
   * are not in the spec copy and contradict other slides ($997). Fail-closed.
   *
   * spelling_fidelity (AF-SPELL, v4.47.0): for presentation/deck/image
   * deliverables, every WORD/acronym the render SHOWS must match the spec copy
   * spelling, a known acronym, or a common word. Catches the misspelled-acronym
   * failure mode where spec `ZHC` rendered as `ZCH` and AF-LANG passed it (the
   * glyphs were legible English). Fail-closed.
   *
   * pipeline_complete (AF-PIPELINE-COMPLETE, v4.48.0): for presentation/deck
   * deliverables, the Presentations-department pipeline records that PROVE the
   * deck went through research → copy → image QC → media-librarian GHL upload
   * must EXIST on disk before the deck task can move review→Done. Catches the
   * operator-shortcut failure mode (hand-fed slides.json → build_deck.py →
   * .pptx) that skipped research, the copy/image QC gates, and the GHL media
   * upload entirely. If those records are absent the deck is NOT done.
   * Fail-closed: a missing/unreadable run dir blocks (it cannot be PROVEN
   * complete). Required records: (1) a completed research brief, (2) a copy or
   * image QC log, (3) a GHL media-upload record (ghl_media_id / ghl_folder_id in
   * media_library.json).
   *
   * coverage (AF-COVERAGE, v4.49.0): for presentation/deck deliverables, the
   * assembled deck must NOT silently COMPRESS/cap the client's content. The
   * Director derives a content-driven slide_count_target from the source
   * (transcript/brief) and records it in the run dir's intake.json /
   * mission_prd.json. AF-COVERAGE reads that target plus any
   * client_requested_slide_cap and the deck's ACTUAL slide count, then:
   *   - FAILS when the actual count is materially BELOW the target (< 90%) AND
   *     no client_requested_slide_cap explains it (the builder under-produced).
   *   - FAILS when the target itself is implausibly low for a LARGE source
   *     (> ~1500 source lines and target < 20 slides) with NO cap on record
   *     (suspected upstream compression of the target).
   *   - PASSES when the deck meets/exceeds its content-driven target, OR when a
   *     client_requested_slide_cap is on record and the count honors it (an
   *     explicit client limit is allowed). Catches the failure mode where a
   *     ~2800-line transcript that warranted ~30-62 slides was compressed into
   *     12. Fail-closed: an unreadable/missing run dir or absent target blocks.
   */
  type: 'existence' | 'valid_image' | 'min_resolution' | 'vision_match' | 'language_match' | 'numeric_fidelity' | 'spelling_fidelity' | 'pipeline_complete' | 'coverage' | 'custom';
  /** Extra params: resolution threshold, vision prompt, expected language, etc. */
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

  // Detect image / deck tasks. Decks/presentations are artifact tasks too — they
  // ship rendered slide images + a .pptx and must carry the AF-LANG/AF-NUM/
  // AF-SPELL render gates AND (deck-only) the AF-PIPELINE-COMPLETE gate.
  const isImageTask =
    /\b(image|picture|photo|png|jpg|jpeg|gif|illustration|render|graphic|logo|banner|thumbnail|duck|draw|generate.*image|create.*image)\b/.test(text);
  const isDeckTask = describesDeckDeliverable(title, description ?? null);

  if (!isImageTask && !isDeckTask) {
    // Non-image / non-deck (document/work) task — no artifact criteria
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

  // AF-LANG language gate (v4.45.0): rendered text must be legible and in the
  // expected script (Latin/English unless the request asks otherwise). This
  // catches the garbled-CJK / mojibake failure mode where an image "passes"
  // vision_match on subject but renders unreadable text on the slide.
  const langMatch = /\b(spanish|french|german|portuguese|italian|chinese|mandarin|japanese|korean|arabic|hebrew|russian|hindi|cyrillic|in\s+(?:[a-z]+ese|[a-z]+ian))\b/.exec(text);
  const expectedLanguage = langMatch ? langMatch[0] : 'english';
  criteria.push({
    id: 'language_match',
    description: `Rendered text is legible and in the expected language/script (${expectedLanguage}); no garbled, mojibake, or unintended non-Latin/CJK glyphs`,
    type: 'language_match',
    params: { expectedLanguage },
  });

  // AF-NUM numeric-fidelity gate (v4.46.0): every money/currency amount that the
  // RENDER shows must appear in (or be consistent with) the intended spec copy.
  // This catches the slide-39 failure mode where a deck rendered fabricated
  // per-line dollar figures ($1,197 / $1,197 / $1,097) that are NOT in the spec
  // copy and CONTRADICT sibling slides ($997 / $997 / $1,497) — yet AF-LANG
  // passed because the glyphs were perfectly legible English. The spec copy is
  // the full intended brief for the deliverable (title + description); the OCR'd
  // render money tokens are diffed against it. Any rendered money amount not in
  // the spec is a HARD FAIL. Carries the spec copy so the comparison is
  // self-contained (no extra plumbing through the manifest).
  const specCopy = [title, description].filter(Boolean).join('\n');
  criteria.push({
    id: 'numeric_fidelity',
    description:
      'Every money/currency amount shown in the render appears in (or is consistent with) the intended spec copy; no fabricated or contradictory dollar figures',
    type: 'numeric_fidelity',
    params: { specCopy },
  });

  // AF-SPELL spelling/acronym gate (v4.47.0): every WORD/acronym the render shows
  // must match the spec copy spelling, a known acronym, or a common word. Catches
  // the misspelled-acronym failure mode (spec ZHC rendered as ZCH) that AF-LANG
  // passed because the glyphs were legible English and AF-NUM ignores non-money
  // tokens. Carries the same spec copy as AF-NUM so the OCR'd render words can be
  // diffed against the brief without extra plumbing.
  criteria.push({
    id: 'spelling_fidelity',
    description:
      'Every word/acronym shown in the render matches the intended spec copy spelling (case/emphasis-insensitive), a known acronym, or a common dictionary word; no misspelled or garbled words/acronyms',
    type: 'spelling_fidelity',
    params: { specCopy },
  });

  // AF-PIPELINE-COMPLETE pipeline-completeness gate (v4.48.0): for DECK /
  // PRESENTATION deliverables only, require the Presentations-department
  // pipeline records that PROVE the deck went through the real flow (research →
  // copy → image QC → media-librarian GHL upload). This catches the operator
  // shortcut (hand-fed slides.json → build_deck.py → .pptx) that bypassed the
  // entire pipeline: no research brief, no copy/image QC log, and no GHL media
  // upload. The required records are looked up on disk at evaluation time
  // (the run dir is resolved from the deck artifact path); if any is absent the
  // deck is NOT done. Fail-closed: an unreadable/missing run dir blocks too.
  if (describesDeckDeliverable(title, description ?? null)) {
    criteria.push({
      id: 'pipeline_complete',
      description:
        'Deck pipeline records present on disk: a completed research brief, a copy/image QC log, and a GHL media-upload record (ghl_media_id / ghl_folder_id in media_library.json). Absent records ⇒ deck is NOT done',
      type: 'pipeline_complete',
    });

    // AF-COVERAGE coverage gate (v4.49.0): for DECK / PRESENTATION deliverables
    // only, the assembled deck must honor the Director's content-driven
    // slide_count_target — it must NOT silently compress/cap the client's
    // content. The target + any client_requested_slide_cap + the source size
    // are read on disk at evaluation time (the run dir is resolved from the deck
    // artifact path), and the deck's ACTUAL slide count is taken from the
    // manifest. A materially-undersized deck with no client cap on record is a
    // HARD FAIL. Fail-closed: an unreadable/missing run dir or absent target
    // blocks (a compressed deck cannot be PROVEN complete).
    criteria.push({
      id: 'coverage',
      description:
        "Deck slide count honors the Director's content-driven slide_count_target (≥ 90% of target) — the deck does NOT silently compress/cap the client's content. An undersized deck with no client_requested_slide_cap on record ⇒ deck is NOT done",
      type: 'coverage',
    });
  }

  return criteria;
}

// ---------------------------------------------------------------------------
// AF-NUM — numeric / currency copy-fidelity gate (v4.46.0)
// ---------------------------------------------------------------------------

/**
 * Extract the SET of money/currency amounts from a block of text.
 *
 * Recognises `$1,197`, `$5,000`, `$5000`, `$2,500.00`, and the endpoints of a
 * range like `$150-$300` / `$150–$300`. Normalises every match to a plain
 * integer-or-decimal cents-free number string so that `$5,000`, `5000`, and
 * `$5000` all collapse to the SAME canonical token `5000`. Trailing `.00` is
 * dropped; genuine cents (e.g. `$2.50`) are preserved.
 *
 * Carve-out (documented): we compare the SET of MONEY amounts only — bare
 * percentages, plain counts, and years are intentionally NOT gated here, because
 * decks legitimately render structural/decorative digits (slide numbers, dates,
 * "5 steps") that never appear verbatim in the brief. Money is the high-signal,
 * high-blast-radius token class (it is what a client pays), so AF-NUM gates money
 * and leaves the broader numeric classes to vision_match / human review. The
 * helper is exported so the gate is unit-provable without a live vision call.
 */
export function extractMoneyTokens(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  // $-prefixed amounts, with optional thousands separators and optional decimals.
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const intPart = m[1].replace(/,/g, '');
    const decPart = m[2];
    out.add(normalizeMoney(intPart, decPart));
  }
  return out;
}

/** Canonicalise a money amount: strip commas, drop a trailing `.00`, keep real cents. */
function normalizeMoney(intPart: string, decPart?: string): string {
  const intNorm = String(parseInt(intPart, 10)); // strips leading zeros
  if (!decPart) return intNorm;
  const dec = decPart.replace(/0+$/, ''); // "00" -> "", "50" -> "5", "5" -> "5"
  return dec.length === 0 ? intNorm : `${intNorm}.${dec}`;
}

export interface NumericFidelityResult {
  /** true = every rendered money amount is present in the spec copy. */
  pass: boolean;
  /** Money amounts shown in the render that are ABSENT from the spec copy. */
  fabricated: string[];
  /** Money amounts found in the render (normalised). */
  renderMoney: string[];
  /** Money amounts found in the spec copy (normalised). */
  specMoney: string[];
  /** Human-readable verdict (used as the criterion reason). */
  explanation: string;
}

/**
 * Compare the money amounts a render SHOWS against the intended spec copy.
 *
 * RULE: every money amount in the render MUST appear in the spec copy. Any
 * rendered money amount absent from the spec is a HARD FAIL (it was fabricated,
 * or it contradicts the spec — e.g. render shows $1,197 while the spec says
 * $997). Spec amounts the render omits are NOT a failure here (a slide need not
 * show every price in the brief). False positives on legitimate spec numbers are
 * avoided because a render amount that literally appears in the spec passes; and
 * formatting differences ($5,000 == 5000 == $5000) are normalised away before
 * the set comparison.
 *
 * Pure + deterministic (no I/O) so the gate is unit-testable with a slide-39
 * style fixture (render has $1,197, spec has $997 ⇒ FAIL) and a clean fixture
 * (every render amount present in spec ⇒ PASS).
 */
export function compareNumericFidelity(renderText: string, specText: string): NumericFidelityResult {
  const renderSet = extractMoneyTokens(renderText);
  const specSet = extractMoneyTokens(specText);
  const fabricated = Array.from(renderSet).filter((amt) => !specSet.has(amt));
  const pass = fabricated.length === 0;
  const fmt = (s: Set<string>) => (s.size ? Array.from(s).map((a) => `$${a}`).join(', ') : '(none)');
  const explanation = pass
    ? `AF-NUM: all rendered money amounts present in spec copy (render: ${fmt(renderSet)}; spec: ${fmt(specSet)})`
    : `AF-NUM FAIL: rendered money amount(s) ${fabricated.map((a) => `$${a}`).join(', ')} not present in spec copy (spec has: ${fmt(specSet)}). Fabricated or contradictory dollar figure on the render — re-render using ONLY the prices in the spec copy.`;
  return {
    pass,
    fabricated,
    renderMoney: Array.from(renderSet),
    specMoney: Array.from(specSet),
    explanation,
  };
}

// ---------------------------------------------------------------------------
// AF-SPELL — spelling / acronym copy-fidelity gate (v4.47.0)
// ---------------------------------------------------------------------------
//
// Closes the gap exposed by a rendered deck slide that MISSPELLED an acronym
// (spec `ZHC` rendered as `ZCH`) and still passed QC: AF-LANG only checks that
// glyphs are legible English (ZCH is perfectly legible), and AF-NUM only gates
// money. There was no gate asserting that the WORDS the render shows actually
// match the words the spec asked for.
//
// RULE (fail-closed, mirrors AF-NUM):
//   - OCR every slide's rendered overlay TEXT (reuse the AF-LANG vision path).
//   - The slide's intended SPEC COPY (title + description) is the source of
//     truth for spelling.
//   - Every word/token the RENDER shows must EITHER (a) match a spec-copy token
//     (case- and typographic-emphasis-insensitive), OR (b) be a real dictionary
//     word, OR (c) be a known/real acronym on the allowlist.
//   - A render token that is NONE of those is a HARD FAIL — this catches KIE
//     garbling like spec `ZHC` rendered as `ZCH` (ZCH is not in the spec, not a
//     dictionary word, and not a known acronym).
//   - Proper nouns / brand names that ARE in the spec copy never fail (rule a).
//   - Real acronyms (ZHC, ZHW, KIE, GHL, AI, CEO, SOP, CTA, VSL, ROI) never
//     fail even if absent from the spec (rule c); but a MANGLED acronym that
//     diverges from the spec still fails (it is not on the allowlist).

/**
 * Known, real acronyms that are valid even when not present verbatim in the
 * spec copy. A MANGLED variant of one of these (e.g. ZCH for ZHC) is NOT on the
 * list and therefore still fails — that is the slide-misspelled-acronym catch.
 * Stored upper-cased; the comparison upper-cases render tokens before lookup.
 */
export const AF_SPELL_KNOWN_ACRONYMS = new Set<string>([
  'ZHC', 'ZHW', 'KIE', 'GHL', 'AI', 'CEO', 'SOP', 'CTA', 'VSL', 'ROI',
]);

/**
 * A small, high-frequency English stop/function-word + common-word list used to
 * avoid flagging ordinary English the render legitimately shows but that may not
 * appear verbatim in a terse spec brief (e.g. "the", "and", "your"). This is a
 * deliberately conservative dictionary: AF-SPELL's PRIMARY source of truth is
 * the spec copy; this list only prevents false positives on common connective
 * words. It is NOT a full dictionary — an unknown garbled token (ZCH) is the
 * failure we want, and it is not in here.
 */
const AF_SPELL_COMMON_WORDS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of',
  'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'this', 'that', 'these', 'those', 'it', 'its', 'we', 'you',
  'your', 'our', 'their', 'they', 'he', 'she', 'his', 'her', 'i', 'me', 'my',
  'us', 'them', 'all', 'any', 'each', 'every', 'no', 'not', 'so', 'than', 'too',
  'very', 'can', 'will', 'just', 'do', 'does', 'did', 'has', 'have', 'had',
  'how', 'what', 'when', 'where', 'who', 'why', 'which', 'get', 'got', 'more',
  'most', 'less', 'least', 'one', 'two', 'three', 'first', 'second', 'third',
  'new', 'now', 'here', 'there', 'up', 'down', 'out', 'over', 'under', 'into',
  'about', 'after', 'before', 'per', 'via', 'plus', 'free', 'best', 'top',
  'next', 'step', 'steps', 'page', 'slide', 'slides', 'yes', 'ok', 'okay',
  'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'time',
  'team', 'work', 'plan', 'plans', 'price', 'prices', 'pricing', 'start',
  'started', 'starter', 'pro', 'elite', 'annual', 'quarterly', 'monthly',
  'total', 'save', 'now', 'today', 'call', 'book', 'click', 'learn', 'see',
  'made', 'make', 'made', 'use', 'used', 'using', 'need', 'want', 'help',
]);

/**
 * Split a block of text into normalised word/token comparison keys.
 *
 * Normalisation:
 *   - lower-cased (case-insensitive comparison; AF-LANG already gates legibility)
 *   - typographic emphasis stripped: surrounding *, _, `, and matched quotes
 *   - trailing/leading punctuation removed (e.g. "ZHC." → "zhc", "(ROI)" → "roi")
 *   - internal apostrophes/hyphens kept so "client's" / "co-pilot" stay one token
 *   - purely numeric / money tokens are DROPPED (AF-NUM owns numbers)
 *
 * Tokens shorter than 2 characters (after normalisation) are dropped to avoid
 * noise on stray single letters.
 */
export function tokenizeForSpelling(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  // Split on whitespace first, then strip emphasis/punctuation per token so we
  // keep acronyms intact (ZHC) while dropping decoration.
  for (const rawTok of text.split(/\s+/)) {
    if (!rawTok) continue;
    // Strip leading/trailing non-alphanumeric (quotes, parens, *, _, `, punctuation).
    let t = rawTok.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');
    // Drop emphasis markers anywhere they wrap the token.
    t = t.replace(/^[*_`'"]+/, '').replace(/[*_`'"]+$/, '');
    if (!t) continue;
    // Skip money / pure-number tokens — AF-NUM owns numeric fidelity.
    if (/^\$?\d[\d,.\-–]*$/.test(t)) continue;
    // Must contain at least one letter to be a "word" we spell-check.
    if (!/[A-Za-z]/.test(t)) continue;
    const key = t.toLowerCase();
    if (key.length < 2) continue;
    out.push(key);
  }
  return out;
}

export interface SpellingFidelityResult {
  /** true = every rendered word token is justified (spec / dictionary / acronym). */
  pass: boolean;
  /** Render tokens that match NONE of: spec copy, common-word list, known acronym. */
  misspelled: string[];
  /** All render tokens (normalised). */
  renderTokens: string[];
  /** Human-readable verdict (used as the criterion reason). */
  explanation: string;
}

/**
 * Compare the words a render SHOWS against the intended spec copy.
 *
 * A render token PASSES when it is one of:
 *   (a) present in the spec copy tokens (case/emphasis-insensitive) — covers
 *       proper nouns, brand names, and real acronyms the spec actually used;
 *   (b) a known real acronym on AF_SPELL_KNOWN_ACRONYMS (case-insensitive);
 *   (c) a common English word on AF_SPELL_COMMON_WORDS.
 *
 * Otherwise the token is a misspelling/garble (HARD FAIL). This is exactly the
 * `ZHC`-rendered-as-`ZCH` case: ZCH is not in the spec, not a known acronym,
 * and not a common word → flagged. The spec acronym ZHC (rule a) and the broader
 * allowlist (rule b) ensure real acronyms are never false-flagged, while a
 * MANGLED acronym that diverges from the spec is caught.
 *
 * Pure + deterministic (no I/O) so the gate is unit-provable with a render-
 * misspells-vs-spec fixture (=> FAIL) and a clean fixture (=> PASS).
 */
export function compareSpellingFidelity(renderText: string, specText: string): SpellingFidelityResult {
  const renderTokens = tokenizeForSpelling(renderText);
  const specTokens = new Set(tokenizeForSpelling(specText));

  const misspelled: string[] = [];
  const seen = new Set<string>();
  for (const tok of renderTokens) {
    if (seen.has(tok)) continue;
    seen.add(tok);
    if (specTokens.has(tok)) continue;                 // (a) in the spec copy
    if (AF_SPELL_KNOWN_ACRONYMS.has(tok.toUpperCase())) continue; // (b) known acronym
    if (AF_SPELL_COMMON_WORDS.has(tok)) continue;      // (c) common English word
    misspelled.push(tok);
  }

  const pass = misspelled.length === 0;
  const explanation = pass
    ? `AF-SPELL: every rendered word matches the spec copy, a known acronym, or a common word (render tokens: ${renderTokens.length}, spec tokens: ${specTokens.size})`
    : `AF-SPELL FAIL: rendered token(s) ${misspelled.map((m) => `"${m}"`).join(', ')} do not match the spec copy spelling, any known acronym (${Array.from(AF_SPELL_KNOWN_ACRONYMS).join(', ')}), or a common word. This is a misspelled/garbled word or acronym (e.g. spec ZHC rendered as ZCH) — re-render using the EXACT spelling from the spec copy.`;

  return { pass, misspelled, renderTokens, explanation };
}

// ---------------------------------------------------------------------------
// AF-PIPELINE-COMPLETE — deck pipeline-completeness gate (v4.48.0)
// ---------------------------------------------------------------------------
//
// Closes the gap exposed by the operator shortcut: a deck was shipped by
// hand-feeding a slides.json into build_deck.py, which is ONLY the Phase-4
// renderer + a stripped Phase-8 assembler. That path bypassed essentially the
// entire Presentations pipeline — no research, no copy/image QC gates, and no
// media-librarian GHL upload — yet a technically-valid .pptx landed on disk and
// could be moved review→Done. AF-LANG/AF-NUM/AF-SPELL inspect rendered PIXELS;
// none of them prove the deck went through the pipeline. This gate does.
//
// RULE (fail-closed):
//   - Resolve the run dir from the deck artifact path (the directory the .pptx /
//     slide assets were written into, walking up to find the canonical workdir).
//   - Require ALL THREE pipeline records to be present on disk:
//       (1) a COMPLETED research brief — working/research/brief-*.md with a
//           research_complete:true marker (Deep Research SOP 9.1/9.4;
//           AF-RESEARCH-GATE).
//       (2) a COPY or IMAGE QC log — working/qc/copy_qc_report.json OR
//           working/qc/image_qc_report.json (QC SOP 9.1 / 9.3 gates).
//       (3) a GHL MEDIA-UPLOAD record — media_library.json carrying a
//           ghl_media_id and/or ghl_folder_id (Media Librarian SOP 9.2–9.4).
//   - If the run dir cannot be located or read, or ANY record is absent, the
//     deck is NOT done (block). A keyless install cannot bypass this — it is a
//     pure filesystem-presence check, no vision/LLM call.

export interface PipelineRecords {
  /** A completed research brief exists (working/research/brief-*.md, research_complete:true). */
  researchBriefComplete: boolean;
  /** A copy or image QC log exists (working/qc/copy_qc_report.json | image_qc_report.json). */
  qcLogPresent: boolean;
  /** A GHL media-upload record exists (media_library.json with ghl_media_id / ghl_folder_id). */
  ghlMediaUploadRecorded: boolean;
}

export interface PipelineCompletenessResult {
  /** true = all three required pipeline records are present. */
  pass: boolean;
  /** The specific missing records (human-readable), empty when pass. */
  missing: string[];
  /** Human-readable verdict (used as the criterion reason). */
  explanation: string;
}

/**
 * Decide whether a deck's pipeline records prove it went through the real flow.
 *
 * PURE + deterministic (no I/O) so the gate is unit-provable: pass a
 * fully-present record set ⇒ PASS; drop any one record ⇒ FAIL naming the gap.
 * The fail-closed default (an all-false record set when the run dir is missing)
 * therefore also fails here, which is the desired block.
 */
export function checkPipelineCompleteness(records: PipelineRecords): PipelineCompletenessResult {
  const missing: string[] = [];
  if (!records.researchBriefComplete) {
    missing.push('a completed research brief (working/research/brief-*.md with research_complete:true)');
  }
  if (!records.qcLogPresent) {
    missing.push('a copy/image QC log (working/qc/copy_qc_report.json or image_qc_report.json)');
  }
  if (!records.ghlMediaUploadRecorded) {
    missing.push('a GHL media-upload record (ghl_media_id / ghl_folder_id in media_library.json)');
  }

  const pass = missing.length === 0;
  const explanation = pass
    ? 'AF-PIPELINE-COMPLETE: deck pipeline records present — research brief, copy/image QC log, and GHL media-upload record all found on disk'
    : `AF-PIPELINE-COMPLETE FAIL: the deck is NOT done — missing ${missing.join('; ')}. ` +
      'This is the build_deck.py shortcut failure mode (a .pptx assembled without going through research, the QC gates, and the media-librarian GHL upload). ' +
      'Run the deck through the canonical Presentations pipeline (single entry point: the Director-orchestrated flow), do NOT hand-feed slides.json into build_deck.py.';
  return { pass, missing, explanation };
}

/**
 * Walk upward from a deck artifact path to find the canonical run/workdir, then
 * collect the pipeline-completeness records from disk. Returns an all-false
 * record set (which fails the gate) when no run dir can be located — fail-closed.
 *
 * A canonical run dir is recognised by containing a `working/` subtree (the
 * Presentations workdir layout: working/research, working/qc, working/copy,
 * working/checkpoints). We also accept the run dir itself directly holding
 * `media_library.json` (its checkpoint), as some flows seed it at the root.
 */
export function collectPipelineRecords(deckArtifactPath: string): PipelineRecords {
  const absent: PipelineRecords = {
    researchBriefComplete: false,
    qcLogPresent: false,
    ghlMediaUploadRecorded: false,
  };
  if (!deckArtifactPath) return absent;

  // Locate the run dir: walk up from the artifact's directory looking for a
  // `working/` subtree (or a media_library.json) within a bounded number of
  // parent hops, so we never escape to the filesystem root.
  let dir = path.dirname(path.resolve(deckArtifactPath));
  let runDir: string | null = null;
  for (let hops = 0; hops < 6; hops++) {
    try {
      if (
        existsSync(path.join(dir, 'working')) ||
        existsSync(path.join(dir, 'media_library.json')) ||
        existsSync(path.join(dir, 'working', 'checkpoints', 'media_library.json'))
      ) {
        runDir = dir;
        break;
      }
    } catch {
      /* ignore unreadable dir, keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  if (!runDir) return absent;

  const working = path.join(runDir, 'working');

  // (1) Completed research brief: any working/research/brief-*.md whose content
  //     carries a research_complete:true marker.
  let researchBriefComplete = false;
  try {
    const researchDir = path.join(working, 'research');
    // safeReaddirNames / safeReadFileUtf8 never block the sweep on a TCC-gated
    // artifact tree (returns [] / null instead of hanging forever).
    for (const f of safeReaddirNames(researchDir)) {
      if (/^brief-.*\.md$/i.test(f)) {
        const body = safeReadFileUtf8(path.join(researchDir, f));
        // tolerate whitespace / quoting variants: research_complete: true
        if (body && /research_complete["']?\s*[:=]\s*true/i.test(body)) {
          researchBriefComplete = true;
          break;
        }
      }
    }
  } catch { /* no research dir */ }

  // (2) Copy or image QC log present.
  let qcLogPresent = false;
  try {
    const qcDir = path.join(working, 'qc');
    qcLogPresent =
      existsSync(path.join(qcDir, 'copy_qc_report.json')) ||
      existsSync(path.join(qcDir, 'image_qc_report.json'));
  } catch { /* no qc dir */ }

  // (3) GHL media-upload record: media_library.json carrying a non-null/non-empty
  //     ghl_media_id and/or ghl_folder_id. Check both the checkpoint location and
  //     the run-dir root.
  let ghlMediaUploadRecorded = false;
  const mediaLibCandidates = [
    path.join(working, 'checkpoints', 'media_library.json'),
    path.join(runDir, 'media_library.json'),
  ];
  for (const candidate of mediaLibCandidates) {
    try {
      if (!existsSync(candidate)) continue;
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (hasGhlUpload(parsed)) {
        ghlMediaUploadRecorded = true;
        break;
      }
    } catch { /* missing/malformed media_library.json — treated as absent */ }
  }

  return { researchBriefComplete, qcLogPresent, ghlMediaUploadRecorded };
}

/**
 * True when a parsed media_library.json proves a GHL upload happened: a
 * top-level ghl_folder_id, or any ghl_media_id anywhere in the structure
 * (including the per-slide records array). A seed value of null / "" does NOT
 * count (that is the unset placeholder Media Librarian SOP 9.1 writes at Step 0).
 */
function hasGhlUpload(obj: unknown): boolean {
  if (obj === null || typeof obj !== 'object') return false;
  const rec = obj as Record<string, unknown>;
  const nonEmpty = (v: unknown): boolean =>
    v !== null && v !== undefined && v !== '' && !(typeof v === 'string' && v.trim() === '');
  if (nonEmpty(rec.ghl_folder_id) || nonEmpty(rec.ghl_media_id)) return true;
  // Recurse one level into arrays / nested objects (per-slide upload records).
  for (const value of Object.values(rec)) {
    if (Array.isArray(value)) {
      if (value.some((item) => hasGhlUpload(item))) return true;
    } else if (value !== null && typeof value === 'object') {
      if (hasGhlUpload(value)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// AF-COVERAGE — deck coverage / anti-compression gate (v4.49.0)
// ---------------------------------------------------------------------------
//
// Closes the gap exposed by a silently-COMPRESSED deck: a ~2800-line transcript
// that warranted ~30-62 slides was shortened to 12, yet the .pptx was
// technically valid, went through the pipeline, and rendered legible/correct
// text — so AF-LANG/AF-NUM/AF-SPELL/AF-PIPELINE-COMPLETE all passed and the deck
// could be moved review→Done. None of those gates count slides against the
// client's content. This gate does: it proves the deck did NOT under-cover the
// client's content versus the Director's content-driven target.
//
// RULE (fail-closed, objective, low-false-positive):
//   - Read the run dir's intake.json / mission_prd.json for the content-driven
//     `slide_count_target` and any `client_requested_slide_cap`.
//   - FAIL when the deck's ACTUAL slide count is materially BELOW the target
//     (< 90% of target) AND no client cap explains it (builder under-produced).
//   - FAIL when the target ITSELF is implausibly low for a LARGE source
//     (source > ~1500 lines AND target < 20 slides) with NO client cap on
//     record (suspected upstream compression of the target).
//   - PASS when actual ≥ 90% of target, OR when a client_requested_slide_cap is
//     on record and the actual count honors it (cap ≥ actual — an explicit
//     client limit is allowed).
//   - Fail-closed: an unreadable/missing run dir, or no target on record, blocks
//     (a compressed deck cannot be PROVEN to cover the content). No vision/LLM
//     call — a pure read of run-dir JSON + the manifest slide count.

/** Coverage inputs read from the run dir (Director's targets) + the deck. */
export interface CoverageInputs {
  /** Director's content-driven slide_count_target (intake/mission_prd). null = absent. */
  slideCountTarget: number | null;
  /** Explicit client_requested_slide_cap, when the client set one. null = none on record. */
  clientRequestedSlideCap: number | null;
  /** Source size signal (transcript/extract/brief line count). null = unknown. */
  sourceLineCount: number | null;
  /** The assembled deck's ACTUAL slide count. null = unknown (fail-closed). */
  actualSlideCount: number | null;
}

export interface CoverageResult {
  /** true = the deck honors its content-driven target (or an explicit client cap). */
  pass: boolean;
  /** Human-readable verdict (used as the criterion reason). */
  explanation: string;
}

/** Fraction of the target a deck must reach to NOT be a compression failure. */
export const AF_COVERAGE_MIN_RATIO = 0.9;
/** A source larger than this (lines) is treated as "long" for the implausible-target check. */
export const AF_COVERAGE_LARGE_SOURCE_LINES = 1500;
/** A content-driven target below this for a long source is suspected compression. */
export const AF_COVERAGE_MIN_PLAUSIBLE_TARGET = 20;

/**
 * Decide whether a deck's slide count honors the Director's content-driven
 * target (or an explicit client cap). PURE + deterministic (no I/O) so the gate
 * is unit-provable: a compressed deck (actual far below target, no cap) ⇒ FAIL;
 * a full-coverage deck (actual ≥ 90% of target) ⇒ PASS; a client-cap-honored
 * deck ⇒ PASS. Fail-closed when the target or actual count is unknown.
 */
export function checkCoverage(inputs: CoverageInputs): CoverageResult {
  const { slideCountTarget, clientRequestedSlideCap, sourceLineCount, actualSlideCount } = inputs;

  // Fail-closed: we cannot prove coverage without the deck's actual slide count.
  if (actualSlideCount === null || !Number.isFinite(actualSlideCount) || actualSlideCount <= 0) {
    return {
      pass: false,
      explanation:
        'AF-COVERAGE FAIL-CLOSED: cannot determine the assembled deck\'s actual slide count — ' +
        'the deck is NOT done (a compressed deck cannot be proven to cover the content).',
    };
  }

  // Explicit client cap on record: an intentional client limit is ALWAYS allowed,
  // provided the deck does not somehow exceed it. This is the sanctioned way a
  // deck may be smaller than its content-driven target.
  if (clientRequestedSlideCap !== null && Number.isFinite(clientRequestedSlideCap) && clientRequestedSlideCap > 0) {
    if (actualSlideCount <= clientRequestedSlideCap) {
      return {
        pass: true,
        explanation:
          `AF-COVERAGE: deck honors the client_requested_slide_cap (${actualSlideCount} slide(s) ≤ cap ${clientRequestedSlideCap}). ` +
          'Explicit client limit on record — allowed.',
      };
    }
    return {
      pass: false,
      explanation:
        `AF-COVERAGE FAIL: deck has ${actualSlideCount} slide(s), EXCEEDING the client_requested_slide_cap of ${clientRequestedSlideCap}. ` +
        'Rebuild to honor the client cap.',
    };
  }

  // Fail-closed: no content-driven target on record and no client cap ⇒ we cannot
  // prove the deck is not compressed. Block.
  if (slideCountTarget === null || !Number.isFinite(slideCountTarget) || slideCountTarget <= 0) {
    return {
      pass: false,
      explanation:
        'AF-COVERAGE FAIL-CLOSED: no content-driven slide_count_target on record (intake.json / mission_prd.json) ' +
        'and no client_requested_slide_cap — cannot prove the deck covers the client\'s content. The deck is NOT done.',
    };
  }

  // Suspected upstream compression of the TARGET: a long source but an
  // implausibly low content-driven target, with no client cap to explain it.
  if (
    sourceLineCount !== null &&
    Number.isFinite(sourceLineCount) &&
    sourceLineCount > AF_COVERAGE_LARGE_SOURCE_LINES &&
    slideCountTarget < AF_COVERAGE_MIN_PLAUSIBLE_TARGET
  ) {
    return {
      pass: false,
      explanation:
        `AF-COVERAGE FAIL: suspected compression — the source is large (${sourceLineCount} lines) yet the ` +
        `content-driven slide_count_target is only ${slideCountTarget} (< ${AF_COVERAGE_MIN_PLAUSIBLE_TARGET}) with no client_requested_slide_cap on record. ` +
        'A long transcript/brief warrants many more slides; re-derive the target from the full source and rebuild.',
    };
  }

  // Core anti-compression check: actual must be ≥ 90% of the content-driven target.
  const minRequired = Math.ceil(slideCountTarget * AF_COVERAGE_MIN_RATIO);
  if (actualSlideCount < minRequired) {
    const pct = ((actualSlideCount / slideCountTarget) * 100).toFixed(0);
    return {
      pass: false,
      explanation:
        `AF-COVERAGE FAIL: deck has ${actualSlideCount} slide(s) vs a content-driven slide_count_target of ${slideCountTarget} ` +
        `(${pct}% of target, below the ${(AF_COVERAGE_MIN_RATIO * 100).toFixed(0)}% floor of ${minRequired}) and NO client_requested_slide_cap on record. ` +
        "The builder silently compressed the client's content — rebuild to cover the full content-driven target " +
        '(or record an explicit client_requested_slide_cap if the client asked for fewer slides).',
    };
  }

  return {
    pass: true,
    explanation:
      `AF-COVERAGE: deck has ${actualSlideCount} slide(s), meeting/exceeding the content-driven slide_count_target of ${slideCountTarget} ` +
      `(≥ ${(AF_COVERAGE_MIN_RATIO * 100).toFixed(0)}% floor of ${minRequired}). No compression detected.`,
  };
}

/**
 * Resolve the canonical run dir from a deck artifact path and read the
 * coverage inputs (slide_count_target, client_requested_slide_cap, source size)
 * from intake.json / mission_prd.json. The actual slide count is supplied by the
 * caller (derived from the deck manifest). Returns all-null targets (which fail
 * the gate when no client cap is found) when no run dir can be located —
 * fail-closed.
 *
 * The target keys are looked up case-/style-tolerantly under several aliases so
 * a Director that writes `slide_count_target`, `slideCountTarget`, or a nested
 * `targets.slide_count_target` is all honored.
 */
export function collectCoverageInputs(
  deckArtifactPath: string,
  actualSlideCount: number | null,
): CoverageInputs {
  const absent: CoverageInputs = {
    slideCountTarget: null,
    clientRequestedSlideCap: null,
    sourceLineCount: null,
    actualSlideCount,
  };
  if (!deckArtifactPath) return absent;

  // Locate the run dir: walk up from the artifact's directory looking for a
  // run-dir marker (intake.json / mission_prd.json / a working/ subtree) within
  // a bounded number of parent hops, so we never escape to the filesystem root.
  let dir = path.dirname(path.resolve(deckArtifactPath));
  let runDir: string | null = null;
  for (let hops = 0; hops < 6; hops++) {
    try {
      if (
        existsSync(path.join(dir, 'intake.json')) ||
        existsSync(path.join(dir, 'mission_prd.json')) ||
        existsSync(path.join(dir, 'working'))
      ) {
        runDir = dir;
        break;
      }
    } catch {
      /* ignore unreadable dir, keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  if (!runDir) return absent;

  // Read intake.json + mission_prd.json (mission_prd overrides/augments intake).
  let slideCountTarget: number | null = null;
  let clientRequestedSlideCap: number | null = null;
  let sourceLineCount: number | null = null;

  for (const fname of ['intake.json', 'mission_prd.json']) {
    const candidate = path.join(runDir, fname);
    try {
      const rawIntake = safeReadFileUtf8(candidate);
      if (rawIntake == null) continue;
      const parsed = JSON.parse(rawIntake) as Record<string, unknown>;
      const t = readNumericKey(parsed, ['slide_count_target', 'slideCountTarget', 'target_slide_count']);
      if (t !== null) slideCountTarget = t;
      const cap = readNumericKey(parsed, [
        'client_requested_slide_cap',
        'clientRequestedSlideCap',
        'slide_cap',
        'requested_slide_cap',
      ]);
      if (cap !== null) clientRequestedSlideCap = cap;
      const src = readNumericKey(parsed, [
        'source_line_count',
        'sourceLineCount',
        'transcript_line_count',
        'source_lines',
      ]);
      if (src !== null) sourceLineCount = src;
    } catch {
      /* missing/malformed file — treat its keys as absent */
    }
  }

  // Fallback source-size signal: measure a source transcript/extract on disk if
  // the JSON did not carry an explicit count. Best-effort, bounded to the run dir.
  if (sourceLineCount === null) {
    sourceLineCount = measureSourceLineCount(runDir);
  }

  return { slideCountTarget, clientRequestedSlideCap, sourceLineCount, actualSlideCount };
}

/**
 * Read the first present key from `parsed` (top-level OR nested one level under a
 * `targets`/`slides` object) that parses to a positive finite number. Tolerates
 * numeric strings ("30"). Returns null when no alias is present/usable.
 */
function readNumericKey(parsed: Record<string, unknown>, aliases: string[]): number | null {
  const toNum = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  for (const key of aliases) {
    if (key in parsed) {
      const n = toNum(parsed[key]);
      if (n !== null) return n;
    }
  }
  // Look one level under common nesting containers.
  for (const container of ['targets', 'slides', 'plan', 'director']) {
    const nested = parsed[container];
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      const rec = nested as Record<string, unknown>;
      for (const key of aliases) {
        if (key in rec) {
          const n = toNum(rec[key]);
          if (n !== null) return n;
        }
      }
    }
  }
  return null;
}

/**
 * Best-effort source-size signal: find the largest plausible source artifact in
 * the run dir (a transcript/extract/brief) and return its line count. Bounded to
 * a handful of well-known locations so it is cheap and never escapes the run dir.
 * Returns null when no source artifact is found/readable.
 */
function measureSourceLineCount(runDir: string): number | null {
  const candidates = [
    path.join(runDir, 'transcript.txt'),
    path.join(runDir, 'transcript.md'),
    path.join(runDir, 'source.txt'),
    path.join(runDir, 'extract.txt'),
    path.join(runDir, 'working', 'transcript.txt'),
    path.join(runDir, 'working', 'extract.txt'),
    path.join(runDir, 'working', 'research', 'transcript.txt'),
    path.join(runDir, 'working', 'source', 'transcript.txt'),
  ];
  let maxLines: number | null = null;
  for (const candidate of candidates) {
    const body = safeReadFileUtf8(candidate);
    if (body == null) continue;
    const lines = body.split('\n').length;
    if (maxLines === null || lines > maxLines) maxLines = lines;
  }
  return maxLines;
}

/**
 * Count the slides an assembled deck actually contains, from the deliverable
 * manifest. Heuristic + deterministic (no decode): each valid slide IMAGE in the
 * manifest counts as one slide; if no per-slide images are present we cannot
 * count (returns null → the gate fails closed). The .pptx itself is not a slide.
 */
export function countDeckSlides(manifest: DeliverableManifestItem[]): number | null {
  const slideImages = manifest.filter(
    (m) => m.valid && m.type === 'image' && m.path && /\.(png|jpe?g|webp)$/i.test(m.path),
  );
  if (slideImages.length > 0) return slideImages.length;
  return null;
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
  /**
   * True when this criterion could NOT be evaluated on this box because no
   * vision-capable key is configured (a vision-dependent render gate on a
   * keyless install). A skipped criterion is EXCLUDED from the aggregate score
   * — it is neither a pass nor a counted failure — so a keyless box is judged on
   * the deterministic checks instead of silently failing QC on every image/deck.
   * `pass` stays false (the criterion was not verified), but it does not drag the
   * score below the gate. A vision key that IS present but errors still FAILS
   * CLOSED (skipped stays false) so a configured box is never passed blind.
   */
  skipped?: boolean;
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

  // Whether ANY vision-capable key is configured on this box. When none is, the
  // vision-dependent render gates (language / numeric / spelling fidelity) cannot
  // run here, so they are SKIPPED (excluded from the score) instead of counted as
  // failures — otherwise a keyless install silently fails artifact QC on every
  // image/deck. When a key IS present but a call errors, those gates still FAIL
  // CLOSED below (never passed blind).
  const hasVisionKey = !!(
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GEMINI_API_KEY
  );

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
        const subject = typeof c.params?.subject === 'string' ? c.params.subject : '';
        const visionResult = await visionMatchCheck(manifest, subject);
        if (visionResult === null) {
          // Not applicable / NO vision key configured — neutral skip (do NOT
          // penalise). This is the keyless-heuristic path, not an error.
          visionSkipped = true;
          results.push({
            id: c.id,
            description: c.description,
            pass: true, // skip = neutral (don't penalise)
            reason: 'Vision check skipped (no LLM key available) — criterion treated as pass',
          });
        } else if ('unverifiable' in visionResult) {
          // QC-05 FAIL-CLOSED: a vision key IS configured but the check errored,
          // so the subject match is UNVERIFIED. Block the criterion (this drops
          // the aggregate score below the 8.5 gate — see evaluateCriteria) rather
          // than passing blind. Distinct from the no-key neutral skip above, and
          // consistent with the fail-closed AF-LANG / AF-NUM / AF-SPELL gates.
          results.push({
            id: c.id,
            description: c.description,
            pass: false,
            reason:
              'AF-VISION FAIL-CLOSED: a vision key is configured but the vision-model check could not be ' +
              `completed (${visionResult.reason}), so the subject match is unverified. Blocking until a vision ` +
              'pass confirms the artifact depicts the required subject (auto-retries once the vision provider is reachable).',
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

      case 'language_match': {
        // AF-LANG language gate (v4.45.0). FAIL-CLOSED, unlike vision_match:
        //   - Strongest feasible check is a vision pass that reads the rendered
        //     text and confirms it is legible + in the expected language/script.
        //   - If NO vision key is available, we do NOT pass blind. We block the
        //     criterion (pass=false) with a re-render gap so a keyless install
        //     cannot auto-advance an image with garbled CJK/mojibake text.
        const expectedLanguage =
          typeof c.params?.expectedLanguage === 'string' ? c.params.expectedLanguage : 'english';
        const langResult = await visionLanguageCheck(manifest, expectedLanguage);
        if (langResult === null && !hasVisionKey) {
          // NO vision key on this box → the render-text gate cannot run here.
          // SKIP it (excluded from the score) so a keyless install is not silently
          // failed on every image/deck. pass stays false (unverified), but a
          // skipped criterion is not counted as a failure toward the 8.5 gate.
          visionSkipped = true;
          results.push({
            id: c.id,
            description: c.description,
            pass: false,
            skipped: true,
            reason:
              `AF-LANG skipped: no vision key configured, so rendered-text legibility/${expectedLanguage} ` +
              'could not be verified on this box — not counted toward the artifact score. Configure a ' +
              'vision-capable LLM key (OPENAI_API_KEY / GOOGLE_API_KEY) for QC to enforce this gate.',
          });
        } else if (langResult === null) {
          // A vision key IS configured but every call errored → FAIL CLOSED
          // (block until a vision pass confirms legible expected-language text).
          // This is the AF-LANG contract: never pass an unverifiable text deliverable.
          results.push({
            id: c.id,
            description: c.description,
            pass: false,
            reason:
              'AF-LANG FAIL-CLOSED: a vision key is configured but the vision-model check could not be ' +
              `completed, so rendered-text legibility/${expectedLanguage} is unverified. Blocking until a ` +
              'vision pass confirms the text is legible and in the expected language (auto-retries once the ' +
              'vision provider is reachable).',
          });
        } else {
          results.push({
            id: c.id,
            description: c.description,
            pass: langResult.legible,
            reason: langResult.legible
              ? `AF-LANG: rendered text legible and in ${expectedLanguage} (confidence ${(langResult.confidence * 100).toFixed(0)}%) — ${langResult.explanation}`
              : `AF-LANG FAIL: rendered text is NOT legible/expected-language (${langResult.explanation}). Re-render the deck/image with correct, legible ${expectedLanguage} text (no garbled glyphs, mojibake, or unintended CJK).`,
          });
        }
        break;
      }

      case 'numeric_fidelity': {
        // AF-NUM numeric-fidelity gate (v4.46.0). FAIL-CLOSED, like AF-LANG:
        //   - OCR every rendered slide and collect the money amounts shown.
        //   - Diff that set against the intended spec copy (carried in params).
        //   - Any rendered money amount NOT in the spec copy is a HARD FAIL
        //     (fabricated/contradictory — the slide-39 failure mode).
        //   - If NO vision key is available or every OCR call errored, we do NOT
        //     pass blind: the criterion fails (block) so a keyless install cannot
        //     auto-advance a deck whose numbers were never read.
        const specCopy = typeof c.params?.specCopy === 'string' ? c.params.specCopy : '';
        const ocr = await visionMoneyOCR(manifest);
        if (ocr === null && !hasVisionKey) {
          // NO vision key on this box → the numeric-fidelity gate cannot run.
          // SKIP it (excluded from the score); pass stays false (unverified).
          visionSkipped = true;
          results.push({
            id: c.id,
            description: c.description,
            pass: false,
            skipped: true,
            reason:
              'AF-NUM skipped: no vision key configured, so the rendered money amounts could not be read/verified ' +
              'on this box — not counted toward the artifact score. Configure a vision-capable LLM key ' +
              '(OPENAI_API_KEY / GOOGLE_API_KEY) for QC to enforce this gate.',
          });
        } else if (ocr === null) {
          // A vision key IS configured but every OCR call errored → FAIL CLOSED.
          results.push({
            id: c.id,
            description: c.description,
            pass: false,
            reason:
              'AF-NUM FAIL-CLOSED: a vision key is configured but the rendered numbers could not be read ' +
              '(every OCR call errored), so they are unverified against the spec copy. Blocking until a vision ' +
              'pass can read the rendered money amounts (auto-retries once the vision provider is reachable).',
          });
        } else {
          const cmp = compareNumericFidelity(ocr.renderText, specCopy);
          results.push({
            id: c.id,
            description: c.description,
            pass: cmp.pass,
            reason: cmp.pass
              ? cmp.explanation
              : `${cmp.explanation} (slide(s) read: ${ocr.slidesRead}).`,
          });
        }
        break;
      }

      case 'spelling_fidelity': {
        // AF-SPELL spelling/acronym gate (v4.47.0). FAIL-CLOSED, like AF-LANG/AF-NUM:
        //   - OCR every rendered slide and collect the literal overlay TEXT.
        //   - Diff the words in it against the intended spec copy (in params)
        //     via the pure compareSpellingFidelity(): any render word that is not
        //     in the spec, not a known acronym, and not a common word is a HARD
        //     FAIL (a misspelled/garbled word or acronym — the ZHC→ZCH case).
        //   - If NO vision key is available or every OCR call errored, we do NOT
        //     pass blind: the criterion fails (block) so a keyless install cannot
        //     auto-advance a deck whose rendered text was never read.
        const specCopy = typeof c.params?.specCopy === 'string' ? c.params.specCopy : '';
        const ocr = await visionTextOCR(manifest);
        if (ocr === null && !hasVisionKey) {
          // NO vision key on this box → the spelling-fidelity gate cannot run.
          // SKIP it (excluded from the score); pass stays false (unverified).
          visionSkipped = true;
          results.push({
            id: c.id,
            description: c.description,
            pass: false,
            skipped: true,
            reason:
              'AF-SPELL skipped: no vision key configured, so the rendered words could not be read/verified ' +
              'on this box — not counted toward the artifact score. Configure a vision-capable LLM key ' +
              '(OPENAI_API_KEY / GOOGLE_API_KEY) for QC to enforce this gate.',
          });
        } else if (ocr === null) {
          // A vision key IS configured but every OCR call errored → FAIL CLOSED.
          results.push({
            id: c.id,
            description: c.description,
            pass: false,
            reason:
              'AF-SPELL FAIL-CLOSED: a vision key is configured but the rendered text could not be read ' +
              '(every OCR call errored), so its spelling is unverified against the spec copy. Blocking until a ' +
              'vision pass can read the rendered words (auto-retries once the vision provider is reachable).',
          });
        } else {
          const cmp = compareSpellingFidelity(ocr.renderText, specCopy);
          results.push({
            id: c.id,
            description: c.description,
            pass: cmp.pass,
            reason: cmp.pass
              ? cmp.explanation
              : `${cmp.explanation} (slide(s) read: ${ocr.slidesRead}).`,
          });
        }
        break;
      }

      case 'pipeline_complete': {
        // AF-PIPELINE-COMPLETE pipeline-completeness gate (v4.48.0). FAIL-CLOSED,
        // no vision call: a pure filesystem-presence check that the deck went
        // through the real Presentations pipeline (research → copy/image QC →
        // media-librarian GHL upload). Resolve the run dir from the FIRST deck
        // artifact (.pptx/.pdf preferred, else any valid artifact) and collect
        // the three required records. Absent records ⇒ the deck is NOT done.
        const deckItem =
          manifest.find(
            (m) => m.valid && m.path && /\.(pptx|pdf|key)$/i.test(m.path),
          ) ?? manifest.find((m) => m.valid && m.path);
        if (!deckItem?.path) {
          // No locatable artifact path to anchor the run-dir search → block.
          results.push({
            id: c.id,
            description: c.description,
            pass: false,
            reason:
              'AF-PIPELINE-COMPLETE FAIL-CLOSED: no deck artifact path available to locate the pipeline run dir. ' +
              'Cannot prove the deck went through research / QC / GHL-upload — the deck is NOT done.',
          });
        } else {
          const records = collectPipelineRecords(deckItem.path);
          const cmp = checkPipelineCompleteness(records);
          results.push({
            id: c.id,
            description: c.description,
            pass: cmp.pass,
            reason: cmp.pass ? cmp.explanation : `${cmp.explanation} (run dir resolved from: ${deckItem.path}).`,
          });
        }
        break;
      }

      case 'coverage': {
        // AF-COVERAGE coverage / anti-compression gate (v4.49.0). FAIL-CLOSED,
        // no vision call: a pure read of the run-dir targets (intake.json /
        // mission_prd.json) + the deck's actual slide count from the manifest.
        // The deck must honor the Director's content-driven slide_count_target
        // (≥ 90%) OR an explicit client_requested_slide_cap; an undersized deck
        // with no cap on record is the silent-compression failure mode. Resolve
        // the run dir from the FIRST deck artifact (.pptx/.pdf preferred, else
        // any valid artifact). An absent target / unreadable run dir blocks.
        const deckItem =
          manifest.find(
            (m) => m.valid && m.path && /\.(pptx|pdf|key)$/i.test(m.path),
          ) ?? manifest.find((m) => m.valid && m.path);
        if (!deckItem?.path) {
          results.push({
            id: c.id,
            description: c.description,
            pass: false,
            reason:
              'AF-COVERAGE FAIL-CLOSED: no deck artifact path available to locate the pipeline run dir / read the ' +
              'slide_count_target. Cannot prove the deck covers the client\'s content — the deck is NOT done.',
          });
        } else {
          const actualSlideCount = countDeckSlides(manifest);
          const inputs = collectCoverageInputs(deckItem.path, actualSlideCount);
          const cmp = checkCoverage(inputs);
          results.push({
            id: c.id,
            description: c.description,
            pass: cmp.pass,
            reason: cmp.pass ? cmp.explanation : `${cmp.explanation} (run dir resolved from: ${deckItem.path}).`,
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

  // Score over the SCORED criteria only — vision gates skipped for lack of a key
  // are excluded so a keyless box is judged on its deterministic checks
  // (existence / valid_image / pipeline_complete / coverage) rather than silently
  // failing on every unverifiable render gate. Skipped criteria stay in `results`
  // (pass=false) for transparency; they are neither a pass nor a counted failure.
  const scored = results.filter((r) => !r.skipped);
  const passCount = scored.filter((r) => r.pass).length;
  const total = scored.length;
  const ratio = total > 0 ? passCount / total : 1;

  // Score: 10.0 for all (scored) pass, scales down proportionally.
  // Gate: all scored criteria must pass for ≥ 8.5 (the one "fail" criterion blocks).
  const allPass = scored.every((r) => r.pass);
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
 *
 * Three-way return (QC-05 discriminates no-key from an errored call):
 *   - { yes, confidence, explanation } — a real vision verdict.
 *   - null                             — the check is NOT APPLICABLE / cannot run
 *                                        for a benign reason (no subject, NO vision
 *                                        key configured, or no image to inspect).
 *                                        The caller treats this as a NEUTRAL SKIP —
 *                                        this is the keyless-heuristic path, not an
 *                                        error.
 *   - { unverifiable: true, reason }   — a vision key IS configured but the call
 *                                        errored (unreadable artifact / provider
 *                                        error / non-200). The caller FAILS CLOSED
 *                                        (never passes an unverified subject match),
 *                                        mirroring AF-LANG / AF-NUM / AF-SPELL.
 */
async function visionMatchCheck(
  manifest: DeliverableManifestItem[],
  subject: string,
): Promise<{ yes: boolean; confidence: number; explanation: string } | { unverifiable: true; reason: string } | null> {
  if (!subject.trim()) return null; // criterion not applicable — neutral skip

  const openAiKey = process.env.OPENAI_API_KEY;
  const googleKey =
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GEMINI_API_KEY;

  // NO-KEY path: a keyless box cannot run a vision check. This is a separate
  // heuristic, NOT an error — return null so the caller treats it as a neutral
  // skip. Fail-closed (below) applies ONLY when a key IS configured.
  if (!openAiKey && !googleKey) return null;

  // A vision key IS configured from here on. Any FAILURE below is an error that
  // must fail closed (QC-05) — never a silent pass of an unverified subject.

  // Find first valid image in manifest
  const imageItem = manifest.find((m) => m.valid && m.type === 'image' && m.path);
  if (!imageItem?.path) return null; // no image to inspect — existence criterion covers this; neutral

  // Read file as base64. safeReadFileBuffer never blocks on a TCC-gated artifact
  // path (returns null instead of hanging the sweep forever).
  const buf = safeReadFileBuffer(imageItem.path);
  if (!buf) {
    return {
      unverifiable: true,
      reason: `the artifact could not be read for subject verification (${imageItem.path})`,
    };
  }
  const b64: string = buf.toString('base64');

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

  // A vision key was configured but EVERY call failed / returned non-200.
  // Fail closed (QC-05): the subject match is unverified, so the caller must
  // NOT pass it blind.
  return {
    unverifiable: true,
    reason: 'every configured vision-model call failed (provider error / non-200 response)',
  };
}

/**
 * AF-LANG vision check (v4.45.0).
 *
 * Reads the rendered text in an image/deck deliverable and asks the vision LLM
 * whether ALL visible text is (a) legible (not garbled, not mojibake, no broken
 * glyphs / tofu boxes) and (b) in the expected language/script. Used for the
 * `language_match` criterion.
 *
 * Checks EVERY valid image in the manifest (a deck has many slides); if ANY
 * slide fails the legibility/language test, the whole criterion fails so the
 * deck is re-rendered.
 *
 * Returns:
 *   { legible: boolean, confidence, explanation }  — a real vision verdict, OR
 *   null  — when NO vision key is available or every call errored. The caller
 *           treats null as FAIL-CLOSED (block until verifiable), never as pass.
 *
 * Uses detail:'high' (OpenAI) / full-res inline data (Gemini) because reading
 * small slide text reliably needs the high-detail path.
 */
async function visionLanguageCheck(
  manifest: DeliverableManifestItem[],
  expectedLanguage: string,
): Promise<{ legible: boolean; confidence: number; explanation: string } | null> {
  const openAiKey = process.env.OPENAI_API_KEY;
  const googleKey =
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GEMINI_API_KEY;

  if (!openAiKey && !googleKey) return null;

  const imageItems = manifest.filter((m) => m.valid && m.type === 'image' && m.path);
  if (imageItems.length === 0) return null;

  const prompt = `You are checking the RENDERED TEXT in this image (e.g. a presentation slide).
Expected language/script: ${expectedLanguage} (Latin script unless the expected language uses another script).
Answer these questions about ALL visible text in the image:
  1. Is every piece of visible text legible — NOT garbled, NOT mojibake, NO broken/placeholder glyphs (tofu boxes □), NO random Unicode noise?
  2. Is the text in the expected language/script (no UNINTENDED Chinese/Japanese/Korean/other non-expected characters)?
"legible" must be true ONLY if BOTH are satisfied.
Reply with ONLY this JSON (no other text):
{"legible": <boolean>, "confidence": <0.0-1.0>, "explanation": "<one sentence naming any garbled/wrong-script text you saw>"}`;

  // Track whether at least one provider actually answered (so we can tell
  // "all calls errored" (→ null, fail-closed) from "a slide genuinely failed".
  let anyAnswered = false;
  let worst: { legible: boolean; confidence: number; explanation: string } | null = null;

  const recordVerdict = (v: { legible: boolean; confidence: number; explanation: string }) => {
    anyAnswered = true;
    // Worst-wins: any illegible slide fails the whole deck.
    if (worst === null || (worst.legible && !v.legible)) worst = v;
  };

  for (const imageItem of imageItems) {
    if (!imageItem.path) continue;
    // safeReadFileBuffer never blocks on a TCC-gated artifact path.
    const _imgBuf = safeReadFileBuffer(imageItem.path);
    if (!_imgBuf) continue;
    const b64: string = _imgBuf.toString('base64');
    const ext = imageItem.path.slice(imageItem.path.lastIndexOf('.') + 1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';

    let verdict: { legible: boolean; confidence: number; explanation: string } | null = null;

    // Try OpenAI vision first (gpt-4o-mini supports vision).
    if (openAiKey) {
      try {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiKey}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } },
              ],
            }],
            max_tokens: 120,
            temperature: 0,
          }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
          const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
          const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
          const parsed = JSON.parse(cleaned) as { legible: boolean; confidence: number; explanation: string };
          verdict = { legible: !!parsed.legible, confidence: Number(parsed.confidence) || 0.5, explanation: parsed.explanation ?? '' };
        }
      } catch { /* fall through to Google for this slide */ }
    }

    // Google Gemini vision fallback for this slide.
    if (!verdict && googleKey) {
      try {
        const model = process.env.QC_SCORER_MODEL || 'gemini-2.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${googleKey}`;
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
          const parsed = JSON.parse(cleaned) as { legible: boolean; confidence: number; explanation: string };
          verdict = { legible: !!parsed.legible, confidence: Number(parsed.confidence) || 0.5, explanation: parsed.explanation ?? '' };
        }
      } catch { /* slide errored on both providers */ }
    }

    if (verdict) {
      recordVerdict(verdict);
      // Short-circuit: a single illegible slide fails the whole deck.
      if (!verdict.legible) return verdict;
    }
  }

  // If no provider ever answered, fail-closed (null). Otherwise return the
  // worst verdict observed (all legible → legible:true).
  return anyAnswered ? worst : null;
}

/**
 * AF-NUM money OCR (v4.46.0).
 *
 * Reads EVERY valid image in the manifest and asks the vision LLM to transcribe
 * the literal currency/dollar amounts it can see on each slide. The transcribed
 * text from all slides is concatenated and returned; the caller diffs the money
 * tokens in it against the intended spec copy via compareNumericFidelity().
 *
 * The prompt asks ONLY for verbatim dollar amounts (not interpretation) so the
 * model behaves as an OCR pass, not a judge — the pass/fail decision is made
 * deterministically in compareNumericFidelity().
 *
 * Returns:
 *   { renderText, slidesRead } — the concatenated dollar amounts read, OR
 *   null — when NO vision key is available or every call errored. The caller
 *          treats null as FAIL-CLOSED (block until verifiable), never as pass.
 */
async function visionMoneyOCR(
  manifest: DeliverableManifestItem[],
): Promise<{ renderText: string; slidesRead: number } | null> {
  const openAiKey = process.env.OPENAI_API_KEY;
  const googleKey =
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GEMINI_API_KEY;

  if (!openAiKey && !googleKey) return null;

  const imageItems = manifest.filter((m) => m.valid && m.type === 'image' && m.path);
  if (imageItems.length === 0) return null;

  const prompt = `Transcribe EVERY currency / dollar amount that is VISIBLE in this image (e.g. a presentation slide).
List the amounts EXACTLY as printed (keep the $ sign, commas, decimals, and ranges like $150-$300).
Do NOT infer, calculate, or add amounts that are not literally shown. If none are visible, reply with an empty list.
Reply with ONLY this JSON (no other text):
{"amounts": ["$1,197", "$997"]}`;

  let anyAnswered = false;
  const collected: string[] = [];
  let slidesRead = 0;

  const parseAmounts = (raw: string): string[] | null => {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      const parsed = JSON.parse(cleaned) as { amounts?: unknown };
      if (Array.isArray(parsed.amounts)) {
        return parsed.amounts.filter((a): a is string => typeof a === 'string');
      }
      return [];
    } catch {
      return null;
    }
  };

  for (const imageItem of imageItems) {
    if (!imageItem.path) continue;
    // safeReadFileBuffer never blocks on a TCC-gated artifact path.
    const _imgBuf = safeReadFileBuffer(imageItem.path);
    if (!_imgBuf) continue;
    const b64: string = _imgBuf.toString('base64');
    const ext = imageItem.path.slice(imageItem.path.lastIndexOf('.') + 1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';

    let amounts: string[] | null = null;

    if (openAiKey) {
      try {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiKey}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } },
              ],
            }],
            max_tokens: 200,
            temperature: 0,
          }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
          amounts = parseAmounts(data.choices?.[0]?.message?.content?.trim() ?? '');
        }
      } catch { /* fall through to Google for this slide */ }
    }

    if (amounts === null && googleKey) {
      try {
        const model = process.env.QC_SCORER_MODEL || 'gemini-2.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${googleKey}`;
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
            generationConfig: { temperature: 0, maxOutputTokens: 256 },
          }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
          amounts = parseAmounts(data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '');
        }
      } catch { /* slide errored on both providers */ }
    }

    if (amounts !== null) {
      anyAnswered = true;
      slidesRead += 1;
      collected.push(...amounts);
    }
  }

  // No provider ever answered ⇒ fail-closed (null). Otherwise return the
  // concatenated amounts (may be empty string = render showed no money).
  return anyAnswered ? { renderText: collected.join(' '), slidesRead } : null;
}

/**
 * AF-SPELL text OCR (v4.47.0).
 *
 * Reads EVERY valid image in the manifest and asks the vision LLM to transcribe
 * the literal overlay TEXT it can see on each slide, verbatim, including any
 * acronyms. The transcribed text from all slides is concatenated and returned;
 * the caller diffs the word tokens in it against the intended spec copy via
 * compareSpellingFidelity().
 *
 * The prompt asks ONLY for verbatim transcription (not interpretation or
 * correction) so the model behaves as an OCR pass, not a judge — critically it
 * MUST transcribe a misspelling exactly as printed (ZCH, not "corrected" to ZHC),
 * otherwise the gate could never see the garble. The pass/fail decision is made
 * deterministically in compareSpellingFidelity().
 *
 * Reuses the same dual-provider vision path as AF-LANG / AF-NUM (OpenAI gpt-4o-mini
 * vision first, Gemini fallback), detail:'high' for reliable small-text reads.
 *
 * Returns:
 *   { renderText, slidesRead } — the concatenated transcribed text, OR
 *   null — when NO vision key is available or every call errored. The caller
 *          treats null as FAIL-CLOSED (block until verifiable), never as pass.
 */
async function visionTextOCR(
  manifest: DeliverableManifestItem[],
): Promise<{ renderText: string; slidesRead: number } | null> {
  const openAiKey = process.env.OPENAI_API_KEY;
  const googleKey =
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GEMINI_API_KEY;

  if (!openAiKey && !googleKey) return null;

  const imageItems = manifest.filter((m) => m.valid && m.type === 'image' && m.path);
  if (imageItems.length === 0) return null;

  const prompt = `Transcribe ALL text that is VISIBLE in this image (e.g. a presentation slide), EXACTLY as printed.
Copy every word, heading, label, and acronym LETTER-FOR-LETTER. Do NOT correct spelling, do NOT expand or fix acronyms, do NOT paraphrase — if a word is misspelled on the slide, transcribe the misspelling verbatim.
Reply with ONLY this JSON (no other text):
{"text": "<all visible text, space-separated, verbatim>"}`;

  let anyAnswered = false;
  const collected: string[] = [];
  let slidesRead = 0;

  const parseText = (raw: string): string | null => {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      const parsed = JSON.parse(cleaned) as { text?: unknown };
      return typeof parsed.text === 'string' ? parsed.text : '';
    } catch {
      return null;
    }
  };

  for (const imageItem of imageItems) {
    if (!imageItem.path) continue;
    // safeReadFileBuffer never blocks on a TCC-gated artifact path.
    const _imgBuf = safeReadFileBuffer(imageItem.path);
    if (!_imgBuf) continue;
    const b64: string = _imgBuf.toString('base64');
    const ext = imageItem.path.slice(imageItem.path.lastIndexOf('.') + 1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';

    let text: string | null = null;

    if (openAiKey) {
      try {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiKey}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } },
              ],
            }],
            max_tokens: 600,
            temperature: 0,
          }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
          text = parseText(data.choices?.[0]?.message?.content?.trim() ?? '');
        }
      } catch { /* fall through to Google for this slide */ }
    }

    if (text === null && googleKey) {
      try {
        const model = process.env.QC_SCORER_MODEL || 'gemini-2.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${googleKey}`;
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
            generationConfig: { temperature: 0, maxOutputTokens: 800 },
          }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
          text = parseText(data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '');
        }
      } catch { /* slide errored on both providers */ }
    }

    if (text !== null) {
      anyAnswered = true;
      slidesRead += 1;
      if (text) collected.push(text);
    }
  }

  // No provider ever answered ⇒ fail-closed (null). Otherwise return the
  // concatenated text (may be empty string = render showed no text).
  return anyAnswered ? { renderText: collected.join(' '), slidesRead } : null;
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

  // ── OWNER NOTIFICATION (OWNER-APPROVAL PENDING) ───────────────────────
  // Guaranteed board-side send: replaces the old TODO(telegram) seam.
  // The event above remains in the DB as the audit trail; this call is the
  // actual push.  Failure is logged and NEVER blocks the board transition.
  try {
    const artifactLine = artifactPath ? `\nArtifact ready: ${artifactPath}` : '';
    notifyOwner(
      `👀 Review needed: "${taskTitle}" passed QC criteria and is waiting for your approval.${artifactLine}\n\nApprove: PATCH ${approveUrl} {"status":"done"}\nRedo: PATCH ${approveUrl} {"status":"in_progress"}`,
    );
  } catch (notifyErr) {
    console.error('[QCScorer] owner-approval notify error (non-fatal):', (notifyErr as Error).message);
  }
  // ── End OWNER NOTIFICATION (OWNER-APPROVAL PENDING) ──────────────────
}

// ---------------------------------------------------------------------------
// B-U12 / U26 — producer-scorecard contract (QC-contract fix)
// ---------------------------------------------------------------------------

/** The producer-posted QC verdict, read off the newest `completed` activity. */
interface ProducerScorecard {
  activityId: string;
  qcGate: string | null;
  qcScore: number | null;
  qcPassed: boolean | null;
  scorecardPath: string | null;
  /** B-U11 (Page-QC v2) extension fields — read now, populated later. */
  pageQcScore: number | null;
  pageQcPassed: boolean | null;
}

/**
 * Read the newest `completed` task_activities row for a review card and, ONLY
 * when it carries the producer-scorecard contract (`qc_gate` present in its
 * metadata — the exact shape `cc_board.py:post_qc_score()` posts), return the
 * parsed verdict. Returns null when the newest completed activity carries no
 * such metadata (nothing posted, or the newest completed activity is
 * unrelated to QC) — the caller falls back to today's fully-independent scoring.
 */
function resolveProducerScorecard(taskId: string): ProducerScorecard | null {
  const row = queryOne<{ id: string; metadata: string | null }>(
    `SELECT id, metadata FROM task_activities
     WHERE task_id = ? AND activity_type = 'completed' AND metadata IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskId],
  );
  if (!row || !row.metadata) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !('qc_gate' in parsed)) return null;

  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  return {
    activityId: row.id,
    qcGate: str(parsed.qc_gate),
    qcScore: num(parsed.qc_score),
    qcPassed: bool(parsed.qc_passed),
    scorecardPath: str(parsed.scorecard_path),
    pageQcScore: num(parsed.page_qc_score),
    pageQcPassed: bool(parsed.page_qc_passed),
  };
}

/**
 * Fail-closed verification for a producer-posted `scorecard_path`: the file
 * must exist and be readable so the CC side can re-parse the verdict rather
 * than trust an unreadable/vanished path. Returns false on ANY problem — the
 * caller then falls back to today's independent-scoring behavior unchanged
 * (regression-safe: an unreadable scorecard never blocks or misroutes a card).
 */
function verifyProducerScorecardFile(scorecardPath: string): boolean {
  try {
    const resolved = scorecardPath.replace(/^~/, process.env.HOME || '');
    const raw = safeReadFileUtf8(resolved);
    if (!raw || raw.trim().length === 0) return false;
    // Best-effort re-parse: most scorecards are JSON (fab-qc.json / page-qc.json).
    // A parse failure does NOT fail the read — the contract only requires the
    // file exist + be readable; downstream comparison uses the metadata fields
    // already posted alongside it, not the file's internal structure.
    try {
      JSON.parse(raw);
    } catch {
      /* non-JSON scorecard body is still an honest, readable file */
    }
    return true;
  } catch {
    return false;
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
 * INDEPENDENT QC (v4.45.0): this function is the SOLE authority that scores a
 * task and advances it review→done. It ALWAYS re-scores from scratch against the
 * actual deliverables/criteria; it NEVER reads or trusts any builder-written
 * "qc-report" / self-asserted score. (No self-score is even ingested: the task
 * PATCH schema accepts no qc_score field, and task_qc_results is analytics-only,
 * read solely by grading.ts — never to gate the advance.) The builder is gated
 * out of the review→done transition at the PATCH route. So a builder that writes
 * its own grade has zero effect: the independent pass below is what runs.
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

    // QC-08: resolve the WRITER model (the content author's model) so the scorer
    // can enforce JUDGE != WRITER. Best-effort — null when the writer is unknown.
    const writerModel = task.assigned_agent_id
      ? (queryOne<{ model: string | null }>('SELECT model FROM agents WHERE id = ?', [task.assigned_agent_id])?.model ?? null)
      : null;

    // Fetch SOP if assigned
    let sopRow: SOPRowForQC | null = null;
    if (task.sop_id) {
      sopRow = queryOne<SOPRowForQC>(
        'SELECT id, name, success_criteria, steps, department FROM sops WHERE id = ? AND deleted_at IS NULL',
        [task.sop_id],
      ) ?? null;
    }

    // ── AF-I14 KIE.ai image-path guardrail ──────────────────────────────────────
    // MOVED: this gate now runs AFTER the artifact-registration checks below
    // (invariant A + the missing/invalid-file instant-fail), never before them.
    // It previously ran here, keyed on the TASK TITLE (describesImageOrDeckDeliverable),
    // so a task that shipped NOTHING (zero deliverables) or an unreachable file was
    // still reported as having "shipped an image/deck deliverable but no trace" —
    // a false claim that masked the real, structural gap (no artifact registered /
    // file not found). See the AF-I14 invocation after the manifest build.

    // ── Artifact-aware QC: build deliverable manifest (root-cause fix #10) ──────
    // Artifact-fulfillment is MANDATORY for artifact tasks.
    //
    // Design item #10 root-cause: the OLD path treated zero registered deliverables
    // as "no manifest → fall through to Mode-B (description text re-score)".
    // Mode-B grades the task DESCRIPTION against success_criteria, and a terse
    // brief ("create a picture of a blue duck") reliably scores below 8.5 → fail
    // → reroute loop → blocked after QC_MAX_REROUTES attempts.  The delivered
    // artifact was never inspected.
    //
    // THE FIX (two new invariants):
    //   A. If a task is an artifact task (detected via deriveAcceptanceCriteria)
    //      AND it reaches review with ZERO registered deliverables, that is a
    //      structural failure ("no artifact registered") — the agent forgot to
    //      register its output.  Return-to-orchestrator immediately; do NOT
    //      score the description and do NOT park in Blocked.
    //   B. If deliverables ARE registered, score the ARTIFACT against criteria.
    //      Mode-B (description-text scoring) is only reached for confirmed
    //      non-artifact (text/work) tasks.
    //
    // Fetch all file deliverables for this task and probe each one.
    interface DeliverableRow {
      id: string;
      title: string;
      path: string | null;
      deliverable_type: string;
    }
    let deliverableManifest: DeliverableManifestItem[] | null = null;
    // Detect artifact intent BEFORE manifest build so we can enforce invariant A.
    const artifactCriteriaForTitle = deriveAcceptanceCriteria(task.title, task.description);
    const isArtifactTask = artifactCriteriaForTitle.length > 0;

    try {
      const delivRows = queryAll<DeliverableRow>(
        `SELECT id, title, path, deliverable_type FROM task_deliverables WHERE task_id = ?`,
        [taskId],
      );
      // Accept every file-backed deliverable type the dispatcher actually
      // registers. The auto-dispatch prompt (task-dispatcher.ts) tells agents to
      // POST image/media deliverables as type 'artifact', not 'file', so filtering
      // on 'file' alone dropped them — the manifest came back empty and QC fell
      // back to the heuristic (capped at 8.0, never clears the 8.5 gate), parking
      // every image/file task in `review` forever. 'image' is included defensively.
      const FILE_BACKED_DELIVERABLE_TYPES = new Set(['file', 'artifact', 'image']);
      const fileRows = delivRows.filter((d) => FILE_BACKED_DELIVERABLE_TYPES.has(d.deliverable_type) && d.path);

      // ── Invariant A: artifact task with zero registered deliverables ─────────
      // Return-to-orchestrator: the agent completed execution without registering
      // any output file.  This is NOT a reroute loop increment — it is a
      // structural handback so the orchestrator can re-assign or request
      // artifact registration from the worker.
      if (isArtifactTask && fileRows.length === 0) {
        const noArtifactReason = 'No artifact registered: task reached review without any file deliverable in task_deliverables. The executing agent must register the output file before submitting for QC.';
        console.warn(`[QCScorer] Task "${task.title}" (${taskId}): artifact task with zero registered deliverables — return-to-orchestrator (NOT blocked)`);

        const now = new Date().toISOString();
        run(
          `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            'qc_review',
            taskId,
            `[QC-NO-ARTIFACT] No artifact registered — returning task to orchestrator. ${noArtifactReason} [path:artifact-mandatory]`,
            now,
          ],
        );

        // Call return-to-orchestrator endpoint internally (mirrors what worker agents
        // should call).  Sets status=backlog with structured handback note so the
        // ceo-delegation-sweep re-assigns correctly.  Does NOT increment the
        // QC reroute counter — this is an agent registration failure, not a
        // quality failure.
        // QC-09: the handback endpoint URL defaults to http://localhost:4000 when
        // MISSION_CONTROL_URL is unset. On a production box that default is almost
        // never reachable, so the fetch fails and the SQL fallback runs. Warn so
        // the misconfig is visible, and make the fallback write the SAME structured
        // handback (multi-line Problem/Tried/Needs/Suggested-dept note + a
        // task_returned audit event + a last_progress_at bump) the endpoint writes,
        // so the ceo-delegation-sweep can re-route correctly either way — instead
        // of the old degraded one-line `[QC-NO-ARTIFACT] <reason>` note.
        //
        // NOTE (cross-lane): the return-to-orchestrator endpoint ALSO increments
        // qc_reroute_attempts. This QC-scorer path is documented (above) as a
        // registration failure that must NOT consume a quality-reroute attempt, so
        // the SQL fallback deliberately leaves qc_reroute_attempts UNCHANGED. That
        // endpoint-increments-vs-scorer-does-not discrepancy predates this fix and
        // belongs to the return-to-orchestrator route owner to reconcile.
        const baseUrl = getMissionControlUrl();
        if (!process.env.MISSION_CONTROL_URL && process.env.NODE_ENV === 'production') {
          console.warn(
            `[QCScorer] MISSION_CONTROL_URL is unset in production — the return-to-orchestrator handback ` +
            `endpoint defaults to ${baseUrl}, which is likely unreachable; using the in-process SQL handback ` +
            `fallback (set MISSION_CONTROL_URL to silence this).`,
          );
        }

        // Structured handback note mirroring the return-to-orchestrator endpoint
        // format so the ceo-delegation-sweep reads the same diagnosis fields.
        const structuredHandbackNote = [
          `[QC-NO-ARTIFACT HANDBACK] ${now}`,
          `Problem: ${noArtifactReason}`,
          'Tried: QC auto-scorer attempted to evaluate the artifact but found zero registered deliverables in task_deliverables.',
          'Needs: The executing agent must register the output file via POST /api/tasks/[id]/deliverables before transitioning to review status.',
          task.department ? `Suggested dept: ${task.department}` : null,
        ]
          .filter(Boolean)
          .join('\n');

        const writeStructuredHandbackFallback = (): void => {
          // U99-RAW-STATUS-WRITER: compound single-row UPDATE (description +
          // last_progress_at must land atomically with the status flip, and
          // this is the in-process SQL fallback for when the HTTP handback to
          // return-to-orchestrator is unreachable/rejected); audited
          // immediately below via recordStatusEvent (DISP-10), gated on the
          // CAS actually landing.
          const fallbackRes = run(
            `UPDATE tasks SET status = 'backlog',
               description = CASE
                 WHEN description IS NULL OR description = '' THEN ?
                 ELSE ? || char(10) || char(10) || '---' || char(10) || char(10) || description
               END,
               last_progress_at = ?,
               updated_at = ?
             WHERE id = ? AND status = 'review'`,
            [structuredHandbackNote, structuredHandbackNote, now, now, taskId],
          );
          if ((fallbackRes.changes ?? 0) > 0) {
            recordStatusEvent(taskId, 'review', 'backlog', {
              actor: 'qc-scorer',
              reason: `no-artifact handback fallback: ${noArtifactReason}`,
            });
          }
          run(
            `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              'task_returned',
              taskId,
              `[RETURN] ${noArtifactReason} — suggests: ${task.department ?? 'general'}`,
              now,
            ],
          );
        };

        try {
          const handbackBody = {
            problem: noArtifactReason,
            what_i_tried: 'QC auto-scorer attempted to evaluate the artifact but found zero registered deliverables in task_deliverables.',
            what_i_think_it_needs: 'The executing agent must register the output file via POST /api/tasks/[id]/deliverables before transitioning to review status.',
            suggested_department: task.department ?? null,
            returned_by_agent_id: null,
          };
          // AUTH (SWEEP-401): server-side loopback to our own /api — no same-origin
          // Origin, so middleware Gate B 401s a POST without the bearer. Present it,
          // else this ALWAYS fell through to writeStructuredHandbackFallback() (below)
          // on a 401 rather than a genuine failure. Same class as stale-task-sweep.
          const returnResp = await fetch(`${baseUrl}/api/tasks/${taskId}/return-to-orchestrator`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...missionControlAuthHeaders() },
            body: JSON.stringify(handbackBody),
          });
          if (!returnResp.ok) {
            // Endpoint reachable but rejected/failed — write the structured handback directly.
            writeStructuredHandbackFallback();
            console.warn(`[QCScorer] return-to-orchestrator returned ${returnResp.status} — wrote structured handback directly`);
          }
        } catch (returnErr) {
          // Endpoint unreachable — write the structured handback directly.
          writeStructuredHandbackFallback();
          console.warn('[QCScorer] return-to-orchestrator call failed (non-fatal) — wrote structured handback directly:', (returnErr as Error).message);
        }

        return {
          score: 0,
          pass: false,
          reason: noArtifactReason,
          gaps: ['no artifact registered'],
          scoringPath: 'llm',
        };
      }
      // ── End invariant A ──────────────────────────────────────────────────────

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
          // U99-RAW-STATUS-WRITER: compound single-row UPDATE (description +
          // qc_reroute_attempts must land atomically with the status flip);
          // audited immediately below via recordStatusEvent (DISP-10), gated
          // on the CAS actually landing.
          const missingRes = run(
            `UPDATE tasks SET status = 'backlog',
               description = CASE WHEN description IS NULL OR description = '' THEN ? ELSE description || char(10) || char(10) || ? END,
               qc_reroute_attempts = ?, updated_at = ?
             WHERE id = ? AND status = 'review'`,
            [kickbackNote, kickbackNote, newAttempts, now, taskId],
          );
          if ((missingRes.changes ?? 0) > 0) {
            recordStatusEvent(taskId, 'review', 'backlog', { actor: 'qc-scorer', reason: kickbackNote });
          }
          return failResult;
        }
      }
    } catch (manifestErr) {
      // Non-fatal: if manifest building errors, fall back to text-only scoring.
      console.warn('[QCScorer] Deliverable manifest build failed (non-fatal):', (manifestErr as Error).message);
      deliverableManifest = null;
    }
    // ── End artifact manifest ─────────────────────────────────────────────────

    // ── AF-I14: KIE.ai image-path guardrail (fleet-wide for image/deck work) ─────
    // Runs AFTER the artifact-registration checks above (invariant A + the
    // missing/invalid instant-fail), so it only ever fires for a task that
    // ACTUALLY shipped a valid image/deck deliverable — never for a zero- or
    // missing-deliverable task (those are already handled with their own,
    // truthful gaps). Auto-fails the image phase when the session trace shows the
    // builder used the native image_generate tool (openai-image-gen skill) instead
    // of the mandated kie_generate.py script, or called the dead endpoint
    // /api/v1/image/gpt-image, or produced no KIE.ai API activity at all.
    //
    // Scope: the KIE.ai mandate is fleet-wide for image/deck DELIVERABLES, so
    // VIOLATION-A/B/C are detected whenever such a deliverable ships AND a session
    // trace exists. The fail-CLOSED "no trace found ⇒ VIOLATION-C" branch, however,
    // only applies where an exec trace is actually expected/recorded — the
    // Presentations KIE.ai pipeline. On any other box the absence of a trace is not
    // evidence of a violation (the runtime may not record OpenClaw sessions at all),
    // so a legitimate, independently-QC'd artifact is not blocked by fail-close.
    const hasImageOrDeckIntent = describesImageOrDeckDeliverable(task.title, task.description);
    const shippedValidImageOrDeck =
      !!deliverableManifest && deliverableManifest.some((m) => m.valid);
    if (hasImageOrDeckIntent && shippedValidImageOrDeck) {
      const deptCanon = task.department
        ? canonicalDeptSlug(task.department) || task.department.toLowerCase()
        : null;
      const isPresScope =
        (deptCanon ? AF_I14_DEPTS.has(deptCanon) : false) ||
        (task.assigned_agent_id ? AF_I14_AGENT_IDS.has(task.assigned_agent_id) : false);
      const afi14 = runAFI14Guardrail(
        taskId,
        task.assigned_agent_id,
        task.department,
        true, // an image/deck deliverable was actually shipped
        isPresScope, // fail-CLOSED on a missing trace only inside the pipeline scope
      );
      if (afi14.violated) {
        const afi14Msg = `[QC-AF-I14] AF-I14 image-path guardrail FAIL — ${afi14.violations.length} violation(s) in session ${afi14.sessionId ?? 'unknown'}. Violations: ${afi14.violations.join(' | ')}`;
        console.warn(`[QCScorer] Task "${task.title}" (${taskId}): AF-I14 violation — instant fail`);

        const nowAf = new Date().toISOString();
        run(
          `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
          [uuidv4(), 'qc_review', taskId, afi14Msg, nowAf],
        );

        // Increment reroute counter and return task to backlog
        const prevAttempts = task.qc_reroute_attempts ?? 0;
        const newAttempts = prevAttempts + 1;
        const kickbackNote = `[QC-AF-I14 FAIL] AF-I14 violations (attempt ${newAttempts}/${QC_MAX_REROUTES}): ${afi14.violations.join('; ')}`;
        // U99-RAW-STATUS-WRITER: compound single-row UPDATE (description +
        // qc_reroute_attempts must land atomically with the status flip);
        // audited immediately below via recordStatusEvent (DISP-10), gated on
        // the CAS actually landing.
        const afi14Res = run(
          `UPDATE tasks SET status = 'backlog',
             description = CASE WHEN description IS NULL OR description = '' THEN ? ELSE description || char(10) || char(10) || ? END,
             qc_reroute_attempts = ?, updated_at = ?
           WHERE id = ? AND status = 'review'`,
          [kickbackNote, kickbackNote, newAttempts, nowAf, taskId],
        );
        if ((afi14Res.changes ?? 0) > 0) {
          recordStatusEvent(taskId, 'review', 'backlog', { actor: 'qc-scorer', reason: kickbackNote });
        }

        return {
          score: 1.0,
          pass: false,
          reason: `AF-I14 guardrail: ${afi14.violations.length} image-path mandate violation(s) detected in session trace.`,
          gaps: afi14.violations,
          scoringPath: 'llm',
        };
      }
      if (afi14.traceFound) {
        console.log(`[QCScorer] AF-I14 guardrail PASS for task "${task.title}" (session: ${afi14.sessionId ?? 'unknown'}) — KIE.ai path confirmed, no native image_generate calls detected`);
      }
    }
    // ── End AF-I14 guardrail ──────────────────────────────────────────────────

    // §4 Criteria-based scoring for artifact tasks.
    // Invariant B: if deliverableManifest is non-empty, score the ARTIFACT.
    // Mode-B (description text re-score) is only reached for confirmed
    // non-artifact (text/work) tasks where isArtifactTask=false.
    let result: QCResult;
    const now = new Date().toISOString();

    // ── B-U12 / U26: resolve a producer-posted scorecard up front ─────────────
    // Fail-closed: a `scorecard_path` that exists in the metadata but is
    // unreadable disables the branch entirely for this pass — todays fully
    // independent scoring runs unchanged (regression-safe fallback).
    const producerScorecard = isQCProducerScorecardEnabled() ? resolveProducerScorecard(taskId) : null;
    let useProducerConfirmation = false;
    if (producerScorecard) {
      if (producerScorecard.scorecardPath) {
        useProducerConfirmation = verifyProducerScorecardFile(producerScorecard.scorecardPath);
        if (!useProducerConfirmation) {
          console.warn(
            `[QCScorer] Task "${task.title}" (${taskId}): producer scorecard_path unreadable ` +
            `(${producerScorecard.scorecardPath}) — falling back to independent scoring for this pass.`,
          );
        }
      } else {
        // Score/gate posted with no attached scorecard file — still a valid
        // producer verdict (post_qc_score allows a passed-only emission).
        useProducerConfirmation = true;
      }
    }

    if (deliverableManifest && deliverableManifest.length > 0) {
      // Artifact mode: use the pre-computed criteria (derived above for invariant A).
      const criteria = artifactCriteriaForTitle;

      if (criteria.length > 0) {
        // Evaluate criteria checklist
        const criteriaResult = await evaluateCriteria(criteria, deliverableManifest);

        // Skipped criteria (vision gates with no key) are neither passes nor
        // counted failures, so they are excluded from the gap list — they must not
        // appear as blocking gaps on an otherwise-passing keyless artifact.
        const failedCriteria = criteriaResult.results.filter((r) => !r.pass && !r.skipped);
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
        // → score against SOP rubric with the manifest for context (Mode A prompt)
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
          writerModel,
          deliverableManifest: deliverableManifest,
        };
        result = await scoreTaskForQC(input);
      }
    } else if (useProducerConfirmation && producerScorecard) {
      // ── B-U12 / U26: producer-scorecard confirmation (no evidence tree) ──────
      // A non-artifact / no-manifest task with a producer scorecard already
      // posted: per the ratified contract fix, this does NOT run "a fresh
      // description-based rubric" (Mode-B) — the description-only heuristic adds
      // no signal beyond what the producer's own gate already scored. The
      // producer's posted verdict IS the build-side evidence; it is taken as
      // read (never independently re-derived from the task description here).
      const producerVal = producerScorecard.qcScore;
      const producerPass =
        producerScorecard.qcPassed ?? (producerVal !== null ? producerVal >= QC_PASS_THRESHOLD : null);
      result = {
        score: producerVal ?? (producerPass ? QC_PASS_THRESHOLD : 0),
        pass: producerPass ?? false,
        reason:
          `Producer scorecard read directly (gate=${producerScorecard.qcGate ?? 'unknown'}` +
          `${producerVal !== null ? `, score=${producerVal.toFixed(1)}/10` : ''}) — ` +
          `no independent evidence tree for this task; description-rubric re-score skipped per B-U12.`,
        gaps: producerPass ? [] : [`producer gate "${producerScorecard.qcGate ?? 'unknown'}" reported FAIL`],
        scoringPath: 'llm',
      };
      console.log(
        `[QCScorer] Task "${task.title}" (${taskId}): producer-scorecard confirmation path (gate=` +
        `${producerScorecard.qcGate ?? 'unknown'}) — score ${result.score.toFixed(1)}/10 (${result.pass ? 'PASS' : 'FAIL'})`,
      );
    } else {
      // ── Mode B: document/work task (confirmed non-artifact) ───────────────────
      // Only reached when isArtifactTask=false (deriveAcceptanceCriteria returned
      // empty).  Artifact tasks with zero deliverables were already handled above
      // by invariant A (return-to-orchestrator) and never reach this branch.
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
        writerModel,
        deliverableManifest: null,
      };
      result = await scoreTaskForQC(input);
    }

    // ── B-U12 / U26: producer/judge agreement check + both-gates rule ─────────
    // Only meaningful when a producer scorecard was resolved AND the CC side
    // produced a real evidence-grounded score ('llm' — Mode A's evaluateCriteria/
    // scoreTaskForQC-with-manifest, or the producer-confirmation branch just
    // above). Heuristic/no-criteria paths have no independent score to compare.
    if (useProducerConfirmation && producerScorecard && result.scoringPath === 'llm') {
      const producerVal = producerScorecard.qcScore;
      const producerPass = producerScorecard.qcPassed;
      let disagreement = false;
      let diffNote = '';

      if (producerVal !== null) {
        const diff = Math.abs(result.score - producerVal);
        diffNote = ` (producer=${producerVal.toFixed(1)}, judge=${result.score.toFixed(1)}, diff=${diff.toFixed(1)})`;
        if (diff > QC_DISAGREEMENT_THRESHOLD) disagreement = true;
      } else if (producerPass !== null && producerPass !== result.pass) {
        diffNote = ` (producer=${producerPass ? 'PASS' : 'FAIL'}, judge=${result.pass ? 'PASS' : 'FAIL'})`;
        disagreement = true;
      }

      if (disagreement) {
        // HOLD, never a silent kickback: write exactly one qc_disagreement
        // event and return WITHOUT touching task status — the card stays
        // visibly in `review` for a human to resolve.
        const disagreementMsg =
          `[QC-DISAGREEMENT] Producer scorecard (gate=${producerScorecard.qcGate ?? 'unknown'}) and the ` +
          `Command Center judge disagree${diffNote} — HELD in review for human resolution.`;
        run(
          `INSERT INTO events (id, type, task_id, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            'qc_disagreement',
            taskId,
            disagreementMsg,
            JSON.stringify({
              qc_gate: producerScorecard.qcGate,
              producer_score: producerVal,
              producer_passed: producerPass,
              judge_score: result.score,
              judge_passed: result.pass,
            }),
            now,
          ],
        );
        console.warn(`[QCScorer] Task "${task.title}" (${taskId}): qc_disagreement — HELD in review${diffNote}`);
        return {
          ...result,
          pass: false,
          reason: disagreementMsg,
          gaps: [...result.gaps, `qc_disagreement: producer/judge verdict mismatch${diffNote}`],
        };
      }

      // Agreement (or nothing to disagree on) — tag the confirmation path so
      // the downstream [QC-AUTO] event carries proof this was NOT a fresh
      // description-rubric re-score.
      result = {
        ...result,
        reason: `[producer-confirmed gate=${producerScorecard.qcGate ?? 'unknown'}${diffNote}] ${result.reason}`,
      };

      // Comms both-gates rule: for a funnel/web-development source card, a
      // Page-QC FAIL (once B-U11 ships and posts page_qc_passed) blocks
      // promotion even when the producer's own gate (FAB-QC) PASSED. Inert
      // today — no producer posts page_qc_passed yet — additive + ready.
      const deptSlug = task.department ? (canonicalDeptSlug(task.department) || task.department) : null;
      if (
        result.pass &&
        deptSlug &&
        QC_BOTH_GATES_DEPARTMENTS.has(deptSlug) &&
        producerScorecard.pageQcPassed === false
      ) {
        result = {
          ...result,
          pass: false,
          reason:
            `${result.reason} — both-gates rule: Page-QC FAILED ` +
            `(page_qc_score=${producerScorecard.pageQcScore ?? 'n/a'}); FAB-QC PASS alone is insufficient ` +
            `for a ${deptSlug} card.`,
          gaps: [...result.gaps, 'page_qc_failed'],
        };
      }
    }
    // ── End producer/judge agreement check + both-gates rule ──────────────────

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

      // ── Judge-failure deferral (Point 6 fix 1) ────────────────────────────
      // A scoring key IS configured but the judge produced no verdict → hold in
      // `review` with a DISTINCT [QC-DEFERRED-PROVIDER-DOWN] marker (never
      // [QC-HEURISTIC]) so the task is NOT presented as human-required. The
      // qc-review-sweep retries deferred tasks on a short cadence and auto-
      // rescores them the moment the judge works again (an `llm` score then
      // drives the normal pass / fail / reroute path). This is what prevents a
      // human-escalation storm on a genuine blip.
      //
      // NOTE the marker token is a LEGACY LANE KEY, not a diagnosis. It is kept
      // verbatim because live boards already carry these rows and the sweep /
      // stale-sweep / promote read-paths all key off it. The DIAGNOSIS lives in
      // the message text and comes from result.heuristicReason, which now tells
      // the truth (unreachable vs empty vs malformed).
      if (isJudgeFailureReason(result.heuristicReason)) {
        // ── BOUNDED RETRY + ESCALATION HATCH ──────────────────────────────
        // The deferral above is correct for a BLIP. It was catastrophic for a
        // PERMANENT fault: "the provider will come back" is an assumption, and
        // when it is wrong it is wrong FOREVER. On the real incident the judge
        // was a REASONING model starved by a 300-token completion budget: it
        // answered, its content came back empty, and the code called that
        // "provider-down" and re-deferred every 5 minutes for SIX DAYS (~1,700
        // silent retries) while exempting itself from every escalation path.
        // A permanent failure wore the costume of a transient one.
        //
        // The no-key branch below already solved this exact shape (QC-02):
        // bounded passes → ONE terminal marker → permanently excluded from the
        // sweep → visible to a human. This is the SAME hatch, deliberately
        // mirroring it (marker naming, LIKE-counting, idempotent re-entry,
        // console.warn, terminal-then-stop) rather than inventing a new one.
        //
        // Bound arithmetic: qc-review-sweep retries deferred tasks every
        // QC_DEFERRED_RETRY_MINUTES (default 5), so the default 12 passes ≈ 1
        // hour of UNBROKEN failure before we stop calling it transient. A real
        // blip recovers long before that and never sees this code; an hour of
        // continuous failure is not a blip, it is a fault a human must see.
        const judgeFailureMaxPasses = Math.max(
          1,
          parseInt(process.env.QC_JUDGE_FAILURE_MAX_PASSES || '12', 10) || 12,
        );

        // Already escalated? Idempotent no-op — mirrors the no-key `alreadyFinal`
        // guard. The sweep should already exclude this task permanently; this is
        // the defensive second line so we never write a second alarm or re-enter
        // the retry loop through another caller (webhook, watcher).
        const alreadyJudgeFinal = queryOne<{ one: number }>(
          `SELECT 1 AS one FROM events
           WHERE task_id = ? AND type = 'qc_review'
             AND message LIKE '%[QC-JUDGE-FAILED-FINAL]%'
           LIMIT 1`,
          [taskId],
        );
        if (alreadyJudgeFinal) {
          console.log(
            `[QCScorer] Task "${task.title}" (${taskId}): already [QC-JUDGE-FAILED-FINAL] (judge needs a human) — no re-score, stays in review`,
          );
          return result;
        }

        // Count prior deferrals. SQLite LIKE treats '[' / ']' literally, so
        // '%[QC-DEFERRED-PROVIDER-DOWN]%' matches ONLY the per-pass marker and
        // NOT the terminal '[QC-JUDGE-FAILED-FINAL]' (a different token
        // entirely) — the same bracket discipline the no-key counter relies on.
        const priorDeferralsRow = queryOne<{ c: number }>(
          `SELECT COUNT(*) AS c FROM events
           WHERE task_id = ? AND type = 'qc_review'
             AND message LIKE '%[QC-DEFERRED-PROVIDER-DOWN]%'`,
          [taskId],
        );
        const thisDeferral = (priorDeferralsRow?.c ?? 0) + 1;

        // WHAT failed and WHERE — the six-day questions. Every field below is
        // OBSERVED, never inferred: the kind comes from the call site that saw
        // the failure, the endpoint from the same resolver the judge call used.
        const judgeEndpoint = result.judgeEndpoint ?? getOllamaCloudChatEndpoint();
        const judgeModelName = result.judgeModel ?? '(unresolved judge model)';
        const failureLabel = judgeFailureLabel(result.heuristicReason);
        const failureDetail = result.judgeFailureDetail ?? '(no detail captured)';
        const providerIsUp = result.heuristicReason !== 'provider-down';

        if (thisDeferral >= judgeFailureMaxPasses) {
          // Terminal escalation — written ONCE. Two rules this message obeys, both
          // paid for in days:
          //   1. It does NOT reuse the deferral's "NOT human-required" language.
          //      This IS human-required.
          //   2. It reports the OBSERVED failure and prescribes a fix that matches
          //      it. The previous draft of this alarm told every reader to "CHECK
          //      THE ADDRESS FIRST" — which, for the failure that actually
          //      happened (a starved reasoning-model budget), would have been the
          //      same wrong lead that burned three analyses. An escalation that
          //      guesses a category rebuilds the exact defect one layer up.
          // DETAIL above already states the observed facts and that the provider
          // is UP; this is the ACTION only. Keep them non-overlapping — an alarm
          // nobody finishes reading is another way of saying nothing.
          const nextStep = providerIsUp
            ? result.heuristicReason === 'judge-empty-response'
              ? `FIX: raise QC_JUDGE_MAX_TOKENS (default ${QC_JUDGE_MAX_TOKENS_DEFAULT}), or configure a ` +
                `non-reasoning judge model.`
              : `FIX: if finish_reason=length the reply was truncated — raise QC_JUDGE_MAX_TOKENS (default ` +
                `${QC_JUDGE_MAX_TOKENS_DEFAULT}). If the reply is complete but simply not JSON, the judge ` +
                `model is not honouring the JSON contract — change the judge model.`
            : `FIX: check that ${judgeEndpoint} is reachable from this box, that OLLAMA_CLOUD_BASE_URL has ` +
              `no typo, and that OLLAMA_CLOUD_API_KEY is valid for that address.`;

          const finalMsg =
            `[QC-JUDGE-FAILED-FINAL] Score: ${result.score.toFixed(1)}/10 | QC judge FAILED ${thisDeferral} ` +
            `consecutive times — this is NOT a transient blip. OBSERVED FAILURE: ${failureLabel}. ` +
            `Judge model "${judgeModelName}" called at ${judgeEndpoint}. DETAIL: ${failureDetail} ${nextStep} ` +
            `MANUAL REVIEW REQUIRED: this task can no longer auto-advance review→done — promote it manually, or ` +
            `fix the judge and clear this marker to re-enable scoring. It is now excluded from the QC review ` +
            `sweep permanently. ${result.reason}${gapNote} [path:heuristic]${scoredBy}`;

          run(
            `INSERT INTO events (id, type, task_id, message, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [uuidv4(), 'qc_review', taskId, finalMsg, now],
          );

          console.warn(
            `[QCScorer] Task "${task.title}" (${taskId}): QC judge failed ${thisDeferral}/${judgeFailureMaxPasses} consecutive times — ` +
              `${failureLabel} (model="${judgeModelName}" endpoint=${judgeEndpoint}) — escalated ONCE to ` +
              `[QC-JUDGE-FAILED-FINAL]; permanently excluded from qc-review-sweep. ${failureDetail}`,
          );

          return result;
        }

        // Per-pass deferral. The marker token stays [QC-DEFERRED-PROVIDER-DOWN]
        // (legacy lane key — live rows and every read-path depend on it), but the
        // TEXT no longer claims the provider is down unless it actually is.
        const deferredMsg =
          `[QC-DEFERRED-PROVIDER-DOWN] Score: ${result.score.toFixed(1)}/10 | QC judge produced no verdict — ` +
          `${failureLabel}; holding in review and auto-rescoring (NOT human-required; attempt ` +
          `${thisDeferral}/${judgeFailureMaxPasses}, judge "${judgeModelName}" at ${judgeEndpoint}). ` +
          `${failureDetail} ${result.reason}${gapNote} [path:heuristic]${scoredBy}`;

        run(
          `INSERT INTO events (id, type, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [uuidv4(), 'qc_review', taskId, deferredMsg, now],
        );

        console.log(
          `[QCScorer] Task "${task.title}" (${taskId}): judge failure — ${failureLabel} — DEFERRED in review (attempt ${thisDeferral}/${judgeFailureMaxPasses}), will auto-rescore (qc_reroute_attempts unchanged at ${task.qc_reroute_attempts ?? 0})`,
        );

        return result;
      }
      // ── End judge-failure deferral + escalation hatch ─────────────────────

      // ── No-key heuristic (keyless install by design) ─────────────────────
      // QC-02: a keyless box can NEVER auto-advance review→done, so without an
      // escape hatch the qc-review-sweep re-scores this task every ~10 min
      // FOREVER — each pass writing a fresh [QC-HEURISTIC] event while the card
      // rots in Review with no terminal signal (the second "nothing moves" trap).
      // Fix: after N passes, escalate ONCE to a TERMINAL [QC-HEURISTIC-FINAL]
      // "needs-key / manually promote" state that the sweep excludes PERMANENTLY.
      // This is kept strictly DISTINCT from the provider-down deferral above,
      // which KEEPS retrying on the short cadence (a key exists; the provider is
      // expected to return). The card stays in `review` — the board's
      // manual-review lane — now flagged terminally instead of silently churning.
      const noKeyMaxPasses = Math.max(
        1,
        parseInt(process.env.QC_HEURISTIC_NO_KEY_MAX_PASSES || '3', 10) || 3,
      );

      // Already escalated? Idempotent no-op (defensive — the sweep should already
      // be permanently excluding this task once the -FINAL marker exists).
      const alreadyFinal = queryOne<{ one: number }>(
        `SELECT 1 AS one FROM events
         WHERE task_id = ? AND type = 'qc_review' AND message LIKE '%[QC-HEURISTIC-FINAL]%'
         LIMIT 1`,
        [taskId],
      );
      if (alreadyFinal) {
        console.log(
          `[QCScorer] Task "${task.title}" (${taskId}): already [QC-HEURISTIC-FINAL] (needs-key / manual-promote) — no re-score, stays in review`,
        );
        return result;
      }

      // Count prior no-key heuristic passes. NOTE: SQLite LIKE treats '[' / ']'
      // literally (no bracket classes), so '%[QC-HEURISTIC]%' matches ONLY the
      // per-pass marker and NOT '[QC-HEURISTIC-FINAL]' or '[QC-DEFERRED-PROVIDER-DOWN]'.
      const priorPassesRow = queryOne<{ c: number }>(
        `SELECT COUNT(*) AS c FROM events
         WHERE task_id = ? AND type = 'qc_review' AND message LIKE '%[QC-HEURISTIC]%'`,
        [taskId],
      );
      const thisPass = (priorPassesRow?.c ?? 0) + 1;

      if (thisPass >= noKeyMaxPasses) {
        // Terminal escalation — write the [QC-HEURISTIC-FINAL] marker ONCE. The
        // qc-review-sweep excludes tasks carrying it permanently, so no more
        // re-scores. Task remains board-visible in the Review / QC (manual-review)
        // column awaiting a manual promotion or an LLM key.
        const finalMsg =
          `[QC-HEURISTIC-FINAL] Score: ${result.score.toFixed(1)}/10 | QC ran in heuristic mode ${thisPass} time(s) ` +
          `with NO client Ollama Cloud judge configured — this box cannot auto-advance review→done. MANUAL REVIEW ` +
          `REQUIRED: promote this task to done manually, or configure a client Ollama Cloud judge model (set the ` +
          `department QC agent's model, or QC_JUDGE_MODEL, to an ollama-cloud / :cloud model ≠ the writer, called via ` +
          `OLLAMA_CLOUD_API_KEY) and it will be re-scored. It is now excluded from the QC review sweep permanently. ` +
          `${result.reason}${gapNote} [path:heuristic]${scoredBy}`;

        run(
          `INSERT INTO events (id, type, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [uuidv4(), 'qc_review', taskId, finalMsg, now],
        );

        console.warn(
          `[QCScorer] Task "${task.title}" (${taskId}): no-key heuristic reached pass ${thisPass}/${noKeyMaxPasses} — ` +
            `escalated ONCE to [QC-HEURISTIC-FINAL] (manual-promote); permanently excluded from qc-review-sweep`,
        );

        return result;
      }

      const heuristicEventMsg =
        `[QC-HEURISTIC] Score: ${result.score.toFixed(1)}/10 | QC ran in heuristic mode (no LLM key); human review required (pass ${thisPass}/${noKeyMaxPasses}). ${result.reason}${gapNote} [path:heuristic]${scoredBy}`;

      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'qc_review', taskId, heuristicEventMsg, now],
      );

      console.log(
        `[QCScorer] Task "${task.title}" (${taskId}): heuristic mode — task stays in review, human review required (score ${result.score.toFixed(1)}/10, pass ${thisPass}/${noKeyMaxPasses}, qc_reroute_attempts unchanged at ${task.qc_reroute_attempts ?? 0})`,
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

      // Auto-approve: move review → done through the ONE authoritative lifecycle
      // path (DISP-10). transition() performs the review→done compare-and-swap,
      // writes the structured `task_events` audit row AND the legacy
      // `task_completed` event atomically, broadcasts `task_updated`, and fires
      // the 5-field DONE owner report (notifyOwnerDone) — replacing the raw
      // UPDATE + hand-rolled event + separate notify that bypassed the audit sink.
      try {
        await transition(taskId, 'done', {
          actor: 'qc-auto-scorer',
          reason: `QC auto-approved (score ${result.score.toFixed(1)}/10 ≥ ${QC_PASS_THRESHOLD})`,
          expectedFrom: 'review',
        });
      } catch (txErr) {
        if (txErr instanceof TransitionError && txErr.code === 'CAS_CONFLICT') {
          // Another writer already advanced the task out of `review` in the
          // score→write window — do not double-complete or double-report.
          console.warn(
            `[QCScorer] Task ${taskId}: review→done CAS conflict (already advanced) — skipping done write`,
          );
          return result;
        }
        throw txErr;
      }
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
        // D7: credit EVERY blended persona (voice + topic + any subtask-decomposition
        // personas), not just the primary voice mirror — see recordPersonaCompletions.
        // Dynamic import: qc-scorer.ts is statically imported by task-dispatcher.ts,
        // which is statically imported by tasks.ts — a static import here would close
        // a tasks.ts <-> qc-scorer.ts cycle (same reasoning as the dynamic imports
        // already used elsewhere in tasks.ts/task-dispatcher.ts for this same pair).
        const taskOutput = [task.title, task.description].filter(Boolean).join(' — ');
        try {
          const { recordPersonaCompletions } = await import('@/lib/tasks');
          recordPersonaCompletions(taskId, task.persona_id, deptSlug, taskOutput);
        } catch (creditErr) {
          console.warn(
            `[QCScorer] recordPersonaCompletions failed for task ${taskId} (non-fatal):`,
            (creditErr as Error).message,
          );
        }
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
        // Cap reached → classify the block and set task to `blocked`.
        //
        // BLOCK-TRANSPARENCY-001 (v4.44.0):
        // Classify whether the root cause is something the OWNER must act on
        // (needs approval, needs owner data) vs something the SYSTEM must fix
        // (wrong SOP matched, missing builder, model misbind, mismatched rubric).
        //
        // SYSTEM signals:
        //   - no-criteria path: SOP missing or rubric missing — operator must fix
        //   - gap text mentions infra-level signals: "wrong sop", "no sop assigned",
        //     "missing builder", "model", "rubric", "routing", "wrong department",
        //     "no criteria", "schema", "config"
        // All other blocks default to OWNER (needs human approval / data).
        const gapText = [...result.gaps, result.reason].join(' ').toLowerCase();
        const systemSignals = [
          /no\s+sop\s+assign/,
          /no\s+criteria/,
          /missing\s+builder/,
          /wrong\s+sop/,
          /model\s+misbind/,
          /mismatched\s+rubric/,
          /wrong\s+department/,
          /schema\s+error/,
          /config\s+error/,
          /routing\s+error/,
          /rubric\s+mismatch/,
          /\bno-criteria\b/,
          /cannot\s+evaluate/,
          /cannot\s+auto-score/,
        ];
        const isSystemBlock = result.scoringPath === 'no-criteria' || systemSignals.some((p) => p.test(gapText));
        const blockAudience: 'OWNER' | 'SYSTEM' = isSystemBlock ? 'SYSTEM' : 'OWNER';

        const blockGapsJson = JSON.stringify(result.gaps);
        const blockNeeds: string = isSystemBlock
          ? `System fix required: ${result.gaps.slice(0, 2).join('; ') || result.reason}. Route diagnosis to master orchestrator.`
          : `Owner action required: ${result.gaps.slice(0, 2).join('; ') || result.reason}. Reply here to unblock or reassign.`;

        const blockedNote = `[QC-BLOCKED] Task failed QC ${newAttempts} time(s) (cap: ${QC_MAX_REROUTES}). Last score: ${result.score.toFixed(1)}/10. Audience: ${blockAudience}. ${result.reason}`;

        // U99-RAW-STATUS-WRITER: compound single-row UPDATE (description +
        // qc_reroute_attempts + the full block_* metadata must land atomically
        // with the status flip, mirroring recordDispatchFailure); audited
        // immediately below via recordStatusEvent (DISP-10), gated on the CAS
        // actually landing.
        const blockRes = run(
          `UPDATE tasks SET status = 'blocked',
             description = CASE
               WHEN description IS NULL OR description = '' THEN ?
               ELSE description || char(10) || char(10) || ?
             END,
             qc_reroute_attempts = ?,
             block_reason = ?,
             block_gaps = ?,
             block_needs = ?,
             block_audience = ?,
             updated_at = ?
           WHERE id = ? AND status = 'review'`,
          [
            blockedNote, blockedNote, newAttempts,
            `Failed QC ${newAttempts}x, last score ${result.score.toFixed(1)}/10`,
            blockGapsJson,
            blockNeeds,
            blockAudience,
            now,
            taskId,
          ],
        );
        if ((blockRes.changes ?? 0) > 0) {
          recordStatusEvent(taskId, 'review', 'blocked', { actor: 'qc-scorer', reason: blockedNote });
        }

        run(
          `INSERT INTO events (id, type, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [uuidv4(), 'task_status_changed', taskId,
            `[QC-BLOCKED] Task "${task.title}" blocked after ${newAttempts} QC-fail re-routes (cap: ${QC_MAX_REROUTES}). Audience: ${blockAudience}. ${isSystemBlock ? 'SYSTEM fix needed — escalating to master orchestrator.' : 'Human review required.'}`,
            now],
        );

        console.warn(`[QCScorer] Task "${task.title}" (${taskId}): BLOCKED after ${newAttempts} QC-fail re-routes — audience: ${blockAudience}`);

        // Resolve master-orchestrator/CEO agent for the event author field.
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

        if (isSystemBlock) {
          // SYSTEM block: escalate to master orchestrator via event.
          // This creates a qc_review event attributed to the CEO/master-orchestrator
          // so the orchestrator's Live Feed picks it up and can re-route or fix the
          // root cause (wrong SOP, missing builder, model misbind, etc.).
          // We do NOT notify the owner — this is an internal system gap.
          run(
            `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              'qc_escalation',
              ceoAgentIdBlocked,
              taskId,
              `[QC-SYSTEM-BLOCK] "${task.title}" failed QC ${newAttempts} time(s) due to a SYSTEM issue the executor cannot fix. Score: ${result.score.toFixed(1)}/10. Root cause gaps: ${result.gaps.join('; ')}. Action needed: ${blockNeeds}`,
              now,
            ],
          );
          console.warn(`[QCScorer] Task "${task.title}" (${taskId}): SYSTEM block — escalated to master orchestrator (no owner Telegram)`);
        } else {
          // OWNER block: emit CEO event AND notify the owner via Telegram.
          run(
            `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              'qc_review',
              ceoAgentIdBlocked,
              taskId,
              `[QC-BLOCKED] "${task.title}" failed QC ${newAttempts} time(s) and has been blocked. Score: ${result.score.toFixed(1)}/10. Owner attention needed.`,
              now,
            ],
          );

          // ── OWNER NOTIFICATION (BLOCKED — audience=OWNER only) ─────────────
          // Only fire Telegram for owner-actionable blocks, NOT system blocks.
          // Firing for system blocks would flood the owner with noise about
          // things they cannot resolve themselves.
          try {
            const blockReason = result.gaps.length > 0
              ? result.gaps.join('; ')
              : result.reason;
            notifyOwner(
              `⚠️ A task is BLOCKED and needs your attention: "${task.title}".\nReason: ${blockReason}\n\nThis task failed QC ${newAttempts} time(s) (score ${result.score.toFixed(1)}/10). Reply here to unblock or reassign.`,
            );
          } catch (notifyErr) {
            console.error('[QCScorer] BLOCKED owner notify error (non-fatal):', (notifyErr as Error).message);
          }
          // ── End OWNER NOTIFICATION (BLOCKED) ────────────────────────────
        }

        return result;
      }
      // ── End of loop guard ────────────────────────────────────────────────

      const kickbackNote = result.gaps.length > 0
        ? `[QC-FAIL] Score ${result.score.toFixed(1)}/10 (attempt ${newAttempts}/${QC_MAX_REROUTES}). Rework needed: ${result.gaps.join('; ')}`
        : `[QC-FAIL] Score ${result.score.toFixed(1)}/10 (attempt ${newAttempts}/${QC_MAX_REROUTES}). ${result.reason}`;

      // U99-RAW-STATUS-WRITER: compound single-row UPDATE (description +
      // qc_reroute_attempts must land atomically with the status flip);
      // audited immediately below via recordStatusEvent (DISP-10), gated on
      // the CAS actually landing.
      const rerouteRes = run(
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
      if ((rerouteRes.changes ?? 0) > 0) {
        recordStatusEvent(taskId, 'review', 'backlog', { actor: 'qc-scorer', reason: kickbackNote });
      }

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
          // U99-RAW-STATUS-WRITER: fire-and-forget continuation of an async
          // fetch().then() — not a good fit for the async transition() call
          // inside a non-async .then() callback without restructuring the
          // surrounding promise chain; audited immediately below via
          // recordStatusEvent (DISP-10), gated on the CAS actually landing.
          const autoRouteRes = run(
            `UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'backlog'`,
            [new Date().toISOString(), taskId],
          );
          if ((autoRouteRes.changes ?? 0) > 0) {
            recordStatusEvent(taskId, 'backlog', 'in_progress', {
              actor: 'qc-scorer',
              reason: 'auto-route succeeded after QC reroute',
            });
          }
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

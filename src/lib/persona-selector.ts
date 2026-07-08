/**
 * Server-side persona selector for the Command Center.
 *
 * Spawns the v2.1-aware `persona-selector-v2.py` script from the installed
 * OpenClaw skill folder. The v2 script handles:
 *   - Stickiness check against the persona_assignment table
 *   - Adaptive 5-layer weights (task-taxonomy-driven)
 *   - Behavioral profile reading (USER.md `## Behavioral Identity Profile`)
 *   - Hybrid mode (returns secondary_persona_* fields when task signals both
 *     leadership AND coaching)
 *   - Weight override application from persona_weight_overrides
 *
 * The output JSON is a superset of what the v1 selector returned. Existing
 * callers continue to work; new fields (task_category, secondary_persona_*,
 * weights_used, layers) are available when present.
 *
 * spawnRecordCompletion() — fire-and-forget helper used by both the PATCH
 * task route (human approval) and runQCOnReview (QC auto-approve) to close
 * the feedback loop: once a task reaches `done`, we notify persona-selector-v2
 * so it can write to persona_performance / persona_weight_overrides and make
 * the adaptive weights actually adapt.  PRD item 1.4.
 *
 * PRD item 1.6: selectPersonaForTask uses promisified async execFile (never
 * execFileSync) so it never freezes the Node event loop.  createTaskCore calls
 * this function with await AFTER the task INSERT + first broadcast, so the
 * API responds in <500ms and the persona chip appears via a second task_updated
 * SSE event a few seconds later.
 */
import { promisify } from "util";
import { execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { DB_PATH, queryAll, queryOne, run } from "@/lib/db";
import { broadcast } from "@/lib/events";
import type { PersonaSlot } from "@/lib/sops";
import type { Task } from "@/lib/types";

// Promisified async version — never blocks the event loop.
const execFileAsync = promisify(execFile);

// ─── PINNED FALLBACK CONSTANTS (F3.1 / Persona-Matching-Overhaul FDN-2) ───────
// Mirror of the Python-side pins in persona-selector-v2.py (next to GEMINI_MODEL):
//   DEFAULT_PERSONA_FALLBACK   — the generic BlackCEO house-voice persona seeded
//     into the fleet (triad 81->82). It is deliberately generic so it never
//     out-scores a real specialist; only the last-resort fallback returns it, so
//     NO task is ever naked. Per-client override: company-config.json
//     `default_persona_id`.
//   GOVERNANCE_PERSONA_FALLBACK — the oversight pointer carried by mechanical
//     (no_persona_required) tasks so the doer still has principle-centered
//     governance without pretending a chmod needs coaching. Per-client override:
//     company-config.json `governance_persona_id`.
// These are the TS side of the resolved Q1/Q2 decisions and are the terminal tier
// of the fallback chain (never-null when everything else is unavailable).
export const DEFAULT_PERSONA_FALLBACK = "blackceo-house-voice";
export const GOVERNANCE_PERSONA_FALLBACK = "covey-7-habits";

// CC selector spawn budget. Raised 30s -> 60s (F3.1 / A3): LLM-mode scoring of
// ~12 finalists x 4 layers plus a cold embedding call can exceed 30s on a loaded
// box, so a 30s cap turned a slow-but-valid selection into a null result (naked
// task). 60s gives the real selection room to land before the retry/fallback
// chain engages.
export const PERSONA_SELECT_TIMEOUT_MS = 60_000;

/**
 * Resolve the company-config.json path to hand the python selector as a grounding
 * hint (G10-TRIAD-PERSONA-RESOLVE / Gap A/B). Without company-config the selector's
 * grounding layers neutralize to a flat 0.6 score. We forward the path via the
 * OPENCLAW_COMPANY_CONFIG env var.
 *
 * IMPORTANT: persona-selector-v2.py uses a STRICT argparse (parser.parse_args()),
 * which has NO `--company-config` flag — passing it as a CLI argument would crash
 * the script (SystemExit) and break selection entirely. So the hint is passed via
 * ENV (additive / non-breaking), never as a flag. The script resolves company-config
 * through get_openclaw_paths()/OPENCLAW_COMPANY_SLUG today; OPENCLAW_COMPANY_CONFIG is
 * forward-compatible for when the script is taught to honour an explicit path.
 *
 * Resolution order: explicit env override → command-center's config/company-config.json.
 * Returns undefined when no readable file is found (selector falls back to its own
 * path resolution — no behaviour change).
 */
function resolveCompanyConfigHint(): string | undefined {
  const explicit = process.env.OPENCLAW_COMPANY_CONFIG;
  if (explicit && fs.existsSync(explicit)) return explicit;
  try {
    const appConfig = path.join(process.cwd(), "config", "company-config.json");
    if (fs.existsSync(appConfig)) return appConfig;
  } catch {
    /* non-fatal — fall through to undefined */
  }
  return undefined;
}

export type PersonaInteractionMode = "leadership" | "coaching" | "hybrid";

/**
 * SOP context handed to the selector so the match is SOP-aware (finding F3.4).
 *
 * The selector folds `name` into the task-category / Layer-5 embed query and
 * UNIONs `hints` (SOP-declared `persona_hints`, canonical persona slugs) into
 * the candidate pool with a bounded additive bonus — so a hinted specialist can
 * win when relevant, but a stale hint can never force a bad match.
 *
 * These map to DEP-1's `--sop-slug` / `--sop-name` / `--sop-hints` selector
 * inputs. All fields optional: a partial context (e.g. hints only) is valid.
 */
export interface SopSelectorContext {
  slug?: string | null;
  name?: string | null;
  hints?: string[] | null;
}

/** Optional knobs for a single selection run (bounded dispatch-time rescore). */
export interface SelectPersonaOptions {
  /** Spawn timeout in ms. Defaults to 30_000 (creation); dispatch rescore bounds it tighter. */
  timeoutMs?: number;
}

/** True when the SOP context carries at least one selector-consumable value. */
export function hasSopContext(ctx: SopSelectorContext | null | undefined): ctx is SopSelectorContext {
  if (!ctx) return false;
  return Boolean(
    (ctx.slug && ctx.slug.trim()) ||
      (ctx.name && ctx.name.trim()) ||
      (ctx.hints && ctx.hints.length > 0),
  );
}

/**
 * Build the argv for one `persona-selector-v2.py --mode select` spawn.
 *
 * The base argv is unchanged from the pre-SOP behaviour. When `sopContext`
 * carries meaningful values the `--sop-slug` / `--sop-name` / `--sop-hints`
 * flags (DEP-1) are appended. Exported so a unit test can assert the forwarding
 * without spawning Python.
 */
export function buildSelectorArgv(
  scriptPath: string,
  taskDescription: string,
  dept: string,
  taskId: string,
  sopContext?: SopSelectorContext | null,
): string[] {
  const argv = [
    scriptPath,
    "--task", taskDescription,
    "--department", dept,
    "--task-id", taskId,
    "--format", "json",
  ];
  if (sopContext) {
    if (sopContext.slug && sopContext.slug.trim()) {
      argv.push("--sop-slug", sopContext.slug.trim());
    }
    if (sopContext.name && sopContext.name.trim()) {
      argv.push("--sop-name", sopContext.name.trim());
    }
    const hints = (sopContext.hints || [])
      .map((h) => (h || "").trim())
      .filter(Boolean);
    if (hints.length > 0) {
      // Comma-joined list — the selector splits on ',' (mirrors its other list inputs).
      argv.push("--sop-hints", hints.join(","));
    }
  }
  return argv;
}

/**
 * Heuristic: did the selector reject an argument it doesn't understand?
 *
 * A box whose `persona-selector-v2.py` predates DEP-1 has no `--sop-*` flags;
 * its strict argparse exits 2 with "unrecognized arguments" on SystemExit. We
 * detect that so the caller can retry WITHOUT the SOP flags rather than let an
 * entire SOP-carrying task degrade to the department-default fallback. Any other
 * failure (timeout, python missing, real error) is NOT swallowed here.
 *
 * PERS-03: we deliberately do NOT treat a bare exit code 2 as "unknown argument".
 * argparse (and other CLIs) exit 2 for MANY reasons — a genuine crash inside the
 * script, a malformed `--task` value, an internal traceback. Short-circuiting on
 * `code===2` masked those real crashes as a benign predates-DEP-1 signal and
 * silently downgraded the task to a non-SOP-aware match. We now require the
 * stderr/message to actually name an unrecognized-flag error. `invalid choice`
 * is intentionally EXCLUDED — it is argparse's error for a bad *value* (e.g. a
 * department not in `choices=[...]`), a real error that must not be swallowed.
 */
function isUnknownArgumentError(err: unknown): boolean {
  const e = err as { stderr?: string; message?: string };
  const text = `${e?.stderr ?? ""} ${e?.message ?? ""}`;
  return /unrecognized arguments?|no such option|unrecognized option/i.test(text);
}

export interface PersonaSelectionResult {
  persona_id: string | null;
  persona_name: string;
  /**
   * PERS-05: true when `persona_name` was NOT supplied by the selector (which
   * returns a name only when the id resolved to a real catalog persona) and was
   * instead derived from the raw slug. Consumers must render a synthesized name
   * as tentative, never as an authoritative catalog display name.
   */
  persona_name_synthesized?: boolean;
  persona_version?: number;
  score: number;
  interaction_mode: PersonaInteractionMode;
  task_category?: string;
  // Hybrid-mode extras
  secondary_persona_id?: string | null;
  secondary_persona_name?: string | null;
  secondary_persona_score?: number | null;
  // Diagnostic / observability
  weights_used?: Record<string, number>;
  layers?: Record<string, number>;
  breakdown?: Record<string, unknown>;
  warning?: string;
  message?: string;
  no_persona_required?: boolean;
  /**
   * Oversight pointer for mechanical (no_persona_required) tasks — the governance
   * persona the dispatcher hands the doer instead of a full Section-4 persona load
   * (Q1). Resolves company-config.json `governance_persona_id` else
   * GOVERNANCE_PERSONA_FALLBACK. Present alongside no_persona_required:true.
   */
  governance_persona_id?: string | null;
}

function resolveOpenClawRoot(): string {
  if (process.env.OPENCLAW_ROOT) return process.env.OPENCLAW_ROOT;
  // VPS / Hostinger Docker default
  if (process.env.OPENCLAW_PLATFORM === "vps") return "/data/.openclaw";
  // Mac defaults — prefer new layout, fall back to legacy
  const macNew = path.join(os.homedir(), ".openclaw");
  return macNew;
}

function resolveScriptPath(): string {
  const root = resolveOpenClawRoot();
  return path.join(
    root,
    "skills",
    "23-ai-workforce-blueprint",
    "scripts",
    "persona-selector-v2.py"
  );
}

/**
 * Path to the multi-persona decomposition engine (`decompose-task.py`), which
 * lives beside `persona-selector-v2.py` in the same installed skill folder.
 * DEP-5 / F3.7: the CC spawns this in `--combined` mode when a task decomposes
 * into >1 sub-task (or an SOP declares >1 persona slot).
 */
function resolveDecomposeScriptPath(): string {
  const root = resolveOpenClawRoot();
  return path.join(
    root,
    "skills",
    "23-ai-workforce-blueprint",
    "scripts",
    "decompose-task.py"
  );
}

/**
 * Select a persona for a task.
 *
 * @param taskId          Database task id (used for logging only).
 * @param taskDescription Title + description concatenated.
 * @param departmentId    Department slug (e.g. "sales", "marketing"). Pass null to fall back to "general".
 * @param sopContext      Optional SOP context (F3.4) — slug/name/hints folded into the match.
 * @param opts            Optional per-run knobs (bounded timeout for dispatch-time rescore).
 * @returns               JSON result from the Python script, or null on failure.
 */
export async function selectPersonaForTask(
  taskId: string,
  taskDescription: string,
  departmentId: string | null,
  sopContext?: SopSelectorContext | null,
  opts?: SelectPersonaOptions,
): Promise<PersonaSelectionResult | null> {
  // Test/CI escape hatch: PERSONA_FIXTURE_JSON env var returns a fixture
  // instead of spawning Python.  This allows unit tests to exercise the
  // sentinel warning path (PRD 3.4) without needing real Python scripts.
  // Never set this in production.
  if (process.env.PERSONA_FIXTURE_JSON) {
    try {
      const fixture = JSON.parse(process.env.PERSONA_FIXTURE_JSON) as Partial<PersonaSelectionResult>;
      return {
        persona_id: fixture.persona_id ?? null,
        persona_name: fixture.persona_name || 'Fixture Persona',
        persona_version: fixture.persona_version,
        score: typeof fixture.score === 'number' ? fixture.score : 0,
        interaction_mode: (fixture.interaction_mode as PersonaInteractionMode) || 'leadership',
        no_persona_required: fixture.no_persona_required,
        governance_persona_id: fixture.governance_persona_id ?? null,
      };
    } catch {
      // Malformed fixture — fall through to real selector.
    }
  }

  try {
    const scriptPath = resolveScriptPath();
    const dept = departmentId || "general";

    // Pass the authoritative DB path so the selector can write persona_selection_log
    // rows and read stickiness/variety data from the correct database.  Without this,
    // find_dashboard_db() in the Python script falls through its candidate list and
    // resolves to an empty string, silently no-opping every DB interaction (stickiness,
    // variety, weight overrides, record_selection).
    //
    // PRD 1.6: use async execFile (promisified) — never execFileSync which freezes the
    // Node event loop for up to 30s during semantic embed + LLM scoring calls.
    //
    // G10-TRIAD-PERSONA-RESOLVE:
    //  - `--task-id` is forwarded so the script can attribute the selection (argparse
    //    accepts it; harmless in select mode). It is ALSO set as OPENCLAW_TASK_ID in
    //    the env because the select-mode persona_selection_log reads task_id from
    //    os.environ["OPENCLAW_TASK_ID"] (script line ~758), defaulting to
    //    "(no-task-id)" — the env is the actual fix for the (no-task-id) log rows.
    //  - OPENCLAW_COMPANY_CONFIG is forwarded as the company-config grounding hint
    //    (so grounding doesn't neutralize to 0.6). It is passed via ENV, NOT as a
    //    `--company-config` flag: the script's strict argparse has no such flag and
    //    would crash on it.
    const companyConfigHint = resolveCompanyConfigHint();
    const timeoutMs = opts?.timeoutMs ?? PERSONA_SELECT_TIMEOUT_MS;
    const spawnEnv = {
      ...process.env,
      DASHBOARD_DB_PATH: DB_PATH,
      OPENCLAW_TASK_ID: taskId,
      ...(companyConfigHint ? { OPENCLAW_COMPANY_CONFIG: companyConfigHint } : {}),
    };

    const runSelector = async (argv: string[]): Promise<string> => {
      const { stdout } = await execFileAsync("python3", argv, {
        encoding: "utf-8",
        timeout: timeoutMs,
        env: spawnEnv,
      });
      return stdout;
    };

    // F3.4: fold SOP context into the match when present. DEP-1 teaches the
    // selector the --sop-* flags; on a box whose selector predates DEP-1 the
    // strict argparse rejects them, so we retry ONCE without the SOP flags
    // rather than let the whole SOP-carrying task fail selection (fail-closed:
    // degrade to a non-SOP-aware match, never to a naked/fallback persona).
    const wantsSop = hasSopContext(sopContext);
    const baseArgv = buildSelectorArgv(scriptPath, taskDescription, dept, taskId);
    let output: string;
    if (wantsSop) {
      const sopArgv = buildSelectorArgv(scriptPath, taskDescription, dept, taskId, sopContext);
      try {
        output = await runSelector(sopArgv);
      } catch (sopErr) {
        if (isUnknownArgumentError(sopErr)) {
          console.warn(
            `[persona-selector] SOP-aware flags rejected by selector for task ${taskId} ` +
            `(selector predates DEP-1 --sop-* inputs) — retrying without SOP context.`,
          );
          try {
            output = await runSelector(baseArgv);
          } catch (retryErr) {
            // PERS-03: the non-SOP retry ALSO failed. Surface the ORIGINAL error
            // (the primary SOP-run failure) — masking it behind the retry error
            // would hide the real cause. Log the retry error for context.
            console.error(
              `[persona-selector] non-SOP retry also failed for task ${taskId}:`,
              (retryErr as Error)?.message ?? retryErr,
            );
            throw sopErr;
          }
        } else {
          throw sopErr;
        }
      }
    } else {
      output = await runSelector(baseArgv);
    }

    const result = JSON.parse(output) as Partial<PersonaSelectionResult>;

    // PERS-05: the Python selector returns `persona_name` ONLY when the id
    // resolved to a real catalog persona — that name is authoritative. When it is
    // absent we must NOT fabricate a prettified Title-Case name and surface it to
    // the owner as if it were verified. Keep the RAW slug as the display value and
    // flag it synthesized so downstream renders it as tentative.
    const nameFromSelector = result.persona_name;
    const synthesized = !nameFromSelector && !!result.persona_id;
    return {
      persona_id: result.persona_id ?? null,
      persona_name: nameFromSelector || result.persona_id || "N/A",
      persona_name_synthesized: synthesized,
      persona_version: result.persona_version,
      score: typeof result.score === "number" ? result.score : 0,
      interaction_mode: (result.interaction_mode as PersonaInteractionMode) || "leadership",
      task_category: result.task_category,
      secondary_persona_id: result.secondary_persona_id ?? null,
      secondary_persona_name: result.secondary_persona_name ?? null,
      secondary_persona_score: result.secondary_persona_score ?? null,
      weights_used: result.weights_used,
      layers: result.layers,
      breakdown: result.breakdown,
      warning: result.warning,
      message: result.message,
      no_persona_required: result.no_persona_required,
      governance_persona_id: result.governance_persona_id ?? null,
    };
  } catch (error) {
    console.error(`[persona-selector] Failed for task ${taskId}:`, error);
    return null;
  }
}

// ─── MULTI-PERSONA DECOMPOSITION (DEP-5 / F3.7 + F3.9) ───────────────────────

/**
 * One sub-task's persona pick — the W6.4 `subtask_personas[]` contract emitted by
 * `decompose-task.py` on stdout AND the row shape of `task_subtask_persona`.
 */
export interface SubtaskPersona {
  seq: number;
  subtask_text?: string | null;
  persona_id: string | null;
  persona_name?: string | null;
  score?: number | null;
  department?: string | null;
  task_category?: string | null;
  /** F3.9 — which declared SOP slot this sub-task filled (NULL for text decomp). */
  slot?: string | null;
  /** Present in the rich `plan[]` (not persisted): human "why this persona". */
  why?: string | null;
  /** Present in the rich `plan[]`: a mechanical sub-task needs no persona. */
  no_persona_required?: boolean | null;
}

export interface PersonaPlanResult {
  mode: "combined";
  subtask_count: number;
  distinct_persona_count: number;
  decomposition_method?: string;
  /** W6.4 row-shape array — the authoritative plan the CC persists/renders. */
  subtask_personas: SubtaskPersona[];
}

/**
 * Run `decompose-task.py --combined` for a task and return the per-sub-task
 * persona plan (W6.4 contract). The script itself persists the plan rows into
 * `task_subtask_persona` (keyed by `OPENCLAW_TASK_ID`), so this function's job is
 * to (a) drive the spawn, (b) parse the `subtask_personas[]` array, and (c) hand
 * it back for the primary-pin decision + SSE broadcast.
 *
 * Robust to DEP-4 rollout timing: `--slots` is a DEP-4 flag on the matcher side.
 * If the installed script is older (strict argparse rejects `--slots`), the first
 * spawn fails and we transparently retry WITHOUT slots (pure text decomposition).
 * A total failure returns null and the caller falls back to single-persona
 * selection — a decomposition problem never leaves a task naked.
 *
 * @returns the plan, or null when decomposition did not produce a usable plan.
 */
export async function selectPersonaPlanForTask(
  taskId: string,
  taskDescription: string,
  departmentId: string | null,
  opts?: { slots?: PersonaSlot[] },
): Promise<PersonaPlanResult | null> {
  // Test/CI escape hatch — mirrors PERSONA_FIXTURE_JSON. Never set in production.
  if (process.env.PERSONA_PLAN_FIXTURE_JSON) {
    try {
      const fixture = JSON.parse(process.env.PERSONA_PLAN_FIXTURE_JSON) as Partial<PersonaPlanResult>;
      const rows = Array.isArray(fixture.subtask_personas) ? fixture.subtask_personas : [];
      return normalizePlan(rows, fixture);
    } catch {
      // Malformed fixture — fall through to the real engine.
    }
  }

  const scriptPath = resolveDecomposeScriptPath();
  if (!fs.existsSync(scriptPath)) {
    console.warn(`[persona-plan] decompose-task.py not found at ${scriptPath} — skipping decomposition`);
    return null;
  }
  const dept = departmentId || "general";
  const companyConfigHint = resolveCompanyConfigHint();
  const slots = opts?.slots && opts.slots.length > 0 ? opts.slots : undefined;

  const baseArgs = [scriptPath, "--task", taskDescription, "--department", dept, "--format", "json"];
  const env = {
    ...process.env,
    DASHBOARD_DB_PATH: DB_PATH,
    OPENCLAW_TASK_ID: taskId,
    ...(companyConfigHint ? { OPENCLAW_COMPANY_CONFIG: companyConfigHint } : {}),
  };

  const runOnce = async (args: string[]): Promise<PersonaPlanResult | null> => {
    const { stdout } = await execFileAsync("python3", args, {
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env,
    });
    const parsed = JSON.parse(stdout) as { subtask_personas?: unknown[] } & Record<string, unknown>;
    const rows = Array.isArray(parsed.subtask_personas) ? parsed.subtask_personas : [];
    return normalizePlan(rows as Partial<SubtaskPersona>[], parsed);
  };

  try {
    if (slots) {
      try {
        return await runOnce([...baseArgs, "--slots", JSON.stringify(slots)]);
      } catch (slotErr) {
        // Older script without a --slots flag (strict argparse SystemExit) — retry
        // with pure text decomposition so DEP-5 works before DEP-4 lands on a box.
        console.warn(`[persona-plan] --slots rejected for task ${taskId}, retrying text decomposition:`, (slotErr as Error).message);
        return await runOnce(baseArgs);
      }
    }
    return await runOnce(baseArgs);
  } catch (error) {
    console.error(`[persona-plan] decomposition failed for task ${taskId}:`, error);
    return null;
  }
}

/** Coerce the raw `subtask_personas[]` array into a typed, counted plan. */
function normalizePlan(
  rows: Partial<SubtaskPersona>[],
  parsed?: Record<string, unknown>,
): PersonaPlanResult | null {
  const subtask_personas: SubtaskPersona[] = rows.map((r, i) => ({
    seq: typeof r.seq === "number" ? r.seq : i + 1,
    subtask_text: r.subtask_text ?? null,
    persona_id: r.persona_id ?? null,
    persona_name: r.persona_name ?? null,
    score: typeof r.score === "number" ? r.score : null,
    department: r.department ?? null,
    task_category: r.task_category ?? null,
    slot: r.slot ?? null,
    why: r.why ?? null,
    no_persona_required: r.no_persona_required ?? null,
  }));
  if (subtask_personas.length === 0) return null;
  const distinct = new Set(subtask_personas.map((s) => s.persona_id).filter(Boolean));
  const rawCount = parsed?.subtask_count;
  const rawDistinct = parsed?.distinct_persona_count;
  const rawMethod = parsed?.decomposition_method;
  return {
    mode: "combined",
    subtask_count: typeof rawCount === "number" ? rawCount : subtask_personas.length,
    distinct_persona_count: typeof rawDistinct === "number" ? rawDistinct : distinct.size,
    decomposition_method: typeof rawMethod === "string" ? rawMethod : undefined,
    subtask_personas,
  };
}

/**
 * Read the persisted per-sub-task persona plan for a task (ordered by seq).
 * Tolerant: returns [] when the `task_subtask_persona` table is absent
 * (pre-migration-088 box) or on any query error — the caller (kanban card, GET
 * route, dispatcher) simply shows no plan rather than crashing.
 */
export function loadSubtaskPersonas(taskId: string): SubtaskPersona[] {
  try {
    const rows = queryAll<SubtaskPersona>(
      `SELECT seq, subtask_text, persona_id, persona_name, score, department, task_category, slot
         FROM task_subtask_persona
        WHERE task_id = ?
        ORDER BY seq ASC`,
      [taskId],
    );
    return rows;
  } catch {
    return [];
  }
}

/**
 * Re-broadcast a task over SSE with its per-sub-task persona plan attached, so
 * the kanban card can render slot chips the moment the plan lands. Best-effort:
 * a broadcast failure never propagates to the caller.
 */
export function broadcastPersonaPlan(taskId: string): void {
  try {
    const task = queryOne<Task>(
      `SELECT t.*,
          aa.name as assigned_agent_name,
          aa.avatar_emoji as assigned_agent_emoji,
          ca.name as created_by_agent_name,
          ca.avatar_emoji as created_by_agent_emoji
         FROM tasks t
         LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
         LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
        WHERE t.id = ?`,
      [taskId],
    );
    if (!task) return;
    const subtask_personas = loadSubtaskPersonas(taskId);
    broadcast({ type: "task_updated", payload: { ...task, subtask_personas } });
  } catch (err) {
    console.error(`[persona-plan] broadcastPersonaPlan failed for task ${taskId}:`, err);
  }
}

/**
 * Fire-and-forget: spawn `persona-selector-v2.py --mode record-completion`
 * after a task reaches `done`, so the adaptive learning loop gets outcome data.
 *
 * PRD item 1.4: "spawn persona-selector-v2.py --mode record-completion
 * --task-id <id> --persona-id <persona_id> --department <slug>
 * --task-output <text> async (fire-and-forget, error-logged, non-blocking).
 * Skip null persona."
 *
 * BUG FIX (v4.22.0): The Python script at ~line 972 requires either
 * --task-output or --task-output-file to be present; without it the script
 * exits with code 2 and persona_performance is never populated (PRD 1.4
 * learning loop was completely dead). We now accept taskOutput and pass it
 * as --task-output so record_completion() in the Python script can write the
 * persona_performance row.
 *
 * Called from:
 *   - src/app/api/tasks/[id]/route.ts  (human approval: PATCH status → done)
 *   - src/lib/qc-scorer.ts             (QC auto-approve: runQCOnReview PASS)
 *
 * @param taskId      The task id.
 * @param personaId   The persona id stored on the task. MUST be non-null before calling.
 * @param deptSlug    Department slug (e.g. "sales").  Falls back to "general" if absent.
 * @param taskOutput  Task title + description concatenated (used by the Python script's
 *                    record_completion() to categorise the outcome). Defaults to the
 *                    taskId when not supplied so the argument is always present.
 */
export function spawnRecordCompletion(
  taskId: string,
  personaId: string,
  deptSlug: string | null | undefined,
  taskOutput?: string | null
): void {
  const scriptPath = resolveScriptPath();
  const dept = deptSlug || "general";
  // Python requires --task-output (or --task-output-file); always supply it.
  // Fall back to the task id so the argument is never omitted.
  const outputText = (taskOutput && taskOutput.trim()) ? taskOutput.trim() : taskId;

  const child = spawn(
    "python3",
    [
      scriptPath,
      "--mode", "record-completion",
      "--task-id", taskId,
      "--persona-id", personaId,
      "--department", dept,
      "--task-output", outputText,
    ],
    {
      detached: true,
      stdio: "pipe",
      env: { ...process.env, DASHBOARD_DB_PATH: DB_PATH },
    }
  );

  // Collect stderr so errors are visible in the server log instead of silently swallowed.
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  child.on("error", (err) => {
    console.error(`[persona-selector] record-completion spawn error for task ${taskId}:`, err.message);
  });

  child.on("close", (code) => {
    if (code !== 0) {
      console.warn(
        `[persona-selector] record-completion exited ${code} for task ${taskId} ` +
        `(persona ${personaId}, dept ${dept})` +
        (stderr ? `: ${stderr.trim()}` : "")
      );
      // PERS-07: previously a non-zero exit was logged and then silently dropped,
      // leaving a hole in the adaptive learning loop (persona_performance never
      // got the outcome). Write a QUERYABLE `persona_completion_failed` event so a
      // retry sweep can pick it up. Audit-only: never throw from the close handler.
      try {
        run(
          `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            "persona_completion_failed",
            taskId,
            `[PERSONA-COMPLETION-FAILED] record-completion exited ${code} for persona ${personaId} (dept ${dept})` +
              (stderr ? `: ${stderr.trim().slice(0, 500)}` : ""),
            new Date().toISOString(),
          ],
        );
      } catch (writeErr) {
        console.warn(
          `[persona-selector] could not record persona_completion_failed for task ${taskId}:`,
          (writeErr as Error)?.message ?? writeErr,
        );
      }
    } else {
      console.log(
        `[persona-selector] record-completion OK for task ${taskId} ` +
        `(persona ${personaId}, dept ${dept})`
      );
    }
  });

  // Detach so the child can outlive this request/process without blocking.
  child.unref();
}

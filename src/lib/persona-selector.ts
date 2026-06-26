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
import { DB_PATH } from "@/lib/db";

// Promisified async version — never blocks the event loop.
const execFileAsync = promisify(execFile);

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

export interface PersonaSelectionResult {
  persona_id: string | null;
  persona_name: string;
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
 * Select a persona for a task.
 *
 * @param taskId          Database task id (used for logging only).
 * @param taskDescription Title + description concatenated.
 * @param departmentId    Department slug (e.g. "sales", "marketing"). Pass null to fall back to "general".
 * @returns               JSON result from the Python script, or null on failure.
 */
export async function selectPersonaForTask(
  taskId: string,
  taskDescription: string,
  departmentId: string | null
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
    const { stdout: output } = await execFileAsync(
      "python3",
      [scriptPath, "--task", taskDescription, "--department", dept, "--task-id", taskId, "--format", "json"],
      {
        encoding: "utf-8",
        timeout: 30_000,
        env: {
          ...process.env,
          DASHBOARD_DB_PATH: DB_PATH,
          OPENCLAW_TASK_ID: taskId,
          ...(companyConfigHint ? { OPENCLAW_COMPANY_CONFIG: companyConfigHint } : {}),
        },
      }
    );

    const result = JSON.parse(output) as Partial<PersonaSelectionResult>;

    return {
      persona_id: result.persona_id ?? null,
      persona_name:
        result.persona_name ||
        (result.persona_id
          ? result.persona_id.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
          : "N/A"),
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
    };
  } catch (error) {
    console.error(`[persona-selector] Failed for task ${taskId}:`, error);
    return null;
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

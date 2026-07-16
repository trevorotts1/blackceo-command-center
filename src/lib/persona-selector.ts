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
import { getDbPath, queryAll, queryOne, run } from "@/lib/db";
import { broadcast } from "@/lib/events";
import { ensureBlendGuardrail } from "@/lib/persona-dispatch";
import type { PersonaSlot } from "@/lib/sops";
import type {
  Task,
  PersonaBundle,
  BundleVoiceDecision,
  BundleTaskPersona,
  ResolvedAudience,
  AudienceConfirmSource,
} from "@/lib/types";

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
//
// PERS-01: these slugs MUST match the Python-side pins (DEFAULT_PERSONA_FALLBACK /
// GOVERNANCE_PERSONA_FALLBACK in persona-selector-v2.py) AND must exist in the
// seeded persona catalog (house-voice via triad 81->82). A fallback-pin site
// (resolvePersonaAndPin in tasks.ts, L7) should verify the resolved slug exists in
// the catalog before pinning and emit a loud P19 warn on a miss — pinning a
// non-existent slug leaves the doer unable to load a blueprint. The value parity
// (these constants vs the documented Python pins) is locked by
// tests/unit/pers01-fallback-pins.test.ts; cross-repo parity vs the live Python
// source is an integrator follow-up.
export const DEFAULT_PERSONA_FALLBACK = "blackceo-house-voice";
export const GOVERNANCE_PERSONA_FALLBACK = "covey-7-habits";

// CC selector spawn budget. Raised 30s -> 60s (F3.1 / A3): LLM-mode scoring of
// ~12 finalists x 4 layers plus a cold embedding call can exceed 30s on a loaded
// box, so a 30s cap turned a slow-but-valid selection into a null result (naked
// task). 60s gives the real selection room to land before the retry/fallback
// chain engages.
export const PERSONA_SELECT_TIMEOUT_MS = 60_000;

/**
 * D8 — true only when `filePath` exists, is readable, AND parses as valid JSON.
 * Guards resolveCompanyConfigHint so the CC never hands the Python selector a
 * path to a file that EXISTS but is empty/corrupt/mid-write — the prior
 * `fs.existsSync`-only check would forward that path anyway, and a downstream
 * consumer taught to actually read OPENCLAW_COMPANY_CONFIG (the ONB-side
 * detect_platform.py companion fix) would then crash or silently no-op on a
 * malformed file instead of falling back to its own path resolution.
 */
export function isValidJsonFile(filePath: string): boolean {
  try {
    JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return true;
  } catch {
    return false;
  }
}

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
 * D8: the CC side of this hint was already "forward-compatible" (this function) —
 * the finding's live defect is entirely on the Python/ONB side (skill 23
 * `detect_platform.py` never reads this env var; `verify-v2.1-installation.sh`
 * never asserts `ideal_customer` presence in the fleet fan-out). That companion
 * fix lives in the onboarding skills repo and is OUT OF SCOPE for this CC-repo
 * dispatch. What IS a genuine CC-side gap: the prior check only asked
 * `fs.existsSync` — a path can exist and still be empty/corrupt/mid-write. Now
 * VALIDATED (exists + parses as JSON — isValidJsonFile) before being forwarded,
 * so the CC never hands a downstream consumer (today: nothing reads it; tomorrow:
 * the ONB-side fix) a hint pointing at unusable JSON.
 *
 * Resolution order: explicit env override → command-center's config/company-config.json.
 * Returns undefined when no VALIDATED file is found (selector falls back to its own
 * path resolution — no behaviour change for the existing "no file" case; a corrupt
 * file now ALSO falls back rather than forwarding a bad path).
 */
export function resolveCompanyConfigHint(): string | undefined {
  const explicit = process.env.OPENCLAW_COMPANY_CONFIG;
  if (explicit && isValidJsonFile(explicit)) return explicit;
  try {
    const appConfig = path.join(process.cwd(), "config", "company-config.json");
    if (isValidJsonFile(appConfig)) return appConfig;
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
  /**
   * D1 (W7 persona-blend) — run `--blend` instead of the legacy single-persona
   * select: voice-first audience+topic blend, up to 10 task_personas, the
   * persona-bundle SUPERSET (see PersonaBundle). Content tasks pass this from
   * createTaskCore INSTEAD of `--combined` (the bundle already decomposes
   * task_personas internally — running both would double-decompose). Ignored
   * (falls back to the legacy select) on a box whose selector predates W7 —
   * see the unknown-argument retry in selectPersonaForTask.
   */
  blend?: boolean;
  /**
   * D3 (audience-confirm) — an operator-confirmed audience label, forwarded to
   * the selector as ENV `OPENCLAW_AUDIENCE` (never argv — the script's strict
   * argparse has no such flag; see persona-selector-v2.py's --blend comment).
   * Re-scores the VOICE decision against the confirmed audience and clears
   * `confirm_required` on the returned bundle. Only meaningful with `blend:true`.
   */
  audienceOverride?: string;
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
 * flags (DEP-1) are appended. When `blend` is true, `--blend` is appended (D1 /
 * W7 persona-blend) — the persona-bundle SUPERSET path (persona-selector-v2.py
 * `if getattr(args, "blend", False):`). Exported so a unit test can assert the
 * forwarding without spawning Python.
 */
export function buildSelectorArgv(
  scriptPath: string,
  taskDescription: string,
  dept: string,
  taskId: string,
  sopContext?: SopSelectorContext | null,
  blend?: boolean,
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
  if (blend) {
    argv.push("--blend");
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

/**
 * Run the FIRST argv tier that succeeds, falling back through progressively
 * FEWER flags ONLY on an unknown-argument rejection (PERS-03: never on a real
 * error — a genuine crash/bad-value must surface, not be swallowed as a
 * predates-this-flag signal). `tiers` must be ordered most-featured first
 * (e.g. [sop+blend, sop-only, bare]) so each fallback drops exactly the flag(s)
 * a stale box would reject.
 *
 * D1: generalizes the pre-existing single-level SOP retry (PERS-03) to also
 * cover `--blend` (a box may support DEP-1 SOP flags but predate W7 --blend,
 * or predate both) without a combinatorial explosion of nested try/catch.
 *
 * On total exhaustion, re-throws the FIRST (primary) tier's error — matching
 * PERS-03's existing contract that the surfaced failure is always the
 * highest-fidelity attempt's real cause, not a later fallback's incidental one.
 */
async function runSelectorWithFallback(
  runSelector: (argv: string[]) => Promise<string>,
  tiers: string[][],
  taskId: string,
): Promise<string> {
  let primaryErr: unknown;
  for (let i = 0; i < tiers.length; i++) {
    try {
      return await runSelector(tiers[i]);
    } catch (err) {
      if (i === 0) primaryErr = err;
      const isLastTier = i === tiers.length - 1;
      if (!isUnknownArgumentError(err) || isLastTier) {
        if (isLastTier && i > 0) {
          console.error(
            `[persona-selector] all fallback tiers exhausted for task ${taskId} — ` +
            `surfacing the primary (most-featured) attempt's error.`,
          );
        }
        throw i === 0 ? err : primaryErr;
      }
      console.warn(
        `[persona-selector] argv tier ${i} rejected (unrecognized argument) for task ${taskId} ` +
        `— retrying with reduced flags (box predates that feature).`,
      );
    }
  }
  // Unreachable when tiers is non-empty (every branch above returns or throws).
  throw primaryErr;
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
  /**
   * PERSONA-BLEND — the matcher's persona-bundle SUPERSET (voice decision, resolved
   * audience, blend directive, up-to-10 task-personas). NULL when the matcher emitted
   * only the legacy single-persona shape (a non-content task, or a pre-blend matcher):
   * the CC then behaves EXACTLY as before. `parsePersonaBundle` normalizes it and
   * `persistPersonaBundle` writes it to task_persona_bundle + the mirror columns.
   */
  bundle?: PersonaBundle | null;
}

/**
 * P2-02 — the stored one-sentence WHY for a persona pick, surfaced in the
 * TaskModal "Who's Working On This" panel.
 *
 * Doctrine (spec step 1): "reuse the selection event's message if the scorer
 * already writes one — READ persona selection code first and reuse before
 * adding." So the precedence is:
 *   1. the scorer's own `message` (its human explanation), when it wrote one;
 *   2. else the blend voice decision's `why` (audience / topic persona rationale);
 *   3. else an honest SYNTHESIZED sentence naming the persona, the mode, and the
 *      match strength — never a stub, never a fabricated specific claim.
 *
 * Returns a single clean sentence (collapsed whitespace, no newlines, terminating
 * period) so the panel renders one tidy line. Returns `null` for a no-match
 * result (`persona_id` absent) so the caller writes nothing and the panel shows
 * its honest empty-state rather than a fabricated reason.
 */
export function buildPersonaReason(result: PersonaSelectionResult | null | undefined): string | null {
  if (!result || !result.persona_id) return null;

  const toSentence = (raw: string): string => {
    // Collapse any newlines / runs of whitespace into single spaces so a
    // multi-line scorer message never renders as a raw dump, then ensure a
    // terminating period.
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return /[.!?]$/.test(clean) ? clean : `${clean}.`;
  };

  // 1. Reuse the scorer's own explanation verbatim (as a single tidy sentence).
  const scorerMsg = typeof result.message === 'string' ? toSentence(result.message) : '';
  if (scorerMsg) return scorerMsg;

  // 2. Reuse the blend voice decision's rationale when present.
  const voiceWhy =
    result.bundle?.voice?.audience_persona?.why ||
    result.bundle?.voice?.topic_persona?.why ||
    null;
  if (voiceWhy) {
    const whySentence = toSentence(voiceWhy);
    if (whySentence) return whySentence;
  }

  // 3. Synthesize an honest sentence from what the scorer DID return.
  const name = result.persona_name && result.persona_name !== 'N/A'
    ? result.persona_name
    : result.persona_id;
  const mode = result.interaction_mode || 'leadership';
  const category = result.task_category ? ` for ${result.task_category} work` : '';
  const score = typeof result.score === 'number' && result.score > 0
    ? ` (match ${Math.round(result.score * 100)}%)`
    : '';
  return toSentence(
    `${name} was matched to this task${category} in ${mode} mode${score}`,
  );
}

// ─── PERSONA-BLEND BUNDLE PARSE + PERSIST ────────────────────────────────────

/** True when a raw selector result carries any persona-bundle SUPERSET field. */
function rawHasBundleFields(raw: Record<string, unknown>): boolean {
  return (
    raw.voice !== undefined ||
    raw.blend_directive !== undefined ||
    raw.resolved_audience !== undefined ||
    raw.task_personas !== undefined ||
    raw.confirm_required !== undefined
  );
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function normalizeVoice(raw: unknown): BundleVoiceDecision {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const readPersona = (p: unknown): { id: string | null; why?: string | null } | null => {
    if (!p || typeof p !== "object") return null;
    const o = p as Record<string, unknown>;
    return { id: asString(o.id), why: asString(o.why) };
  };
  return {
    audience_persona: readPersona(v.audience_persona),
    topic_persona: readPersona(v.topic_persona),
    collapsed: v.collapsed === true,
    collapsed_persona_id: asString(v.collapsed_persona_id),
    topic_as_task_guidance: v.topic_as_task_guidance === true,
  };
}

/**
 * D2 — extract a display label from one raw `resolved_audience.candidates[]`
 * entry. The real matcher (persona_blend.py `_candidate()`, persona_blend.py:
 * 472-478) emits CANDIDATE OBJECTS: `{label, audience_persona_id, matched_tags,
 * why?}` — never bare strings. The prior parser kept only
 * `typeof c === "string"` entries, so every real `--blend` run filtered the
 * whole array to `[]` (candidates always empty; buildAudiencePrompt then always
 * rendered "no ICP audiences on file" and the single-candidate audienceLabel
 * fallback in persistPersonaBundle was permanently dead). A bare string is also
 * accepted so a legacy/future selector emitting the pre-blend shape still
 * parses unchanged (back-compat / non-breaking).
 */
function candidateLabel(c: unknown): string | null {
  if (typeof c === "string") return c.trim() || null;
  if (c && typeof c === "object") {
    const label = (c as Record<string, unknown>).label;
    if (typeof label === "string" && label.trim()) return label.trim();
  }
  return null;
}

/**
 * D4 — map the matcher's string confidence enum to the numeric scale the CC's
 * audience-confirm gate compares against AUDIENCE_HIGH_CONFIDENCE (tasks.ts).
 * persona_blend.py's resolve_audience() (persona_blend.py:441-469) emits
 * confidence as one of the strings 'high' | 'medium' | 'none' — never a number
 * — so the prior `typeof a.confidence === "number"` check coerced every real
 * `--blend` result to 0, making the "single high-confidence ICP → CONFIRM
 * prompt" branch (buildAudiencePrompt, tasks.ts) unreachable in production.
 * Numeric passthrough is kept for the fixture/test shape and any future
 * selector that emits a number directly.
 */
function normalizeAudienceConfidence(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    switch (raw.trim().toLowerCase()) {
      case "high": return 0.9;
      case "medium": return 0.6;
      case "none": return 0;
    }
  }
  return 0;
}

function normalizeResolvedAudience(raw: unknown): ResolvedAudience | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const validSources: AudienceConfirmSource[] = ["onboarding_icp", "operator_confirmed", "asked"];
  const source = (validSources.includes(a.source as AudienceConfirmSource)
    ? a.source
    : "asked") as AudienceConfirmSource;
  const candidates = Array.isArray(a.candidates)
    ? (a.candidates.map(candidateLabel).filter((c): c is string => c !== null))
    : [];
  const confidence = normalizeAudienceConfidence(a.confidence);
  return { source, candidates, confidence, label: asString(a.label), id: asString(a.id) };
}

function normalizeTaskPersonas(raw: unknown): BundleTaskPersona[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 10) // up-to-10 task personas — hard cap mirrors the matcher contract
    .map((r, i) => {
      const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      return {
        seq: typeof o.seq === "number" ? o.seq : i + 1,
        part: asString(o.part),
        persona_id: asString(o.persona_id),
        why: asString(o.why),
      };
    });
}

/**
 * Normalize a raw selector result into a typed PersonaBundle, or NULL when the
 * result carries no bundle SUPERSET fields (legacy / non-content result → the CC
 * behaves as before). The mandatory style-inspired-NOT-impersonation guardrail is
 * ALWAYS injected into blend_directive here — even if the matcher omitted it — so
 * the CC is the last, non-bypassable line of defense on the guardrail.
 */
/**
 * A-U5 — normalize a raw `scope_hint` echo (persona_blend.py's `build_bundle`
 * echoes the caller's dict back verbatim on `raw.scope_hint`). Returns null
 * when absent/malformed — never fabricates a hint the matcher didn't send.
 */
function normalizeScopeHint(raw: unknown): PersonaBundle["scope_hint"] {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  return {
    page_role: asString(h.page_role),
    page_slug: asString(h.page_slug),
    conversion_goal: asString(h.conversion_goal),
    part_id: asString(h.part_id),
    // U115 (E6-1, closes G7) — carry the per-part role/stage through when a
    // caller's scope_hint supplies them (see PersonaBundleScopeHint's header
    // comment for why this is a CC-side persist contract, not an echo of the
    // ONB matcher's own internal call).
    part_role: asString(h.part_role),
    stage: asString(h.stage),
  };
}

/** U116 — the five ADD-2 outside-world comms types (COMMS_TYPES in the
 * ONB-side comms_audience_trigger.py, kept in sync manually — that module is
 * out of this repo). */
const COMMS_TYPES = ["page", "blog", "email", "sms", "social"] as const;

/**
 * U116 (E6-2 / ADD-2) — normalize the bundle-ROOT `audience_source` field
 * (comms_audience_trigger.py:350, `bundle["audience_source"] =
 * audience_conf["audience_source"]`) into the strict standard|specific
 * union, or null when absent/malformed.
 *
 * ⚠️ Reads `raw.audience_source` — the TOP-LEVEL key on the raw selector
 * result — NEVER `raw.resolved_audience.source` (that is the migration-090
 * provenance field `normalizeResolvedAudience` above already owns, values
 * onboarding_icp|operator_confirmed|asked). A future edit that redirects
 * this function to read the nested field would silently reproduce the exact
 * two-different-`audience_source`-fields collision the U116 CC-leg scope
 * analysis flagged as the single biggest trap in this build — see
 * tests/unit/u116-comms-audience-persist.test.ts's dedicated collision
 * regression test.
 */
function normalizeCommsAudienceSource(raw: unknown): 'standard' | 'specific' | null {
  return raw === 'standard' || raw === 'specific' ? raw : null;
}

/** U116 — normalize the bundle-ROOT `comms_type` field
 * (comms_audience_trigger.py:352) into one of the five ADD-2 comms types,
 * or null when absent/malformed/unrecognized. */
function normalizeCommsType(raw: unknown): PersonaBundle["comms_type"] {
  return typeof raw === "string" && (COMMS_TYPES as readonly string[]).includes(raw)
    ? (raw as PersonaBundle["comms_type"])
    : null;
}

export function parsePersonaBundle(rawResult: unknown): PersonaBundle | null {
  if (!rawResult || typeof rawResult !== "object") return null;
  const raw = rawResult as Record<string, unknown>;
  if (!rawHasBundleFields(raw)) return null;

  const voice = normalizeVoice(raw.voice);
  const resolved_audience = normalizeResolvedAudience(raw.resolved_audience);
  const task_personas = normalizeTaskPersonas(raw.task_personas);
  // NON-REMOVABLE guardrail: whatever the matcher sent (or didn't), the directive
  // the CC persists + renders always carries the style-inspired clause.
  const blend_directive = ensureBlendGuardrail(asString(raw.blend_directive));

  return {
    topic: asString(raw.topic),
    resolved_audience,
    confirm_required: raw.confirm_required === true,
    voice,
    blend_directive,
    task_personas,
    rationale: (raw.rationale && typeof raw.rationale === "object")
      ? (raw.rationale as Record<string, unknown>)
      : undefined,
    funnel: (raw.funnel && typeof raw.funnel === "object")
      ? (raw.funnel as Record<string, unknown>)
      : undefined,
    fallbacks: (raw.fallbacks && typeof raw.fallbacks === "object")
      ? (raw.fallbacks as Record<string, unknown>)
      : undefined,
    catalog_version: asString(raw.catalog_version),
    // A-U5 — additive: absent on any raw result that never carried a `scope`
    // key (every pre-A-U5-shaped selector result, and every A-U5-shaped one
    // where the caller omitted scope_hint) so this is a strict superset add.
    scope: asString(raw.scope),
    scope_hint: normalizeScopeHint(raw.scope_hint),
    // U116 — additive: absent on any raw result not produced through the
    // comms trigger (every pre-U116-shaped selector result, and any
    // COMMS_AUDIENCE_PROMPT=0 revert-path result).
    comms_audience_source: normalizeCommsAudienceSource(raw.audience_source),
    comms_type: normalizeCommsType(raw.comms_type),
  };
}

/**
 * Persist a parsed persona bundle for a task: one row in `task_persona_bundle`
 * (full JSON + catalog version + audience confirm state) plus the mirror columns
 * on `tasks` (voice/topic persona ids, confirmed audience, voice_collapsed,
 * blend_directive). Idempotent per task (task_id UNIQUE → ON CONFLICT upsert).
 *
 * The confirm state is derived from the bundle: `confirm_required` → 'pending'
 * (GATES dispatch until the operator confirms the audience) else 'not_required'.
 * Fail-soft: a pre-090 DB (columns/table absent) logs a warning and no-ops rather
 * than breaking the create-time persona pin.
 *
 * @returns true when the bundle row was written, false on a tolerated no-op/error.
 */
export function persistPersonaBundle(
  taskId: string,
  bundle: PersonaBundle,
): boolean {
  const confirmState = bundle.confirm_required ? "pending" : "not_required";
  const now = new Date().toISOString();
  const catalogVersion = bundle.catalog_version ?? null;
  // Guarantee the guardrail one more time at the persist boundary (defense in depth).
  const blendDirective = ensureBlendGuardrail(bundle.blend_directive);
  const voice = bundle.voice;
  // The VOICE persona (the voice the doer writes IN) is the collapsed persona when
  // one covers both, else the audience persona, else the topic persona.
  const voicePersonaId =
    (voice.collapsed ? voice.collapsed_persona_id : voice.audience_persona?.id) ||
    voice.audience_persona?.id ||
    voice.topic_persona?.id ||
    null;
  const topicPersonaId = voice.topic_persona?.id ?? null;
  const audience = bundle.resolved_audience;
  const audienceId = audience?.id ?? null;
  const audienceLabel =
    audience?.label ?? (audience?.candidates.length === 1 ? audience.candidates[0] : null);
  const audienceSource = audience?.source ?? null;
  // U116 (E6-2 / ADD-2, migration 108) — the BUNDLE-ROOT comms-audience-prompt
  // fields, DISTINCT from `audienceSource` above (that reads
  // `bundle.resolved_audience.source`; these read `bundle.comms_audience_source`
  // / `bundle.comms_type`, the top-level fields the ONB-side
  // comms_audience_trigger.py stamps). Never conflate the two — see the
  // dedicated collision regression test
  // (tests/unit/u116-comms-audience-persist.test.ts).
  const commsAudienceSource = bundle.comms_audience_source ?? null;
  const commsType = bundle.comms_type ?? null;

  let wrote = false;
  try {
    run(
      `INSERT INTO task_persona_bundle (task_id, bundle_json, catalog_version, confirm_state, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         bundle_json = excluded.bundle_json,
         catalog_version = excluded.catalog_version,
         confirm_state = excluded.confirm_state`,
      [taskId, JSON.stringify({ ...bundle, blend_directive: blendDirective }), catalogVersion, confirmState, now],
    );
    wrote = true;
  } catch (err) {
    console.warn(`[persona-bundle] persist row failed for task ${taskId} (pre-090 DB?):`, (err as Error).message);
  }

  try {
    run(
      `UPDATE tasks
          SET voice_persona_id = ?,
              topic_persona_id = ?,
              audience_id = ?,
              audience_label = ?,
              audience_source = ?,
              voice_collapsed = ?,
              blend_directive = ?,
              comms_audience_source = ?,
              comms_type = ?
        WHERE id = ?`,
      [
        voicePersonaId,
        topicPersonaId,
        audienceId,
        audienceLabel,
        audienceSource,
        voice.collapsed ? 1 : 0,
        blendDirective,
        commsAudienceSource,
        commsType,
        taskId,
      ],
    );
  } catch (err) {
    console.warn(`[persona-bundle] mirror-column update failed for task ${taskId} (pre-090/pre-108 DB?):`, (err as Error).message);
  }

  return wrote;
}

/**
 * A-U5 — persist ONE per-page/scope persona bundle: a `task_persona_bundle_scope`
 * row keyed `(task_id, scope)` (migration 104, composite UNIQUE, idempotent
 * upsert). Mirrors `persistPersonaBundle` above exactly (same guardrail
 * defense-in-depth, same fail-soft try/catch posture on a pre-104 DB) but
 * NEVER touches `task_persona_bundle` (090) or its mirror columns on `tasks`
 * — the unscoped task-level default stays exactly what `persistPersonaBundle`
 * last wrote there, untouched by any number of scoped-bundle writes.
 *
 * `scope` is the ONB matcher's resolved scope key (persona_blend.py
 * `build_bundle(scope_hint=...)` -> `bundle.scope`, `_resolve_scope_key`:
 * page_slug > page_role > part_id). `bundle.scope_hint` (when present) is the
 * source of the persisted page_role/page_slug/conversion_goal columns.
 *
 * @returns true when the scoped row was written, false on a tolerated no-op/error.
 */
export function persistPersonaBundleScope(
  taskId: string,
  scope: string,
  bundle: PersonaBundle,
): boolean {
  if (!scope || !scope.trim()) {
    console.warn(`[persona-bundle-scope] refused to persist an empty scope key for task ${taskId}`);
    return false;
  }
  const now = new Date().toISOString();
  const catalogVersion = bundle.catalog_version ?? null;
  // Guarantee the guardrail one more time at the persist boundary (defense in
  // depth) — same discipline as persistPersonaBundle.
  const blendDirective = ensureBlendGuardrail(bundle.blend_directive);
  const hint = bundle.scope_hint;
  const pageRole = hint?.page_role ?? null;
  const pageSlug = hint?.page_slug ?? null;
  const conversionGoal = hint?.conversion_goal ?? null;
  const scopeReason =
    (bundle.rationale && typeof bundle.rationale.scope === "string" ? bundle.rationale.scope : null);

  // The resolved VOICE persona for THIS page/scope — same precedence
  // persistPersonaBundle uses for the unscoped path (collapsed > audience >
  // topic) — stored as a mirror column so the chip row never re-parses JSON.
  const voice = bundle.voice;
  const voicePersonaId =
    (voice.collapsed ? voice.collapsed_persona_id : voice.audience_persona?.id) ||
    voice.audience_persona?.id ||
    voice.topic_persona?.id ||
    null;
  const voicePersonaName = voicePersonaId
    ? voicePersonaId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : null;

  // U115 (E6-1, closes G7) — the 5 per-part governance mirror columns
  // (migration 107). Mirrors the ONB `govern_task_parts` map-record's own
  // field names verbatim: part_role/stage (from this call's scope_hint —
  // see PersonaBundleScopeHint's header comment), topic_persona_id (the
  // TOPIC-expertise persona, distinct from the VOICE persona above),
  // audience_label/audience_source (the resolved+confirmed audience —
  // acceptance (c)'s "naming its blend + audience"). Every field NEVER
  // fabricated: null when the caller's bundle didn't carry it.
  const partRole = hint?.part_role ?? null;
  const stage = hint?.stage ?? null;
  const topicPersonaId = voice.topic_persona?.id ?? null;
  const audienceLabel = bundle.resolved_audience?.label ?? null;
  const audienceSource = bundle.resolved_audience?.source ?? null;

  try {
    run(
      `INSERT INTO task_persona_bundle_scope
         (task_id, scope, page_role, page_slug, conversion_goal,
          voice_persona_id, voice_persona_name, bundle_json, catalog_version,
          scope_reason, part_role, stage, topic_persona_id, audience_label,
          audience_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, scope) DO UPDATE SET
         page_role = excluded.page_role,
         page_slug = excluded.page_slug,
         conversion_goal = excluded.conversion_goal,
         voice_persona_id = excluded.voice_persona_id,
         voice_persona_name = excluded.voice_persona_name,
         bundle_json = excluded.bundle_json,
         catalog_version = excluded.catalog_version,
         scope_reason = excluded.scope_reason,
         part_role = excluded.part_role,
         stage = excluded.stage,
         topic_persona_id = excluded.topic_persona_id,
         audience_label = excluded.audience_label,
         audience_source = excluded.audience_source`,
      [
        taskId,
        scope,
        pageRole,
        pageSlug,
        conversionGoal,
        voicePersonaId,
        voicePersonaName,
        JSON.stringify({ ...bundle, blend_directive: blendDirective }),
        catalogVersion,
        scopeReason,
        partRole,
        stage,
        topicPersonaId,
        audienceLabel,
        audienceSource,
        now,
      ],
    );
    return true;
  } catch (err) {
    console.warn(
      `[persona-bundle-scope] persist row failed for task ${taskId} scope ${scope} (pre-104 DB?):`,
      (err as Error).message,
    );
    return false;
  }
}

/**
 * A-U5 — read every per-page/scope bundle row for a task, ordered by
 * created_at (stable page order for the chip row). Tolerant: returns []
 * when `task_persona_bundle_scope` is absent (pre-migration-104 box) or on
 * any query error — mirrors `loadSubtaskPersonas`'s fail-soft contract so a
 * board fetch never breaks on a missing table. Reads the `voice_persona_id`/
 * `voice_persona_name` mirror columns directly — never re-parses bundle_json
 * (same "mirror columns so consumers don't re-parse the blob" rationale as
 * migration 090's tasks columns).
 */
export interface PersonaBundleScopeRow {
  scope: string;
  page_role: string | null;
  page_slug: string | null;
  conversion_goal: string | null;
  persona_id: string | null;
  persona_name: string | null;
  scope_reason: string | null;
  // U115 (E6-1, closes G7; migration 107) — per-part governance mirror
  // columns. Null on every pre-U115 (per-page) row.
  part_role: string | null;
  stage: string | null;
  topic_persona_id: string | null;
  audience_label: string | null;
  audience_source: string | null;
}

export function loadPersonaBundleScopes(taskId: string): PersonaBundleScopeRow[] {
  try {
    const rows = queryAll<{
      scope: string;
      page_role: string | null;
      page_slug: string | null;
      conversion_goal: string | null;
      voice_persona_id: string | null;
      voice_persona_name: string | null;
      scope_reason: string | null;
      part_role: string | null;
      stage: string | null;
      topic_persona_id: string | null;
      audience_label: string | null;
      audience_source: string | null;
    }>(
      `SELECT scope, page_role, page_slug, conversion_goal,
              voice_persona_id, voice_persona_name, scope_reason,
              part_role, stage, topic_persona_id, audience_label, audience_source
         FROM task_persona_bundle_scope
        WHERE task_id = ?
        ORDER BY created_at ASC`,
      [taskId],
    );
    return rows.map((r) => ({
      scope: r.scope,
      page_role: r.page_role,
      page_slug: r.page_slug,
      conversion_goal: r.conversion_goal,
      persona_id: r.voice_persona_id,
      persona_name: r.voice_persona_name,
      scope_reason: r.scope_reason,
      part_role: r.part_role,
      stage: r.stage,
      topic_persona_id: r.topic_persona_id,
      audience_label: r.audience_label,
      audience_source: r.audience_source,
    }));
  } catch {
    return [];
  }
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
        bundle: parsePersonaBundle(fixture),
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
    // D3: an operator-confirmed audience is forwarded via ENV ONLY — the script's
    // strict argparse has no --audience flag (mirrors the OPENCLAW_COMPANY_CONFIG
    // rationale above). persona_blend.py's resolve_audience() reads it as
    // `audience_override`, which short-circuits to source='operator_confirmed',
    // confirm_required=False.
    const audienceOverride = opts?.audienceOverride?.trim();
    const spawnEnv = {
      ...process.env,
      DASHBOARD_DB_PATH: getDbPath(),
      OPENCLAW_TASK_ID: taskId,
      ...(companyConfigHint ? { OPENCLAW_COMPANY_CONFIG: companyConfigHint } : {}),
      ...(audienceOverride ? { OPENCLAW_AUDIENCE: audienceOverride } : {}),
    };

    const runSelector = async (argv: string[]): Promise<string> => {
      const { stdout } = await execFileAsync("python3", argv, {
        encoding: "utf-8",
        timeout: timeoutMs,
        env: spawnEnv,
      });
      return stdout;
    };

    // F3.4 / D1: fold SOP context and/or --blend into the match when requested.
    // DEP-1 taught the selector --sop-*; W7 taught it --blend. A box predating
    // either rejects the unknown flag with a strict-argparse SystemExit, so we
    // fall back tier-by-tier (most-featured first) rather than let the whole
    // task fail selection — fail-closed: degrade toward a plainer match, NEVER
    // to a naked/unselected persona. See runSelectorWithFallback / PERS-03.
    const wantsSop = hasSopContext(sopContext);
    const wantsBlend = Boolean(opts?.blend);
    const baseArgv = buildSelectorArgv(scriptPath, taskDescription, dept, taskId);
    const sopArgv = wantsSop
      ? buildSelectorArgv(scriptPath, taskDescription, dept, taskId, sopContext)
      : baseArgv;
    const fullArgv = wantsBlend
      ? buildSelectorArgv(scriptPath, taskDescription, dept, taskId, wantsSop ? sopContext : null, true)
      : sopArgv;

    // Tiers ordered most-featured → least, de-duplicated: [sop+blend, sop-only,
    // bare]. When neither sop nor blend is requested this collapses to a single
    // [baseArgv] tier, preserving the exact pre-D1 behavior (one spawn, errors
    // propagate unchanged to the outer catch below).
    const tiers: string[][] = [fullArgv];
    if (wantsBlend && wantsSop) tiers.push(sopArgv);
    if (wantsBlend || wantsSop) tiers.push(baseArgv);

    const output = await runSelectorWithFallback(runSelector, tiers, taskId);

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
      // Parse the persona-bundle SUPERSET when the matcher emitted it; NULL for a
      // legacy single-persona result so existing consumers are unaffected.
      bundle: parsePersonaBundle(result),
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
    DASHBOARD_DB_PATH: getDbPath(),
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
 *
 * PERS-08: pass `plan` (the in-memory `subtask_personas[]` parsed from
 * decompose-task.py stdout) to broadcast it DIRECTLY. The decompose child writes
 * `task_subtask_persona` asynchronously (a detached spawn), so re-reading the
 * table here can race and return an empty plan that clobbers the card. When no
 * in-memory plan is supplied we fall back to a table read, and if that read is
 * empty we SKIP the broadcast rather than overwrite a good plan with nothing.
 */
export function broadcastPersonaPlan(taskId: string, plan?: SubtaskPersona[]): void {
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
    const subtask_personas =
      plan && plan.length > 0 ? plan : loadSubtaskPersonas(taskId);
    if (!subtask_personas || subtask_personas.length === 0) {
      // Empty table read (likely the detached decompose child has not committed
      // yet) — do NOT broadcast an empty plan over an existing one.
      return;
    }
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
 * @param role        D7 — optional analytics tag ('primary' | 'voice' | 'topic' |
 *                    'subtask') identifying WHICH slot in a persona-blend this
 *                    completion credits, forwarded as `--persona-role`. A box
 *                    whose selector predates the flag rejects it (strict argparse
 *                    SystemExit) — detected the same way as the SOP/--blend argv
 *                    tiers (isUnknownArgumentError) and retried ONCE without the
 *                    flag, so a stale box still records the completion, just
 *                    without the role tag.
 */
export function spawnRecordCompletion(
  taskId: string,
  personaId: string,
  deptSlug: string | null | undefined,
  taskOutput?: string | null,
  role?: string | null,
): void {
  const scriptPath = resolveScriptPath();
  const dept = deptSlug || "general";
  // Python requires --task-output (or --task-output-file); always supply it.
  // Fall back to the task id so the argument is never omitted.
  const outputText = (taskOutput && taskOutput.trim()) ? taskOutput.trim() : taskId;
  const roleTag = role && role.trim() ? role.trim() : undefined;

  const baseArgv = [
    scriptPath,
    "--mode", "record-completion",
    "--task-id", taskId,
    "--persona-id", personaId,
    "--department", dept,
    "--task-output", outputText,
  ];
  const argv = roleTag ? [...baseArgv, "--persona-role", roleTag] : baseArgv;

  runRecordCompletionSpawn(taskId, personaId, dept, argv, roleTag ? baseArgv : null);
}

/**
 * D7: one `record-completion` child spawn, with a single graceful downgrade.
 *
 * `fallbackArgv`, when non-null, is the SAME call WITHOUT `--persona-role` —
 * retried exactly once if THIS spawn dies on an unrecognized-argument SystemExit
 * (a box whose selector predates the analytics flag). Any OTHER non-zero exit is
 * logged + audited exactly as before (persona_completion_failed), never retried —
 * PERS-03's "don't swallow a real crash as a predates-this-feature signal"
 * discipline applies here too.
 */
function runRecordCompletionSpawn(
  taskId: string,
  personaId: string,
  dept: string,
  argv: string[],
  fallbackArgv: string[] | null,
): void {
  const child = spawn(
    "python3",
    argv,
    {
      detached: true,
      stdio: "pipe",
      env: { ...process.env, DASHBOARD_DB_PATH: getDbPath() },
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
      if (fallbackArgv && isUnknownArgumentError({ stderr })) {
        console.warn(
          `[persona-selector] record-completion rejected --persona-role for task ${taskId} ` +
          `(box predates the flag) — retrying without it.`
        );
        runRecordCompletionSpawn(taskId, personaId, dept, fallbackArgv, null);
        return;
      }
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

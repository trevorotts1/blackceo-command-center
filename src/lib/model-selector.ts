/**
 * Task-time model selector — Layer 2 of the Intelligent Model Selector.
 *
 * Given a task (title, description, department) and the client's available
 * model inventory, selects the best model using:
 *   A. Nature + difficulty classification → purpose tier (heavy/mid/fast)
 *   B. Required modality hard-filter (vision tasks can NEVER resolve to text-only)
 *   C. Cascade: Ollama Cloud (`ollama-cloud/*`) → OpenRouter open-source /
 *      self-hosted Ollama (`ollama-local/*`) → Free (last resort). See
 *      `tierOf()` for the exact prefix matching — it must stay in sync with
 *      whatever id shape each connector in `src/lib/model-providers/` emits.
 *   D. Tie-break: capability fit → version number → cost band
 *
 * Never returns 'openrouter/free'. Returns needs_owner_input when no valid
 * model exists for the combination of modality + tier + available inventory.
 *
 * Forbidden: Anthropic models. Always.
 */

import type { ModelCapability, ModelRegistryEntry } from './model-registry-types';

// ─── Constants ──────────────────────────────────────────────────────────────

export const NEEDS_OWNER_INPUT = 'needs_owner_input' as const;

/**
 * Anthropic is forbidden for all client dispatches. The list below is anchored
 * on provider ROOTS, never on specific generations, so it catches renamed and
 * future Claude families without a code change (the MODEL-01 hardening):
 *
 *   - `anthropic/`            canonical provider-prefixed route
 *   - `anthropic.`            Bedrock/Vertex dot-form (`anthropic.claude-3-5-…`,
 *                             `anthropic.claude-instant-v1`, any future gen)
 *   - `openrouter/anthropic/` nested OpenRouter route
 *   - `claude-`               any Claude family/generation slug carrying no
 *                             provider prefix: `claude-5`, `claude-fable-5`,
 *                             `claude-mythos-5`, `claude-instant`, `claude-opus-…`
 *
 * The previous per-generation list (`claude-3`, `claude-4`, `claude-opus`, …)
 * silently ALLOWED `anthropic.claude-…` (dot route), `claude-5`/future gens, and
 * named future models like `claude-fable-5` / `claude-instant`.
 *
 * Bare `opus` / `sonnet` / `haiku` (no vendor prefix and no `claude-` stem) are
 * NOT routable model ids on any connector, so they are deliberately NOT matched:
 * a substring match on those bare words would false-positive on unrelated ids
 * (e.g. a vendor whose slug merely contains "sonnet"). Every real Anthropic
 * route carries one of the four roots above.
 *
 * Kept at BYTE parity with the onboarding Python selector's FORBIDDEN_PREFIXES
 * (shared-utils/select_model.py). `isForbidden` matches any root appearing
 * ANYWHERE in the lower-cased model_id (substring, not just prefix) — mirroring
 * the Python `mid.startswith(p) or p in mid`.
 */
const FORBIDDEN_PREFIXES = [
  'anthropic/',
  'anthropic.',
  'openrouter/anthropic/',
  'claude-',
];

/**
 * OpenRouter open-source vendor prefixes (Tier 2).
 * Proprietary OpenAI/Gemini routes are NOT in Tier 2.
 */
const OPENROUTER_OSS_PREFIXES = [
  'openrouter/deepseek/',
  'openrouter/moonshot/',
  'openrouter/qwen/',
  'openrouter/qwen3',
  'openrouter/z-ai/',
  'openrouter/thudm/',       // GLM/Z-AI family
  'openrouter/xiaomi/',
  'openrouter/mistralai/',
  'openrouter/meta-llama/',
  'openrouter/google/gemma',  // Gemma = open-source (not Gemini Pro)
  'openrouter/microsoft/',    // Phi family
  'openrouter/01-ai/',        // Yi family
  'openrouter/nousresearch/',
  'openrouter/cohere/',
];

type ModelTier = 1 | 2 | 3; // 1=OllamaCloud, 2=OpenRouterOSS, 3=Free

/**
 * BUG FIX (flagship cascade never firing): the real Ollama Cloud connector
 * (`src/lib/model-providers/ollama-cloud.ts`) emits ids shaped
 * `ollama-cloud/<model>` (e.g. `ollama-cloud/llama3.3:70b`,
 * pricing_model 'flat_rate_plan') — NOT `ollama/<model>:cloud`. The original
 * check here only matched the latter, so `ollama-cloud/*` never classified
 * as Tier 1 and fell through to Tier 3 (free-only), where it was then
 * filtered out entirely by the tier-3 `isFree` guard. Net effect: the
 * advertised "Ollama Cloud → OpenRouter OSS → Free" cascade could NEVER
 * actually select Ollama Cloud. Fixed by recognizing the real connector
 * prefix; the legacy `ollama/<model>:cloud` shape is also still recognized
 * for back-compat with existing fixtures/data written under the old shape.
 *
 * The self-hosted local connector (`ollama-local.ts`) emits
 * `ollama-local/<model>` and is always unmetered/free (pricing_model
 * 'free') — it is grouped into Tier 2 alongside OpenRouter open-source
 * models (both are "run it yourself" open-weight options), same as the
 * legacy no-`:cloud`-suffix `ollama/*` shape was already treated.
 */
function tierOf(modelId: string): ModelTier {
  if (modelId.startsWith('ollama-cloud/')) return 1;
  if (modelId.startsWith('ollama/') && modelId.includes(':cloud')) return 1;
  if (OPENROUTER_OSS_PREFIXES.some((p) => modelId.startsWith(p))) return 2;
  // Anything openrouter/* not matched above that's free-tier goes to 3
  if (modelId.endsWith(':free') || modelId === 'openrouter/free') return 3;
  // Any other openrouter/* (proprietary routes) is NOT tier 2 — treat as 3
  if (modelId.startsWith('openrouter/')) return 3;
  // Self-hosted local Ollama (unmetered, open-source) — Tier 2.
  if (modelId.startsWith('ollama-local/')) return 2;
  // Legacy local ollama shape (no :cloud suffix) — same tier-2 treatment.
  if (modelId.startsWith('ollama/')) return 2;
  return 3;
}

export function isForbidden(modelId: string): boolean {
  // Substring (case-insensitive) match against the ROOT anchors — catches any
  // `anthropic/` or `anthropic.` (Bedrock/Vertex dot) route, nested
  // `openrouter/anthropic/`, and any `claude-` family/generation slug, mirroring
  // Python `_is_forbidden` (`mid.startswith(p) or p in mid`). Root anchoring
  // (not per-generation) means future/renamed Claude models stay forbidden with
  // no code change. Exported so the settings write/read path (MODEL-07) can
  // reject/hide a forbidden model without re-implementing the rule.
  const mid = modelId.toLowerCase();
  return FORBIDDEN_PREFIXES.some((p) => mid.includes(p));
}

export function isFree(modelId: string, entry?: ModelRegistryEntry): boolean {
  if (modelId.endsWith(':free') || modelId === 'openrouter/free') return true;
  if (entry?.pricing_model === 'free') return true;
  return false;
}

// ─── Difficulty + purpose-tier classification ────────────────────────────────

type PurposeTier = 'heavy' | 'mid' | 'fast';

const HARD_SIGNALS = [
  'strategy', 'architect', 'multi-step', 'legal', 'financial', 'compliance',
  'analyze', 'analysis', 'design', 'qc', 'quality check', 'audit',
  'research', 'evaluate', 'synthesize', 'plan', 'roadmap',
];
const SIMPLE_SIGNALS = [
  'classify', 'tag', 'yes/no', 'format', 'rename', 'lookup',
  'list', 'summarize short', 'confirm',
];

function classifyDifficulty(title: string, description?: string | null): PurposeTier {
  const text = `${title} ${description ?? ''}`.toLowerCase();
  if (HARD_SIGNALS.some((s) => text.includes(s))) return 'heavy';
  if (SIMPLE_SIGNALS.some((s) => text.includes(s))) return 'fast';
  return 'mid';
}

// ─── Modality detection ──────────────────────────────────────────────────────

export type TaskModality =
  | 'text'
  | 'vision'
  | 'image_generation'
  | 'video_generation'
  | 'audio_generation'
  | 'audio_transcription';

const VISION_SIGNALS = [
  'image', 'screenshot', 'photo', 'visual', 'look at', 'ocr', 'slide',
  'diagram', 'chart', 'graphic', 'picture', 'thumbnail', 'mockup',
  'inspect', 'review the image', 'visual qc', 'branding review',
];
const IMAGE_GEN_SIGNALS = [
  'generate image', 'create image', 'produce image', 'make image',
  'generate graphic', 'design graphic', 'create graphic', 'produce graphic',
  'generate photo', 'image generation',
];
const VIDEO_SIGNALS = [
  'video', 'storyboard', 'reel', 'clip', 'animation', 'motion',
];
const AUDIO_GEN_SIGNALS = [
  'generate audio', 'text to speech', 'tts', 'voiceover', 'narrate',
  'produce audio', 'synthesize voice',
];
const AUDIO_TRANSCRIBE_SIGNALS = [
  'transcribe', 'transcription', 'speech to text', 'stt', 'caption audio',
];

export function detectModality(
  title: string,
  description?: string | null,
): TaskModality {
  const text = `${title} ${description ?? ''}`.toLowerCase();
  // Image generation is more specific than vision, check first
  if (IMAGE_GEN_SIGNALS.some((s) => text.includes(s))) return 'image_generation';
  if (VIDEO_SIGNALS.some((s) => text.includes(s))) return 'video_generation';
  if (AUDIO_GEN_SIGNALS.some((s) => text.includes(s))) return 'audio_generation';
  if (AUDIO_TRANSCRIBE_SIGNALS.some((s) => text.includes(s))) return 'audio_transcription';
  if (VISION_SIGNALS.some((s) => text.includes(s))) return 'vision';
  return 'text';
}

// ─── Version tie-break ───────────────────────────────────────────────────────

function parseVersion(modelId: string): number[] {
  const match = modelId.match(/(\d+(?:\.\d+)*)/g);
  if (!match) return [0];
  return match[match.length - 1].split('.').map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ─── Cost band (replicates ModelCard.tsx getCostBand) ────────────────────────

type CostBand = 'free' | 'low' | 'mid' | 'high';

function getCostBand(entry: ModelRegistryEntry): CostBand {
  if (entry.pricing_model === 'free' || entry.input_cost_per_million === 0) return 'free';
  const cost = entry.input_cost_per_million ?? 0;
  if (cost <= 0.5) return 'low';
  if (cost <= 5) return 'mid';
  return 'high';
}

const COST_BAND_ORDER: Record<CostBand, number> = { free: 0, low: 1, mid: 2, high: 3 };

// ─── Capability fit scorer ────────────────────────────────────────────────────

const REASONING_DEPTS = ['ceo', 'executive', 'legal', 'compliance', 'billing', 'finance'];
const TOOL_USE_DEPTS = ['sales', 'operations', 'customer-support', 'openclaw-maintenance'];

function capabilityScore(
  entry: ModelRegistryEntry,
  modality: TaskModality,
  tier: PurposeTier,
  department?: string | null,
): number {
  let score = 0;
  const caps = new Set(entry.capabilities);

  // Modality match (should already be filtered, but score it)
  if (modality !== 'text' && caps.has(modality as ModelCapability)) score += 10;

  // Reasoning bonus for heavy tasks in reasoning-heavy depts
  if (tier === 'heavy' && caps.has('reasoning')) score += 3;
  if (tier === 'heavy' && caps.has('long_context')) score += 2;

  // Tool-use bonus for dept types that need it
  const dept = (department ?? '').toLowerCase();
  if (TOOL_USE_DEPTS.some((d) => dept.includes(d)) && caps.has('tool_use')) score += 2;
  if (REASONING_DEPTS.some((d) => dept.includes(d)) && caps.has('reasoning')) score += 2;

  // Code execution bonus for dev tasks
  if (dept.includes('development') && caps.has('code_execution')) score += 2;

  return score;
}

// ─── Text-serviceability (FM-6c) ─────────────────────────────────────────────
// A pure media-I/O model — e.g. a TTS endpoint like `gpt-4o-mini-tts` whose only
// capability is `audio_generation` — cannot produce the text/reasoning output a
// text task needs. The old `required_modality === 'text' → accept ANY model` rule
// let exactly such a model win a presentations/text task, pinning a TTS model as
// the task's reasoning `model_id` (the wrong-field symptom on the affected box).
// A model serves a text task only when it has at least one LANGUAGE capability
// (anything that is NOT a pure media-output or embeddings kind).
//
// MODEL-06: a row with NO declared capabilities is NO LONGER assumed text-capable.
// Every real connector emits at least `text` for a language model, so an empty
// capability set is an untyped / media-smuggle row (e.g. a bare image/video/TTS
// endpoint that never declared its output modality). Treating it as text-capable
// let such a row be pinned as a text task's reasoning model_id. Empty caps now
// fail closed — a text task never resolves onto an un-typed row.
const NON_LANGUAGE_OUTPUT_CAPS = new Set<ModelCapability>([
  'image_generation',
  'video_generation',
  'audio_generation',
  'audio_transcription',
  'embeddings',
]);

export function canServeTextTask(entry: ModelRegistryEntry): boolean {
  const caps = entry.capabilities ?? [];
  if (caps.length === 0) return false; // MODEL-06: untyped row — cannot prove text-capable, fail closed
  return caps.some((c) => !NON_LANGUAGE_OUTPUT_CAPS.has(c));
}

// ─── Main selector ────────────────────────────────────────────────────────────

export interface TaskModelSelection {
  model_id: string | typeof NEEDS_OWNER_INPUT;
  tier: ModelTier | null;
  modelSource: 'task_selector';
  required_modality: TaskModality;
  difficulty: PurposeTier;
  candidates_considered: number;
  needs_owner_input: boolean;
}

export interface SelectTaskModelInput {
  title: string;
  description?: string | null;
  department?: string | null;
  /** Pre-classified modality (overrides auto-detection if provided). */
  required_modality?: TaskModality;
  /** Available models from model_registry (status='active', provider available). */
  inventory: ModelRegistryEntry[];
}

export function selectTaskModel(input: SelectTaskModelInput): TaskModelSelection {
  const difficulty = classifyDifficulty(input.title, input.description);
  const required_modality = input.required_modality ?? detectModality(input.title, input.description);

  // Step B: hard-filter by modality. text tasks accept any model.
  const modalityCapability = required_modality as ModelCapability;
  const modalityFiltered = input.inventory.filter((m) => {
    if (isForbidden(m.model_id)) return false;
    if (m.model_id === 'openrouter/free' || m.model_id === NEEDS_OWNER_INPUT) return false;
    // FM-6c: a text task accepts any LANGUAGE model, but NOT a pure media/TTS
    // model (e.g. gpt-4o-mini-tts) that cannot produce text/reasoning output.
    if (required_modality === 'text') return canServeTextTask(m);
    return m.capabilities.includes(modalityCapability);
  });

  const candidates_considered = modalityFiltered.length;

  if (candidates_considered === 0) {
    return {
      model_id: NEEDS_OWNER_INPUT,
      tier: null,
      modelSource: 'task_selector',
      required_modality,
      difficulty,
      candidates_considered: input.inventory.length,
      needs_owner_input: true,
    };
  }

  // Step C: walk tiers in order 1 → 2 → 3
  for (const tier of [1, 2, 3] as ModelTier[]) {
    const inTier = modalityFiltered.filter((m) => tierOf(m.model_id) === tier);
    if (inTier.length === 0) continue;

    // Tier 3 (free) — log-worthy but allowed as last resort
    if (tier === 3) {
      // Only include genuinely free models in tier 3
      const freeOnly = inTier.filter((m) => isFree(m.model_id, m));
      if (freeOnly.length === 0) continue;
      const best = pickBest(freeOnly, difficulty, required_modality, input.department);
      if (best) {
        return { model_id: best.model_id, tier, modelSource: 'task_selector', required_modality, difficulty, candidates_considered, needs_owner_input: false };
      }
    } else {
      const best = pickBest(inTier, difficulty, required_modality, input.department);
      if (best) {
        return { model_id: best.model_id, tier, modelSource: 'task_selector', required_modality, difficulty, candidates_considered, needs_owner_input: false };
      }
    }
  }

  return {
    model_id: NEEDS_OWNER_INPUT,
    tier: null,
    modelSource: 'task_selector',
    required_modality,
    difficulty,
    candidates_considered,
    needs_owner_input: true,
  };
}

function pickBest(
  candidates: ModelRegistryEntry[],
  tier: PurposeTier,
  modality: TaskModality,
  department?: string | null,
): ModelRegistryEntry | null {
  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => {
    // Primary: capability fit (higher = better)
    const scoreDiff = capabilityScore(b, modality, tier, department) - capabilityScore(a, modality, tier, department);
    if (scoreDiff !== 0) return scoreDiff;

    // Secondary: version (higher = better)
    const vDiff = compareVersions(parseVersion(a.model_id), parseVersion(b.model_id));
    if (vDiff !== 0) return vDiff;

    // Tertiary: cost band (lower = better)
    return COST_BAND_ORDER[getCostBand(a)] - COST_BAND_ORDER[getCostBand(b)];
  })[0];
}

// ─── AF-MODEL-SOVEREIGNTY assertion ─────────────────────────────────────────

export interface ModelSovereigntyViolation {
  reason:
    | 'null_model'
    | 'free_default'
    | 'forbidden_prefix'
    | 'wrong_modality'
    | 'needs_owner_input';
  model_id: string | null;
  required_modality?: TaskModality;
}

/**
 * W8.5 — Sovereign DEFAULT model.
 *
 * Guarantees a non-null, sovereign (never free, never Anthropic, modality-fit)
 * model so dispatch's `model_id` is never NULL when nothing else resolved (the
 * 172/183-null-model_id root cause). This is a DEFAULT only — it is applied by
 * the resolver strictly AFTER every express source (CEO/owner pin, SOP pin,
 * task selector, role/dept override) has declined. It NEVER substitutes an
 * owner's express model (model sovereignty preserved).
 *
 * Resolution order:
 *   1. SOVEREIGN_DEFAULT_MODEL env — owner-configured house default. Honoured
 *      only if it passes the sovereignty gate for the task's modality.
 *   2. Best sovereign model already in the client's inventory (non-free,
 *      non-forbidden, modality-fit) walking tier 1 → 2 → 3.
 *
 * Returns null when no sovereign model exists for the modality — the caller
 * then keeps needs_owner_input (correct: a vision task with no vision model must
 * still ask the owner, never silently run on a text model).
 */
export function resolveSovereignDefault(
  inventory: ModelRegistryEntry[],
  required_modality: TaskModality = 'text',
): string | null {
  const envDefault = (process.env.SOVEREIGN_DEFAULT_MODEL || '').trim();
  if (envDefault && !checkModelSovereignty(envDefault, inventory, required_modality)) {
    // FM-6c (env-default path): for text tasks, also guard against a pure TTS/media
    // SOVEREIGN_DEFAULT_MODEL. checkModelSovereignty skips the modality check when
    // required_modality === 'text' (it only checks wrong-modality for non-text), so
    // without this guard a TTS model set as the env default would win any text task —
    // including presentations tasks — and be pinned as the reasoning model_id.
    // Mirrors the canServeTextTask filter applied to the eligible-inventory scan below.
    if (required_modality === 'text') {
      const envEntry = inventory.find((m) => m.model_id === envDefault);
      if (!envEntry || canServeTextTask(envEntry)) {
        return envDefault;
      }
      // envDefault is a pure TTS/media model — fall through to inventory scan.
    } else {
      return envDefault;
    }
  }

  const eligible = inventory.filter(
    (m) =>
      !isForbidden(m.model_id) &&
      !isFree(m.model_id, m) &&
      m.model_id !== NEEDS_OWNER_INPUT &&
      m.model_id !== 'openrouter/free' &&
      // FM-6c: for a text task accept any LANGUAGE model but NOT a pure media/TTS
      // model (mirrors selectTaskModel) so the sovereign default never pins a TTS
      // model as the reasoning model_id.
      (required_modality === 'text'
        ? canServeTextTask(m)
        : m.capabilities.includes(required_modality as ModelCapability)),
  );
  if (eligible.length === 0) return null;

  for (const tier of [1, 2, 3] as ModelTier[]) {
    const inTier = eligible.filter((m) => tierOf(m.model_id) === tier);
    if (inTier.length > 0) {
      const best = pickBest(inTier, 'mid', required_modality, null);
      if (best) return best.model_id;
    }
  }
  return eligible[0].model_id;
}

/**
 * Gate assertion: throws a structured violation if the resolved model is
 * null, the openrouter/free default, forbidden (Anthropic), or modality-wrong.
 * Returns null when the model passes all checks.
 */
export function checkModelSovereignty(
  modelId: string | null | undefined,
  inventory: ModelRegistryEntry[],
  required_modality?: TaskModality,
): ModelSovereigntyViolation | null {
  if (!modelId) {
    return { reason: 'null_model', model_id: null, required_modality };
  }
  if (modelId === NEEDS_OWNER_INPUT || modelId === 'openrouter/free' || modelId.endsWith(':free')) {
    return { reason: modelId === NEEDS_OWNER_INPUT ? 'needs_owner_input' : 'free_default', model_id: modelId, required_modality };
  }
  if (isForbidden(modelId)) {
    return { reason: 'forbidden_prefix', model_id: modelId, required_modality };
  }
  if (required_modality) {
    const entry = inventory.find((m) => m.model_id === modelId);
    if (required_modality === 'text') {
      // MODEL-06: a resolved TEXT model that IS present in the inventory must be
      // able to actually serve text — not a pure media/TTS/embeddings row and not
      // an empty-caps (untyped) row. A model ABSENT from inventory is left to the
      // free/forbidden checks above (text is the lenient default modality, and an
      // express text pin the box hasn't registered is not, by itself, a violation).
      if (entry && !canServeTextTask(entry)) {
        return { reason: 'wrong_modality', model_id: modelId, required_modality };
      }
    } else {
      // MODEL-03: a NON-text (vision/image/video/audio) pin must be a KNOWN,
      // capability-verified model. The gate previously FAILED OPEN when the model
      // was absent from the inventory — an unverifiable id could satisfy a media
      // task. Treat "absent from inventory" as a violation (we cannot prove it can
      // serve the required modality), same as a present-but-incapable model.
      if (!entry || !entry.capabilities.includes(required_modality as ModelCapability)) {
        return { reason: 'wrong_modality', model_id: modelId, required_modality };
      }
    }
  }
  return null;
}

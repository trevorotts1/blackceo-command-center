/**
 * Task-time model selector — Layer 2 of the Intelligent Model Selector.
 *
 * Given a task (title, description, department) and the client's available
 * model inventory, selects the best model using:
 *   A. Nature + difficulty classification → purpose tier (heavy/mid/fast)
 *   B. Required modality hard-filter (vision tasks can NEVER resolve to text-only)
 *   C. Cascade: Ollama Cloud → OpenRouter open-source → Free (last resort)
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

/** Anthropic is forbidden for all client dispatches. */
const FORBIDDEN_PREFIXES = ['anthropic/', 'openrouter/anthropic/'];

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

function tierOf(modelId: string): ModelTier {
  if (modelId.startsWith('ollama/') && modelId.includes(':cloud')) return 1;
  if (OPENROUTER_OSS_PREFIXES.some((p) => modelId.startsWith(p))) return 2;
  // Anything openrouter/* not matched above that's free-tier goes to 3
  if (modelId.endsWith(':free') || modelId === 'openrouter/free') return 3;
  // Any other openrouter/* (proprietary routes) is NOT tier 2 — treat as 3
  if (modelId.startsWith('openrouter/')) return 3;
  // Local ollama (no :cloud) — treat as tier 2 (open-source, local)
  if (modelId.startsWith('ollama/')) return 2;
  return 3;
}

function isForbidden(modelId: string): boolean {
  return FORBIDDEN_PREFIXES.some((p) => modelId.startsWith(p));
}

function isFree(modelId: string, entry?: ModelRegistryEntry): boolean {
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
    if (required_modality === 'text') return true; // any model handles text
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
    return envDefault;
  }

  const eligible = inventory.filter(
    (m) =>
      !isForbidden(m.model_id) &&
      !isFree(m.model_id, m) &&
      m.model_id !== NEEDS_OWNER_INPUT &&
      m.model_id !== 'openrouter/free' &&
      (required_modality === 'text' ||
        m.capabilities.includes(required_modality as ModelCapability)),
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
  if (required_modality && required_modality !== 'text') {
    const entry = inventory.find((m) => m.model_id === modelId);
    if (entry && !entry.capabilities.includes(required_modality as ModelCapability)) {
      return { reason: 'wrong_modality', model_id: modelId, required_modality };
    }
  }
  return null;
}

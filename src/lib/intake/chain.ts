/**
 * V23-CC1 — intake classifier chain as a JevResponder.
 *
 * Chain order per box, first available wins:
 *   1. OpenRouter GPT-6 Luna — `openai/gpt-6-luna`, STANDARD tier (not batch).
 *   2. Minimax 3 on Ollama Cloud — only when the box HAS Ollama.
 *   3. Agnes 3.0 Flash — only when the box HAS Agnes
 *      (id `agnes-3.0-flash`; matches onboarding
 *      `shared-utils/llm_score.py` AGNES_MODEL — do not invent).
 *   4. Else the box keeps deciding with its OWN machinery — the installed
 *      decision-engine core (the box's main-owned model), delegated to
 *      `liveJevResponder` in `decision-engine/live.ts`.
 *
 * The call carries ONLY the classification policy plus the message (~2,000
 * tokens in) and does NOT pick a department.
 *
 * KEYS: every client uses its OWN keys from its OWN secrets store ONLY —
 * the same sources the key-detection module already walks
 * (`resolveProviderApiKey`: process.env, then the box's OpenClaw secret
 * files, then openclaw.json env + models.providers keys, then the OpenClaw
 * auth-profile store). Trevor's own OpenRouter key is NEVER used on a
 * client box. A missing key means SKIP THAT STEP. A key value is NEVER
 * printed or logged anywhere in this file.
 *
 * Failure posture: a chain step advances on missing key, timeout, or error,
 * and a total chain failure THROWS — so classify.ts's classifyViaJev falls
 * back to the lexical path (the floor). The chain never makes ingest FAIL
 * when every AI step is unavailable.
 */

import {
  resolveProviderApiKey,
  type KeyDetectionResult,
  type LocalEndpointResult,
} from '@/lib/provider-key-detection';
import { getProvider, type ModelProvider } from '@/lib/model-providers';
import { agnesProvider } from '@/lib/model-providers/agnes';
import { minimaxProvider } from '@/lib/model-providers/minimax';
import { openrouterProvider } from '@/lib/model-providers/openrouter';
import type { Agent } from '@/lib/types';
import type { IntakeContext, JevIntentAnswer, JevResponder } from './classify';

// Step 1: OpenRouter GPT-6 Luna, STANDARD tier (never batch).
export const CHAIN_LUNA_MODEL = 'openai/gpt-6-luna';
// Step 2: Minimax 3 served through the box's Ollama surface.
export const CHAIN_MINIMAX_MODEL = 'minimax-m3';
// Step 3: Agnes 3.0 Flash — matches onboarding llm_score.AGNES_MODEL.
export const CHAIN_AGNES_MODEL = 'agnes-3.0-flash';
// Step 3 retry: the tag every Agnes account carries (llm_score fallback).
export const CHAIN_AGNES_FALLBACK_MODEL = 'agnes-2.5-flash';

/** Per-step HTTP budget: an unanswered step is worth less than the next one. */
const CHAIN_STEP_TIMEOUT_MS = 20_000;

/** The resolved key value, or null when absent / local-endpoint. Never logged. */
function apiKeyOf(
  result: KeyDetectionResult | LocalEndpointResult,
): string | null {
  if ('found' in result && result.found === true) return result.value;
  return null;
}

function keyResolves(provider: ModelProvider): string | null {
  return apiKeyOf(resolveProviderApiKey(provider));
}

/**
 * Whether the box HAS Ollama: an Ollama key resolves from the box's own
 * stores (either spelling the connector accepts). Provider presence is the
 * box-having-Ollama signal — never a key guess beyond the aliases the
 * connector already declares.
 */
export function boxHasOllama(): boolean {
  const cloud = getProvider('ollama-cloud');
  if (cloud && keyResolves(cloud) !== null) return true;
  return false;
}

/** Whether the box HAS Agnes: an Agnes key resolves from the box's stores. */
export function boxHasAgnes(): boolean {
  return keyResolves(agnesProvider) !== null;
}

/** Resolved step the chain would take on this box. No live calls. */
export type ChainStep = 'openrouter-gpt-6-luna' | 'ollama-minimax-3' | 'agnes-3-0-flash' | 'box-main';

export function resolveChainStep(): { step: ChainStep; reason: string } {
  if (keyResolves(openrouterProvider) !== null) {
    return { step: 'openrouter-gpt-6-luna', reason: 'available' };
  }
  if (boxHasOllama() && keyResolves(minimaxProvider) !== null) {
    return { step: 'ollama-minimax-3', reason: 'available' };
  }
  if (boxHasAgnes()) {
    return { step: 'agnes-3-0-flash', reason: 'available' };
  }
  // Reason tokens name the MISSING input, never a value.
  if (!boxHasOllama() && !boxHasAgnes()) {
    return { step: 'box-main', reason: 'missing-key' };
  }
  return { step: 'box-main', reason: 'no-provider' };
}

const CLASSIFIER_SYSTEM_PROMPT = [
  'Classify the owner message into exactly one intent.',
  'Valid intents: answer_only, task_request, mixed_answer_and_task,',
  'existing_task_control, clarification_response, social_conversation, unresolved.',
  'Valid execution preferences: normal_delegation, current_assistant,',
  'named_worker, named_department, unspecified.',
  'Reply with JSON only: {"intent": "...", "executionPreference": "..."}.',
  'Classify only. Never pick a department, worker, or model.',
].join(' ');

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`chain step timed out after ${ms}ms`)), ms);
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

interface AttemptArgs {
  providerSlug: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  message: string;
  fallbackModel?: string;
}

async function attemptChat({
  providerSlug,
  model,
  apiKey,
  baseUrl,
  message,
  fallbackModel,
}: AttemptArgs): Promise<JevIntentAnswer> {
  const run = async (modelId: string): Promise<JevIntentAnswer> => {
    const res = await withTimeout(
      fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
            { role: 'user', content: message },
          ],
          temperature: 0,
          max_tokens: 200,
        }),
      }),
      CHAIN_STEP_TIMEOUT_MS,
    );
    if (!res.ok) {
      const err = new Error(`${providerSlug} chat failed: ${res.status}`);
      (err as { status?: number }).status = res.status;
      throw err;
    }
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload?.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(text) as Partial<JevIntentAnswer>;
    if (typeof parsed.intent !== 'string' || typeof parsed.executionPreference !== 'string') {
      throw new Error(`${providerSlug} returned an unparseable answer`);
    }
    return { intent: parsed.intent, executionPreference: parsed.executionPreference };
  };
  try {
    return await run(model);
  } catch (err) {
    // Agnes retry: the 3.0 id is not on every account — one retry on the 2.5
    // tag every account carries (mirrors llm_score model_fallback).
    const status = (err as { status?: number }).status;
    if (fallbackModel && (status === 400 || status === 404)) {
      return run(fallbackModel);
    }
    throw err;
  }
}

/**
 * The chain as a JevResponder. Steps advance on missing key, timeout, or
 * error; step 4 delegates to the box's own decision engine, and total
 * failure throws so classifyViaJev keeps the lexical floor.
 */
export const intakeChainResponder: JevResponder = async ({
  message,
  context,
}: {
  message: string;
  context: IntakeContext;
}): Promise<JevIntentAnswer> => {
  // SWITCH PARITY: the same ~/.openclaw/decision-engine-mode.conf semantics
  // govern here as in live.ts jevMode() (env OPENCLAW_DECISION_ENGINE_MODE
  // first, then the conf file, default auto; off/legacy/shadow = no JEV
  // traffic). Dynamic import: live.ts imports @/lib/intake, so a static
  // import here would cycle. Anything but auto throws — classifyViaJev then
  // keeps the lexical path (the floor).
  const { jevMode, liveJevResponder } = await import('@/lib/decision-engine/live');
  if (jevMode() !== 'auto') {
    throw new Error('intake chain disabled by decision-engine mode (lexical floor governs)');
  }
  // Step 1 — OpenRouter GPT-6 Luna, STANDARD tier (never batch).
  const lunaKey = keyResolves(openrouterProvider);
  if (lunaKey !== null) {
    try {
      return await attemptChat({
        providerSlug: 'openrouter',
        model: CHAIN_LUNA_MODEL,
        apiKey: lunaKey,
        baseUrl: 'https://openrouter.ai/api/v1',
        message,
      });
    } catch {
      // Advance: timeout, error, or unparseable answer.
    }
  }
  // Step 2 — Minimax 3 on Ollama Cloud, only when the box HAS Ollama.
  if (boxHasOllama() && keyResolves(minimaxProvider) !== null) {
    const ollamaCloud = getProvider('ollama-cloud');
    const ollamaKey = ollamaCloud ? keyResolves(ollamaCloud) : null;
    if (ollamaKey !== null) {
      try {
        return await attemptChat({
          providerSlug: 'ollama-cloud',
          model: CHAIN_MINIMAX_MODEL,
          apiKey: ollamaKey,
          baseUrl: 'https://ollama.com/v1',
          message,
        });
      } catch {
        // Advance.
      }
    }
  }
  // Step 3 — Agnes 3.0 Flash, only when the box HAS Agnes.
  const agnesKey = keyResolves(agnesProvider);
  if (agnesKey !== null) {
    try {
      return await attemptChat({
        providerSlug: 'agnes',
        model: CHAIN_AGNES_MODEL,
        apiKey: agnesKey,
        baseUrl: 'https://apihub.agnes-ai.com/v1',
        message,
        fallbackModel: CHAIN_AGNES_FALLBACK_MODEL,
      });
    } catch {
      // Advance to the box-main fallthrough below.
    }
  }
  // Step 4 — the box keeps deciding with its OWN machinery: the installed
  // decision-engine core (the box's main-owned model), delegated through
  // liveJevResponder. That responder throws when the core is unavailable
  // (no core / mode off / failure), so classifyViaJev still falls back to
  // the lexical floor and ingest never fails for an unavailable AI step.
  return await liveJevResponder({ message, context });
};

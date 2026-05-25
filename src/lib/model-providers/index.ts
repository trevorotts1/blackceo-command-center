/**
 * Central provider registry per PRD Section 5.2.
 *
 * Aggregates the 13 provider connectors (Wave 2) plus the Ollama Cloud
 * connector (shipped earlier by Track A1) into a single, lookup-by-slug
 * surface that the weekly refresh job and the chat-completion proxy use.
 *
 * Slug convention: lowercase, hyphenated, matching the `provider` column on
 * `model_registry` (Migration 031) and the `model_id` prefix every
 * connector emits ("<slug>/<native-id>").
 */

import type { ModelProvider } from './types';

import { openaiProvider } from './openai';
import { anthropicProvider } from './anthropic';
import { googleProvider } from './google';
import { xaiProvider } from './xai';
import { openrouterProvider } from './openrouter';
import { zaiProvider } from './zai';
import { moonshotProvider } from './moonshot';
import { minimaxProvider } from './minimax';
import { kieProvider } from './kie';
import { falProvider } from './fal';
import { replicateProvider } from './replicate';
import { elevenlabsProvider } from './elevenlabs';
import { fishAudioProvider } from './fish-audio';
import { xiaomiProvider } from './xiaomi';
import ollamaCloudProvider from './ollama-cloud';
import ollamaLocalProvider from './ollama-local';

/**
 * Every provider connector available in the registry. Iteration order is the
 * default refresh order for the weekly cron, so high-traffic providers come
 * first (Ollama Cloud, OpenAI, Anthropic, Google, xAI) and the long-tail
 * generation providers come last.
 */
export const ALL_PROVIDERS: ModelProvider[] = [
  ollamaCloudProvider,
  ollamaLocalProvider,
  openaiProvider,
  anthropicProvider,
  googleProvider,
  xaiProvider,
  openrouterProvider,
  zaiProvider,
  moonshotProvider,
  minimaxProvider,
  kieProvider,
  falProvider,
  replicateProvider,
  elevenlabsProvider,
  fishAudioProvider,
  xiaomiProvider,
];

/**
 * Lookup a connector by its slug. Returns undefined when the slug is not
 * registered, which the caller should treat as "no live connector for this
 * model_id; use the registry row's stored metadata only".
 */
export function getProvider(slug: string): ModelProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.slug === slug);
}

/**
 * Lookup a connector by a fully-qualified `model_id` of the form `<slug>/<rest>`.
 * Returns undefined if the prefix does not match any registered provider.
 */
export function getProviderForModelId(modelId: string): ModelProvider | undefined {
  const idx = modelId.indexOf('/');
  if (idx <= 0) return undefined;
  return getProvider(modelId.slice(0, idx));
}

/**
 * All registered provider slugs. Useful for surfacing the supported set in
 * admin UIs without exposing the connector instances themselves.
 */
export const ALL_PROVIDER_SLUGS: string[] = ALL_PROVIDERS.map((p) => p.slug);

// Re-export named connectors so call sites can import either through the
// barrel or directly without circular issues.
export {
  openaiProvider,
  anthropicProvider,
  googleProvider,
  xaiProvider,
  openrouterProvider,
  zaiProvider,
  moonshotProvider,
  minimaxProvider,
  kieProvider,
  falProvider,
  replicateProvider,
  elevenlabsProvider,
  fishAudioProvider,
  xiaomiProvider,
  ollamaCloudProvider,
  ollamaLocalProvider,
};

export type { ModelProvider } from './types';

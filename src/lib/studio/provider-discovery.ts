/**
 * Studio provider auto-discovery (v4.1.2).
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The Operator Studio reads the `model_registry` table by capability tag
 * (`image_generation` / `video_generation` / `audio_generation`) and filters to
 * providers that have an API key in the environment. On a fresh deploy the
 * registry is EMPTY — it is only ever written by the weekly Sunday-03:00 refresh
 * cron — so every Studio tab shows "No providers configured" until that tick
 * runs (or an operator manually hits `POST /api/cron/refresh-models`). On top of
 * that, even after a refresh the Kie connector tagged video models `streaming`
 * and audio models `audio_input`, so the Video/Audio tabs stayed empty for Kie
 * regardless of keys, and the Studio gate hard-coded the wrong KIE env-var name.
 *
 * THE FIX (this module)
 * ---------------------
 * A single, data-driven discovery surface:
 *
 *   1. `hydrateProviderEnvFromOpenClaw()` — best-effort, never-throws env
 *      hydration. `process.env` is consulted first (covers the VPS container env
 *      loaded from the host `/docker/<proj>/.env`). For any key NOT already in
 *      `process.env`, we additionally probe — in order, first hit wins — the
 *      OpenClaw secret files that exist on the box:
 *        - host `/docker/<proj>/.env`        (Hostinger Docker)
 *        - `~/.openclaw/.env`                (Mac)
 *        - `~/.openclaw/secrets/.env`        (Mac)
 *        - `openclaw.json` `env` / `env.vars` (Mac or VPS, path via platform.ts)
 *      Reuses the F52 defensive "probe N candidate locations, never throw"
 *      idiom. We NEVER fabricate a key: an absent source is simply skipped.
 *
 *   2. `PROVIDER_DISCOVERY` — the one place to add a provider. Each entry maps a
 *      list of candidate env-var names → a provider slug → the capability rows
 *      it should contribute (image / video / audio), each with a sensible
 *      default model id and the resolved `api_key_env` recorded in metadata.
 *
 *   3. `discoverRegistryRows()` — walks the table, and for every provider whose
 *      key is actually present in the (hydrated) environment, emits
 *      `ModelRegistryUpsertInput[]` rows so the Studio registry populates for
 *      Image, Video, AND Audio.
 *
 * This module is SERVER-ONLY (it imports `fs`/`os`/`path` and the registry). It
 * must only be imported from server code (instrumentation, generators, the
 * refresh job, API routes), never from a `'use client'` component.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { openclawConfigPath } from '@/lib/platform';
import type { ModelCapability, ModelRegistryUpsertInput } from '@/lib/model-registry-types';

/** Studio's three media capabilities, in tab order. */
export type MediaCapability = 'image_generation' | 'video_generation' | 'audio_generation';

/**
 * A default model a present key should contribute, per capability. `model_id`
 * is the provider-prefixed id the registry stores; `generates` is `true` when a
 * `call*` generator is already wired in `generators.ts` for this provider+kind,
 * and `false` when the row is registry-only ("selectable but coming soon").
 */
interface DiscoveryModel {
  model_id: string;
  label: string;
  capability: MediaCapability;
  family?: string;
  /** Whether `generators.ts` already routes this provider+kind to a real call. */
  generates: boolean;
}

/**
 * One provider's discovery rule. `envCandidates` is checked in order; the FIRST
 * present env var wins and is recorded as the row's `api_key_env`. A provider
 * contributes rows ONLY when one of its candidate keys is present.
 */
export interface ProviderDiscoveryEntry {
  slug: string;
  displayName: string;
  envCandidates: string[];
  models: DiscoveryModel[];
}

/**
 * THE PROVIDER → CAPABILITY MAP.
 *
 * Add a new media provider by appending one entry here — nothing else in the
 * codebase needs to change for it to appear in the Studio dropdown + tabs.
 *
 * Env-var names match the connector contract in `src/lib/model-providers/*`
 * (kie.ts → KIE_API_KEY, fal.ts → FAL_KEY, google.ts → GEMINI_API_KEY, etc.).
 * Where a connector and a probe disagreed historically (FAL_KEY vs FAL_API_KEY,
 * KIE_API_KEY vs KIEAI_API_KEY) we accept BOTH spellings so the row appears no
 * matter which the box uses.
 */
export const PROVIDER_DISCOVERY: ProviderDiscoveryEntry[] = [
  {
    slug: 'kie',
    displayName: 'Kie.ai',
    // kie.ts documents KIE_API_KEY; the probe used KIEAI_API_KEY — accept both.
    envCandidates: ['KIE_API_KEY', 'KIEAI_API_KEY', 'KIE_AI_API_KEY'],
    models: [
      { model_id: 'kie/nano-banana', label: 'Nano Banana (Kie)', capability: 'image_generation', family: 'nano-banana', generates: true },
      { model_id: 'kie/gpt-image', label: 'GPT Image (Kie)', capability: 'image_generation', family: 'gpt-image', generates: true },
      { model_id: 'kie/flux-1.1-pro', label: 'FLUX 1.1 Pro (Kie)', capability: 'image_generation', family: 'flux', generates: true },
      { model_id: 'kie/veo-3', label: 'Veo 3 (Kie)', capability: 'video_generation', family: 'veo', generates: true },
      { model_id: 'kie/runway-gen3', label: 'Runway Gen-3 (Kie)', capability: 'video_generation', family: 'runway', generates: true },
    ],
  },
  {
    slug: 'openai',
    displayName: 'OpenAI',
    // NOTE: only the OpenAI API key is an image/audio provider. Codex / ChatGPT
    // OAuth sessions are NOT — do not treat an OAuth login as an image key.
    envCandidates: ['OPENAI_API_KEY'],
    models: [
      { model_id: 'openai/gpt-image-1', label: 'GPT Image 1', capability: 'image_generation', family: 'gpt-image', generates: true },
      { model_id: 'openai/dall-e-3', label: 'DALL·E 3', capability: 'image_generation', family: 'dall-e', generates: true },
      { model_id: 'openai/gpt-4o-mini-tts', label: 'GPT-4o mini TTS', capability: 'audio_generation', family: 'openai-tts', generates: false },
      { model_id: 'openai/tts-1', label: 'OpenAI TTS-1', capability: 'audio_generation', family: 'openai-tts', generates: false },
    ],
  },
  {
    slug: 'fal',
    displayName: 'Fal.ai',
    envCandidates: ['FAL_KEY', 'FAL_API_KEY', 'FAL_AI_API_KEY'],
    models: [
      { model_id: 'fal/fal-ai/flux/dev', label: 'FLUX dev (Fal)', capability: 'image_generation', family: 'flux', generates: true },
      { model_id: 'fal/fal-ai/flux-pro/v1.1', label: 'FLUX 1.1 Pro (Fal)', capability: 'image_generation', family: 'flux', generates: true },
      { model_id: 'fal/fal-ai/veo3', label: 'Veo 3 (Fal)', capability: 'video_generation', family: 'veo', generates: true },
      { model_id: 'fal/fal-ai/kling-video/v2/master/text-to-video', label: 'Kling Video v2 (Fal)', capability: 'video_generation', family: 'kling', generates: true },
      { model_id: 'fal/fal-ai/elevenlabs/tts/multilingual-v2', label: 'ElevenLabs TTS via Fal', capability: 'audio_generation', family: 'elevenlabs', generates: true },
    ],
  },
  {
    slug: 'google',
    displayName: 'Google',
    envCandidates: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    models: [
      { model_id: 'google/imagen-3.0-generate-002', label: 'Imagen 3', capability: 'image_generation', family: 'imagen', generates: false },
      { model_id: 'google/gemini-2.5-flash-image', label: 'Gemini Flash Image', capability: 'image_generation', family: 'gemini-image', generates: false },
      { model_id: 'google/veo-3.0-generate-preview', label: 'Veo 3 (Google)', capability: 'video_generation', family: 'veo', generates: false },
    ],
  },
  {
    slug: 'fish-audio',
    displayName: 'Fish Audio',
    envCandidates: ['FISH_AUDIO_API_KEY'],
    models: [
      { model_id: 'fish-audio/s1', label: 'Fish Speech 1.5 (S1)', capability: 'audio_generation', family: 'fish-speech-1.5', generates: false },
      { model_id: 'fish-audio/s1-mini', label: 'Fish Speech 1.5 Mini', capability: 'audio_generation', family: 'fish-speech-1.5', generates: false },
    ],
  },
  {
    slug: 'elevenlabs',
    displayName: 'ElevenLabs',
    envCandidates: ['ELEVENLABS_API_KEY'],
    models: [
      { model_id: 'elevenlabs/eleven_multilingual_v2', label: 'ElevenLabs Multilingual v2', capability: 'audio_generation', family: 'elevenlabs', generates: true },
    ],
  },
  {
    slug: 'replicate',
    displayName: 'Replicate',
    envCandidates: ['REPLICATE_API_TOKEN', 'REPLICATE_API_KEY'],
    models: [
      { model_id: 'replicate/black-forest-labs/flux-1.1-pro', label: 'FLUX 1.1 Pro (Replicate)', capability: 'image_generation', family: 'flux', generates: true },
      { model_id: 'replicate/stability-ai/sdxl', label: 'SDXL (Replicate)', capability: 'image_generation', family: 'stable-diffusion', generates: true },
    ],
  },
  {
    slug: 'luma',
    displayName: 'Luma',
    envCandidates: ['LUMA_API_KEY', 'LUMAAI_API_KEY'],
    models: [
      { model_id: 'luma/dream-machine', label: 'Luma Dream Machine', capability: 'video_generation', family: 'luma', generates: false },
    ],
  },
  {
    slug: 'stability',
    displayName: 'Stability AI',
    envCandidates: ['STABILITY_API_KEY', 'STABILITY_AI_API_KEY'],
    models: [
      { model_id: 'stability/stable-image-core', label: 'Stable Image Core', capability: 'image_generation', family: 'stable-diffusion', generates: false },
    ],
  },
  {
    slug: 'runway',
    displayName: 'Runway',
    envCandidates: ['RUNWAY_API_KEY', 'RUNWAYML_API_SECRET'],
    models: [
      { model_id: 'runway/gen3a_turbo', label: 'Runway Gen-3 Alpha Turbo', capability: 'video_generation', family: 'runway', generates: false },
    ],
  },
];

/** All env-var names any provider cares about (deduped). */
function allKnownEnvVars(): string[] {
  const set = new Set<string>();
  for (const p of PROVIDER_DISCOVERY) for (const e of p.envCandidates) set.add(e);
  return Array.from(set);
}

// ---------------------------------------------------------------------------
// Env hydration from OpenClaw secret files (F52 defensive-reader pattern).
// ---------------------------------------------------------------------------

function safeReadFile(p: string): string | null {
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse a `.env`-style file into a flat record. Tolerant: ignores blank lines,
 * `#` comments, and `export ` prefixes; strips matching surrounding quotes.
 * Never throws.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    // Strip an inline comment only when the value is unquoted.
    if (value && value[0] !== '"' && value[0] !== "'") {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Pull `env` / `env.vars` string entries out of a parsed `openclaw.json`.
 * Tolerates either shape: `{ env: { FOO: "bar" } }` or
 * `{ env: { vars: { FOO: "bar" } } }`. Never throws.
 */
export function extractOpenclawEnv(json: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!json || typeof json !== 'object') return out;
  const env = (json as Record<string, unknown>).env;
  if (!env || typeof env !== 'object') return out;
  const collect = (obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') out[k] = v;
    }
  };
  collect(env as Record<string, unknown>);
  const vars = (env as Record<string, unknown>).vars;
  if (vars && typeof vars === 'object') collect(vars as Record<string, unknown>);
  return out;
}

/**
 * Candidate OpenClaw secret-file locations to probe for keys NOT already in
 * `process.env`. Order = precedence (first hit wins per key). An explicit
 * `OPENCLAW_PROJECT_DIR` (the host `/docker/<proj>` dir) is honored first.
 */
export function candidateEnvFiles(): string[] {
  const files: string[] = [];
  const projectDir = process.env.OPENCLAW_PROJECT_DIR;
  if (projectDir) files.push(path.join(projectDir, '.env'));
  const home = os.homedir();
  files.push(path.join(home, '.openclaw', '.env'));
  files.push(path.join(home, '.openclaw', 'secrets', '.env'));
  return files;
}

/**
 * Best-effort hydrate `process.env` with any known provider keys discovered in
 * the OpenClaw secret files. NEVER overwrites a value already set in
 * `process.env` (the container/host env is authoritative). NEVER throws.
 *
 * Returns the list of env-var names that were newly hydrated from a file, for
 * logging/observability. Idempotent: a second call is a no-op for keys that are
 * now present.
 */
export function hydrateProviderEnvFromOpenClaw(): string[] {
  const wanted = allKnownEnvVars();
  const hydrated: string[] = [];

  const missing = () => wanted.filter((k) => !process.env[k]);
  if (missing().length === 0) return hydrated;

  // 1) .env-style files, in precedence order.
  for (const file of candidateEnvFiles()) {
    if (missing().length === 0) break;
    const content = safeReadFile(file);
    if (!content) continue;
    const parsed = parseDotEnv(content);
    for (const key of missing()) {
      if (parsed[key]) {
        process.env[key] = parsed[key];
        hydrated.push(key);
      }
    }
  }

  // 2) openclaw.json env / env.vars (Mac ~/.openclaw or VPS /data/.openclaw).
  if (missing().length > 0) {
    const content = safeReadFile(openclawConfigPath());
    if (content) {
      let json: unknown = null;
      try {
        json = JSON.parse(content);
      } catch {
        json = null;
      }
      const envVars = extractOpenclawEnv(json);
      for (const key of missing()) {
        if (envVars[key]) {
          process.env[key] = envVars[key];
          hydrated.push(key);
        }
      }
    }
  }

  return hydrated;
}

// ---------------------------------------------------------------------------
// Registry-row discovery.
// ---------------------------------------------------------------------------

/**
 * The first present env-var name for a provider entry, or null if none are set.
 * Reads `process.env` only — call `hydrateProviderEnvFromOpenClaw()` first if
 * you want file-sourced keys considered.
 */
export function resolveApiKeyEnv(entry: ProviderDiscoveryEntry): string | null {
  for (const candidate of entry.envCandidates) {
    if (process.env[candidate]) return candidate;
  }
  return null;
}

/**
 * Build the registry-upsert rows for every provider whose key is present in the
 * (already-hydrated) environment. Each row carries the resolved `api_key_env`
 * and a `generates` flag in `raw_metadata` so the UI can mark registry-only
 * rows "coming soon" rather than letting them fail silently.
 *
 * Pass `hydrate: false` to skip the file-hydration step (the caller already ran
 * it). Default hydrates so a single call "just works".
 */
export function discoverRegistryRows(opts: { hydrate?: boolean } = {}): ModelRegistryUpsertInput[] {
  if (opts.hydrate !== false) {
    try {
      hydrateProviderEnvFromOpenClaw();
    } catch {
      // never let discovery crash a render
    }
  }

  const rows: ModelRegistryUpsertInput[] = [];
  for (const entry of PROVIDER_DISCOVERY) {
    const apiKeyEnv = resolveApiKeyEnv(entry);
    if (!apiKeyEnv) continue; // no key present -> emit nothing (never fabricate)
    for (const model of entry.models) {
      rows.push({
        model_id: model.model_id,
        label: model.label,
        provider: entry.slug,
        family: model.family ?? null,
        pricing_model: 'per_token',
        pricing_source: 'discovered',
        capabilities: [model.capability as ModelCapability],
        status: 'active',
        raw_metadata: {
          source: 'env-discovery',
          api_key_env: apiKeyEnv,
          generates: model.generates,
          display_name: entry.displayName,
        },
      });
    }
  }
  return rows;
}

/**
 * Diagnostic helper: which providers/capabilities are currently discoverable,
 * given the present environment. Used by tests and could back a settings probe.
 */
export function discoveryReport(opts: { hydrate?: boolean } = {}): Array<{
  slug: string;
  displayName: string;
  api_key_env: string | null;
  present: boolean;
  capabilities: MediaCapability[];
}> {
  if (opts.hydrate !== false) {
    try {
      hydrateProviderEnvFromOpenClaw();
    } catch {
      /* ignore */
    }
  }
  return PROVIDER_DISCOVERY.map((entry) => {
    const apiKeyEnv = resolveApiKeyEnv(entry);
    const caps = Array.from(new Set(entry.models.map((m) => m.capability)));
    return {
      slug: entry.slug,
      displayName: entry.displayName,
      api_key_env: apiKeyEnv,
      present: Boolean(apiKeyEnv),
      capabilities: caps,
    };
  });
}

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

import { detectPlatform, openclawConfigPath, resolveClientPath } from '@/lib/platform';
import { getClientContext, type Client } from '@/lib/clients';
import { runClientSsh } from '@/lib/operator/client-fs';
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
 * Pull provider API keys out of an `openclaw.json` `models.providers` map.
 *
 * OpenClaw stores per-provider credentials at
 * `models.providers[<slug>].apiKey` (and some installs use `api_key`). We map
 * the provider slug back to the conventional `<SLUG>_API_KEY` env-var name so a
 * key configured ONLY inside openclaw.json (never exported to a `.env`) still
 * lights up the provider. Never throws.
 */
export function extractOpenclawProviderKeys(json: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!json || typeof json !== 'object') return out;
  const models = (json as Record<string, unknown>).models;
  if (!models || typeof models !== 'object') return out;
  const providers = (models as Record<string, unknown>).providers;
  if (!providers || typeof providers !== 'object') return out;

  for (const [slug, raw] of Object.entries(providers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const key =
      (typeof entry.apiKey === 'string' && entry.apiKey) ||
      (typeof entry.api_key === 'string' && entry.api_key) ||
      '';
    if (!key) continue;
    // Convention mirrors apiKeyFor() in the refresh job: SLUG -> SLUG_API_KEY.
    const envName = slug.toUpperCase().replace(/-/g, '_') + '_API_KEY';
    out[envName] = key;
    // C1 — Ollama slug alias: the openclaw config stores the key under the
    // slug `ollama`; the connector and discovery table expect BOTH
    // `OLLAMA_API_KEY` (conventional slug derivation above) AND
    // `OLLAMA_CLOUD_API_KEY` (the canonical name the UI surfaces). Populate
    // both so the Ollama Cloud provider lights up regardless of which name
    // the detection layer checks first.
    if (slug === 'ollama') {
      out['OLLAMA_CLOUD_API_KEY'] = key;
    }
  }
  return out;
}

/**
 * Candidate OpenClaw secret-file locations to probe for keys NOT already in
 * `process.env`. Order = precedence (first hit wins per key). An explicit
 * `OPENCLAW_PROJECT_DIR` (the host `/docker/<proj>` dir) is honored first.
 *
 * Platform branch (U48/U60): on `vps-docker`, Hostinger mounts `/data` as the
 * persistent volume and OpenClaw's secret files live under
 * `/data/.openclaw/.env` and `/data/.openclaw/secrets/.env` — the container
 * analogs of the Mac `~/.openclaw/...` paths below, exactly as
 * `openclawConfigPath()` (`platform.ts`) already branches for
 * `openclaw.json`. Before this fix `candidateEnvFiles()` had NO platform
 * branch, so a key delivered ONLY via those persistent-volume files (not
 * `process.env`) was invisible to key detection AND to Deep Scan (which
 * reuses this same function) on every Docker box. Mac paths are always
 * scanned regardless of detected platform — the Mac side is not a gap and
 * must not regress.
 */
export function candidateEnvFiles(): string[] {
  const files: string[] = [];
  const projectDir = process.env.OPENCLAW_PROJECT_DIR;
  if (projectDir) files.push(path.join(projectDir, '.env'));
  if (detectPlatform() === 'vps-docker') {
    files.push('/data/.openclaw/.env');
    files.push('/data/.openclaw/secrets/.env');
  }
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
      // env / env.vars first, then per-provider apiKey entries.
      const envVars = { ...extractOpenclawProviderKeys(json), ...extractOpenclawEnv(json) };
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
// PER-CLIENT env hydration (E4 / E14).
//
// The functions above resolve keys from the LOCAL box only. For the selected
// client we must source keys from THAT client's OpenClaw env, not the Command
// Center's own process.env:
//   - self / local client  → the same local files as above.
//   - remote client (VPS or Mac reached over the CF Access SSH tunnel) → read
//     the remote `openclaw.json` + `.env` over SSH and merge those keys.
//
// We hydrate `process.env` so the (out-of-scope, untouched) weekly refresh job
// in `jobs/refresh-models.ts` — which keys off `<SLUG>_API_KEY` env vars —
// transparently uses the selected client's credentials. The hydration is
// best-effort and NEVER throws.
// ---------------------------------------------------------------------------

/** Minimal POSIX single-quote escaping for an absolute path. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a command over the client's SSH tunnel and return stdout, or null on any
 * failure. Delegates to the Foundation's `runClientSsh` (src/lib/operator/
 * client-fs.ts) so the transport is the SAME documented Cloudflare-Access
 * pattern every other feature cluster uses: `cloudflared` ProxyCommand at its
 * absolute path + the per-client CF-Access service token injected as env. We do
 * NOT re-implement SSH here — a bare `ssh <target>` cannot reach a fleet box.
 */
async function remoteRead(client: Client, remotePath: string): Promise<string | null> {
  // `||true` so a missing file is an empty success, not an ssh error.
  const res = await runClientSsh(client, `cat ${shellQuote(remotePath)} 2>/dev/null || true`).catch(
    () => ({ ok: false, stdout: '' }),
  );
  if (!res.ok) return null;
  return res.stdout ?? null;
}

/**
 * Read a remote file, distinguishing three outcomes so a WRITE never clobbers a
 * real config when SSH merely failed:
 *   - { ok: true, content }              file read (content may be '')
 *   - { ok: true, content: null }        SSH succeeded but file does not exist
 *   - { ok: false }                      SSH/transport failure — do NOT proceed
 * Implemented with an explicit existence check so the result is unambiguous.
 * Uses the Foundation tunnel transport via `runClientSsh`.
 */
async function remoteReadStrict(
  client: Client,
  remotePath: string,
): Promise<{ ok: boolean; content: string | null }> {
  const q = shellQuote(remotePath);
  // Print a sentinel when the file is absent; otherwise stream its bytes.
  const res = await runClientSsh(
    client,
    `if [ -f ${q} ]; then cat ${q}; else printf '__BCC_NO_FILE__'; fi`,
  ).catch(() => ({ ok: false, stdout: '' }));
  if (!res.ok) return { ok: false, content: null };
  const text = res.stdout ?? '';
  if (text === '__BCC_NO_FILE__') return { ok: true, content: null };
  return { ok: true, content: text };
}

/**
 * Resolve provider API keys for a specific client WITHOUT mutating process.env.
 * Returns a map of `<SLUG>_API_KEY` -> value gathered from that client's
 * OpenClaw env. For self this reads local files; for a remote client it reads
 * the remote openclaw.json + .env over the SSH tunnel. Never throws.
 */
export async function resolveClientProviderKeys(client: Client): Promise<Record<string, string>> {
  const wanted = new Set(allKnownEnvVars());
  const out: Record<string, string> = {};

  const merge = (src: Record<string, string>) => {
    for (const [k, v] of Object.entries(src)) {
      if (wanted.has(k) && v && !out[k]) out[k] = v;
    }
  };

  if (client.is_self) {
    // Local: reuse the file probes, then openclaw.json (env + provider keys).
    for (const file of candidateEnvFiles()) {
      const content = safeReadFile(file);
      if (content) merge(parseDotEnv(content));
    }
    const cfg = safeReadFile(openclawConfigPath());
    if (cfg) {
      let json: unknown = null;
      try {
        json = JSON.parse(cfg);
      } catch {
        json = null;
      }
      merge(extractOpenclawProviderKeys(json));
      merge(extractOpenclawEnv(json));
    }
    return out;
  }

  // Remote client: read over the CF-Access tunnel. No ssh_target → give up.
  if (!client.ssh_target || !client.ssh_target.trim()) return out;

  const configDescriptor = resolveClientPath(client, 'openclaw-config');
  const remoteConfigPath = configDescriptor.path;
  // Probe the remote openclaw.json (provider keys + env) and the common .env.
  const remoteEnvCandidates = [
    remoteConfigPath.replace(/openclaw\.json$/, '.env'),
    '~/.openclaw/.env',
    '~/.openclaw/secrets/.env',
  ];

  const cfgContent = await remoteRead(client, remoteConfigPath).catch(() => null);
  if (cfgContent) {
    let json: unknown = null;
    try {
      json = JSON.parse(cfgContent);
    } catch {
      json = null;
    }
    merge(extractOpenclawProviderKeys(json));
    merge(extractOpenclawEnv(json));
  }

  for (const envPath of remoteEnvCandidates) {
    if (Array.from(wanted).every((k) => out[k])) break;
    const content = await remoteRead(client, envPath).catch(() => null);
    if (content) merge(parseDotEnv(content));
  }

  return out;
}

/**
 * Hydrate `process.env` with the SELECTED client's provider keys so the
 * downstream refresh job (which reads `<SLUG>_API_KEY`) talks to the right box.
 *
 * IMPORTANT: keys are sourced from the client and OVERWRITE the Command
 * Center's own values for the duration of the request, because a remote
 * client's catalog must be refreshed with THAT client's credentials — not the
 * operator's. Returns the list of env-var names hydrated. Never throws.
 *
 * Pass an explicit client to scope to a specific tenant; defaults to the
 * currently selected client via `getClientContext()`.
 */
export async function hydrateProviderEnvForSelectedClient(
  client?: Client | null,
): Promise<string[]> {
  let target = client ?? null;
  if (!target) {
    try {
      target = getClientContext();
    } catch {
      target = null;
    }
  }
  if (!target) return [];

  // Self client: keep the existing non-destructive local hydration (process.env
  // is already the operator's own box, so nothing to override).
  if (target.is_self) {
    try {
      return hydrateProviderEnvFromOpenClaw();
    } catch {
      return [];
    }
  }

  let keys: Record<string, string> = {};
  try {
    keys = await resolveClientProviderKeys(target);
  } catch {
    keys = {};
  }
  const hydrated: string[] = [];
  for (const [k, v] of Object.entries(keys)) {
    if (v) {
      process.env[k] = v;
      hydrated.push(k);
    }
  }
  return hydrated;
}

// ---------------------------------------------------------------------------
// PER-CLIENT key WRITE (E5).
//
// On a refresh failure caused by a missing key, the operator can supply one via
// POST /api/clients/[id]/keys. We persist it into the client's OpenClaw env so
// the next refresh succeeds:
//   - self / local client → merge into the local openclaw.json `env.vars`
//     (read by OpenClaw on next boot; also hydrated into our refresh job).
//   - remote client       → write into the remote openclaw.json `env.vars`
//     over the SSH tunnel (the cross-platform target OpenClaw reads on both Mac
//     and VPS; on a Hostinger VPS the host `/docker/<proj>/.env` is the other
//     option, but its path is not stored per-client, so env.vars is the
//     reliable, schema-stable destination).
//
// The env-var NAME is normalized to the conventional `<SLUG>_API_KEY` so it
// matches both the refresh job's `apiKeyFor()` and our discovery candidates.
// ---------------------------------------------------------------------------

export interface KeyWriteResult {
  ok: boolean;
  /** The env-var name that was written (normalized). */
  envVar: string;
  /** 'local-openclaw-json' | 'remote-openclaw-json' */
  target: string;
  error?: string;
  /**
   * When the write failed due to ENOSPC / disk-full, this is true so the
   * API route can return HTTP 507 Insufficient Storage instead of a generic
   * 502. The error message is also made actionable for the operator.
   */
  diskFull?: boolean;
}

/**
 * Return true when the error message indicates an ENOSPC / disk-full
 * condition on the client box (covers Linux ENOSPC, macOS "no space",
 * Docker thin-provisioned writes, and variants from SSH stderr).
 */
export function isDiskFullError(msg: string): boolean {
  return /ENOSPC|no space left|disk.*full|out of.*space|not enough space/i.test(msg);
}

/** Normalize a provider slug OR an explicit env-var name to `<SLUG>_API_KEY`. */
export function normalizeKeyEnvVar(providerOrEnv: string): string {
  const raw = providerOrEnv.trim();
  // Already an env-var name (UPPER_SNAKE ending in _KEY / _TOKEN / _SECRET).
  if (/^[A-Z][A-Z0-9_]*$/.test(raw) && /(KEY|TOKEN|SECRET)$/.test(raw)) {
    return raw;
  }
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_API_KEY';
}

/** Deep-merge a single env var into an openclaw.json string, returning new JSON text. */
function mergeKeyIntoOpenclawJson(jsonText: string | null, envVar: string, value: string): string {
  let root: Record<string, unknown> = {};
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt/unreadable config — start from an empty object rather than
      // clobbering blindly is risky, so we throw to let the caller surface it.
      throw new Error('existing openclaw.json is not valid JSON; refusing to overwrite');
    }
  }
  const env = (root.env && typeof root.env === 'object' && !Array.isArray(root.env)
    ? (root.env as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const vars = (env.vars && typeof env.vars === 'object' && !Array.isArray(env.vars)
    ? (env.vars as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  vars[envVar] = value;
  env.vars = vars;
  root.env = env;
  return JSON.stringify(root, null, 2) + '\n';
}

/**
 * Write a provider API key into the given client's OpenClaw env. Returns a
 * structured result; never throws for an expected failure (bad ssh, etc.) —
 * those come back as `{ ok: false, error }`.
 */
export async function writeClientProviderKey(
  client: Client,
  providerOrEnv: string,
  value: string,
): Promise<KeyWriteResult> {
  const envVar = normalizeKeyEnvVar(providerOrEnv);
  if (!value || !value.trim()) {
    return { ok: false, envVar, target: '', error: 'empty key value' };
  }

  if (client.is_self) {
    try {
      const configPath = openclawConfigPath();
      const configDir = path.dirname(configPath);
      const existing = safeReadFile(configPath);
      const next = mergeKeyIntoOpenclawJson(existing, envVar, value.trim());
      const nextBytes = Buffer.byteLength(next, 'utf8');

      // B2 — disk preflight: refuse if free bytes < 2 × file size.
      // statfsSync is available in Node ≥ 19.6 / v18.15 (same LTS as Next 14).
      // We gate on its existence so old Node versions degrade gracefully.
      try {
        const stat = (fs as unknown as { statfsSync?: (p: string) => { bfree: number; bsize: number } }).statfsSync;
        if (typeof stat === 'function') {
          const vfs = stat(configDir);
          const freeBytes = vfs.bfree * vfs.bsize;
          if (freeBytes < nextBytes * 2) {
            const freeMB = (freeBytes / (1024 * 1024)).toFixed(1);
            const needMB = ((nextBytes * 2) / (1024 * 1024)).toFixed(2);
            const msg = `disk preflight failed: only ${freeMB} MB free, need at least ${needMB} MB — free space and retry`;
            return { ok: false, envVar, target: 'local-openclaw-json', error: msg, diskFull: true };
          }
        }
      } catch {
        // statfsSync unavailable or failed — proceed without preflight
      }

      // B2 — atomic write via temp file + rename to never partially overwrite.
      const tmpPath = configPath + '.bcc-tmp-' + process.pid;
      try {
        fs.writeFileSync(tmpPath, next, { mode: 0o600 });
        fs.renameSync(tmpPath, configPath);
      } catch (writeErr) {
        // Clean up temp file on failure; ignore cleanup error.
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw writeErr;
      }

      // Make it live for THIS process immediately so an inline re-refresh works.
      process.env[envVar] = value.trim();
      return { ok: true, envVar, target: 'local-openclaw-json' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        envVar,
        target: 'local-openclaw-json',
        error: msg,
        diskFull: isDiskFullError(msg),
      };
    }
  }

  if (!client.ssh_target || !client.ssh_target.trim()) {
    return { ok: false, envVar, target: 'remote-openclaw-json', error: 'client has no ssh_target' };
  }

  const remotePath = resolveClientPath(client, 'openclaw-config').path;
  // Read the remote config, merge locally, write it back over the tunnel. Use
  // the strict reader so an SSH failure aborts instead of clobbering a real
  // config. All transport goes through the Foundation's `runClientSsh`.
  const read = await remoteReadStrict(client, remotePath).catch(() => ({ ok: false, content: null }));
  if (!read.ok) {
    return {
      ok: false,
      envVar,
      target: 'remote-openclaw-json',
      error: 'could not read remote openclaw.json over SSH (refusing to overwrite)',
    };
  }
  let next: string;
  try {
    next = mergeKeyIntoOpenclawJson(read.content, envVar, value.trim());
  } catch (err) {
    return { ok: false, envVar, target: 'remote-openclaw-json', error: err instanceof Error ? err.message : String(err) };
  }
  const wrote = await remoteWriteFile(client, remotePath, next).catch(() => false);
  if (!wrote) {
    return { ok: false, envVar, target: 'remote-openclaw-json', error: 'failed to write remote openclaw.json over SSH' };
  }
  return { ok: true, envVar, target: 'remote-openclaw-json' };
}

/**
 * Write `content` to `remotePath` on the client box over the CF-Access tunnel.
 * The payload is base64-encoded and decoded on the remote side (matching the
 * Foundation's `writeClientFile` in client-fs.ts) so arbitrary JSON survives the
 * shell intact; the bytes travel only over the encrypted tunnel to the client's
 * own box. Returns true on a clean exit. Never throws.
 */
async function remoteWriteFile(client: Client, remotePath: string, content: string): Promise<boolean> {
  const dir = path.posix.dirname(remotePath);
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const cmd =
    `mkdir -p ${shellQuote(dir)} && ` +
    `printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)} && ` +
    `chmod 600 ${shellQuote(remotePath)}`;
  const res = await runClientSsh(client, cmd).catch(() => ({ ok: false }));
  return res.ok === true;
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

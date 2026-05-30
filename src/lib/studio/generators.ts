/**
 * Studio media generators (PRD Section 4.5, Track B4).
 *
 * Async job runner for the Operator Studio sub-module. Jobs are discovered
 * from the runtime `model_registry` table (Track C1) by capability tag
 * (`image_generation`, `video_generation`, `audio_generation`), so the
 * provider set is driven by which API keys + registry rows the operator has
 * configured rather than a hardcoded list.
 *
 * IMPORTANT: Track B4 cannot add migrations (the brief forbids touching
 * `src/lib/db/migrations.ts`). So we cannot use a `media_generation_jobs`
 * SQL table. Instead jobs persist as JSON files under
 * `<vault>/studio/.jobs/<id>.json` with a small in-process map for fast
 * lookups. When Track C-anything adds the migration, swap the persistence
 * layer here without touching the UI / API contracts.
 *
 * Output files land at `<vault>/studio/<type>/YYYY/MM/<slug>.<ext>` per the
 * PRD. Vault root comes from `vaultRoot()` in `src/lib/platform.ts`.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { vaultRoot } from '@/lib/platform';
import { listModels, bulkUpsertModels } from '@/lib/model-registry';
import type { ModelCapability } from '@/lib/model-registry';
import {
  discoverRegistryRows,
  hydrateProviderEnvFromOpenClaw,
} from '@/lib/studio/provider-discovery';

export type StudioKind = 'image' | 'video' | 'audio';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface StudioJob {
  id: string;
  kind: StudioKind;
  status: JobStatus;
  prompt: string;
  model_id: string | null;
  provider: string | null;
  result_path: string | null;
  result_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  duration_ms: number | null;
  metadata: Record<string, unknown>;
}

export interface StudioModelOption {
  model_id: string;
  label: string;
  provider: string;
}

const CAPABILITY_FOR_KIND: Record<StudioKind, ModelCapability> = {
  image: 'image_generation',
  video: 'video_generation',
  audio: 'audio_generation',
};

const EXTENSION_FOR_KIND: Record<StudioKind, string> = {
  image: 'png',
  video: 'mp4',
  audio: 'mp3',
};

/**
 * In-process cache. Authoritative state lives on disk under
 * `<vault>/studio/.jobs/`. The cache is a read-through optimization so the
 * polling endpoint does not hit the filesystem on every tick.
 */
const JOB_CACHE = new Map<string, StudioJob>();

function jobsDir(): string {
  return path.join(vaultRoot(), 'studio', '.jobs');
}

function jobFile(id: string): string {
  return path.join(jobsDir(), `${id}.json`);
}

async function persistJob(job: StudioJob): Promise<void> {
  await fs.mkdir(jobsDir(), { recursive: true });
  await fs.writeFile(jobFile(job.id), JSON.stringify(job, null, 2), 'utf8');
  JOB_CACHE.set(job.id, job);
}

export async function loadJob(id: string): Promise<StudioJob | null> {
  const cached = JOB_CACHE.get(id);
  if (cached) return cached;
  try {
    const raw = await fs.readFile(jobFile(id), 'utf8');
    const job = JSON.parse(raw) as StudioJob;
    JOB_CACHE.set(id, job);
    return job;
  } catch {
    return null;
  }
}

export async function listJobs(limit = 40): Promise<StudioJob[]> {
  try {
    const dir = jobsDir();
    if (!existsSync(dir)) return [];
    const files = await fs.readdir(dir);
    const jobs: StudioJob[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf8');
        jobs.push(JSON.parse(raw) as StudioJob);
      } catch {
        // skip corrupt entries
      }
    }
    jobs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return jobs.slice(0, limit);
  } catch {
    return [];
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function vaultOutputPath(kind: StudioKind, prompt: string, ext: string): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const slug = slugify(prompt);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(vaultRoot(), 'studio', kind, yyyy, mm, `${stamp}-${slug}.${ext}`);
}

/**
 * Process-wide guard so the lazy first-run seed runs at most once per worker.
 * Stored on `globalThis` so Next.js module reloading does not lose it.
 */
const SEED_KEY = '__BC_STUDIO_REGISTRY_SEEDED__';
interface SeedGlobals {
  [SEED_KEY]?: boolean;
}

/**
 * Lazy, idempotent registry seed from env auto-discovery.
 *
 * On a fresh deploy the `model_registry` table is EMPTY until the weekly
 * Sunday-03:00 refresh cron runs. That left every Studio tab showing
 * "No providers configured" for up to a week. This seeds the registry on the
 * first Studio read from the environment (hydrated from the OpenClaw secret
 * files), so a box with KIE/OpenAI/Fal/Gemini/Fish/etc. keys lights up
 * immediately. Idempotent: the discovered rows upsert by `model_id`, so the
 * later weekly refresh simply updates them.
 *
 * Never throws — discovery failure must not break the Studio render.
 */
function ensureRegistrySeeded(): void {
  const g = globalThis as unknown as SeedGlobals;
  if (g[SEED_KEY]) return;
  try {
    hydrateProviderEnvFromOpenClaw();
    const rows = discoverRegistryRows({ hydrate: false });
    if (rows.length > 0) bulkUpsertModels(rows);
  } catch (err) {
    console.error('[studio] registry auto-seed failed (non-fatal):', err);
  } finally {
    g[SEED_KEY] = true;
  }
}

/**
 * Models available for a given kind. Filters by capability against the
 * `model_registry` and hides providers without an API key in the environment.
 *
 * If the registry has zero rows for this capability (fresh deploy, weekly
 * refresh has not run yet), it lazily seeds from env auto-discovery first so
 * the Studio "just works" the moment the keys exist on the box.
 */
export function availableModels(kind: StudioKind): StudioModelOption[] {
  const capability = CAPABILITY_FOR_KIND[kind];
  try {
    let rows = listModels({ capability, status: 'active' });
    if (rows.length === 0) {
      ensureRegistrySeeded();
      rows = listModels({ capability, status: 'active' });
    }
    return rows
      .filter((m) => hasApiKey(m.provider))
      .map((m) => ({ model_id: m.model_id, label: m.label, provider: m.provider }));
  } catch {
    return [];
  }
}

function hasApiKey(provider: string): boolean {
  const slug = provider.toLowerCase();
  // Provider slug → env var lookup. Mirrors PRD Section 4.5 keys plus the
  // common providers that ship image/video/audio capability.
  const candidates: Record<string, string[]> = {
    // Env names follow the connector contract in src/lib/model-providers/*.
    // kie.ts documents KIE_API_KEY (the box uses KIE_API_KEY); accept the
    // historical KIE_AI_API_KEY / KIEAI_API_KEY spellings too.
    'kie.ai': ['KIE_API_KEY', 'KIEAI_API_KEY', 'KIE_AI_API_KEY'],
    'kie': ['KIE_API_KEY', 'KIEAI_API_KEY', 'KIE_AI_API_KEY'],
    // fal.ts documents FAL_KEY; the probe used FAL_API_KEY; accept both.
    'fal.ai': ['FAL_KEY', 'FAL_API_KEY', 'FAL_AI_API_KEY'],
    'fal': ['FAL_KEY', 'FAL_API_KEY', 'FAL_AI_API_KEY'],
    'replicate': ['REPLICATE_API_TOKEN', 'REPLICATE_API_KEY'],
    'openai': ['OPENAI_API_KEY'],
    'google': ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    'elevenlabs': ['ELEVENLABS_API_KEY'],
    'fish-audio': ['FISH_AUDIO_API_KEY'],
    'fish': ['FISH_AUDIO_API_KEY'],
    'luma': ['LUMA_API_KEY', 'LUMAAI_API_KEY'],
    'stability': ['STABILITY_API_KEY', 'STABILITY_AI_API_KEY'],
    'runway': ['RUNWAY_API_KEY', 'RUNWAYML_API_SECRET'],
  };
  const envs = candidates[slug] ?? [`${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`];
  return envs.some((e) => Boolean(process.env[e]));
}

export interface CreateJobInput {
  kind: StudioKind;
  prompt: string;
  model_id?: string | null;
  options?: Record<string, unknown>;
}

/**
 * Create a new job row, persist it, and kick off the provider call in the
 * background. The route returns the job id immediately and the UI polls
 * `GET /jobs/[id]` for completion.
 */
export async function createJob(input: CreateJobInput): Promise<StudioJob> {
  const now = new Date().toISOString();
  const id = randomUUID();

  // Resolve model: explicit > first available for kind > null (will fail)
  const models = availableModels(input.kind);
  const resolved = input.model_id
    ? models.find((m) => m.model_id === input.model_id) || null
    : models[0] || null;

  const job: StudioJob = {
    id,
    kind: input.kind,
    status: 'queued',
    prompt: input.prompt,
    model_id: resolved?.model_id ?? input.model_id ?? null,
    provider: resolved?.provider ?? null,
    result_path: null,
    result_url: null,
    error: null,
    created_at: now,
    updated_at: now,
    duration_ms: null,
    metadata: { options: input.options ?? {} },
  };
  await persistJob(job);

  // Fire and forget. Any throw inside is captured and recorded as failure.
  runJob(job, input.options ?? {}).catch(async (err) => {
    await markFailed(job.id, err instanceof Error ? err.message : String(err));
  });

  return job;
}

async function markRunning(id: string): Promise<void> {
  const job = await loadJob(id);
  if (!job) return;
  job.status = 'running';
  job.updated_at = new Date().toISOString();
  await persistJob(job);
}

async function markFailed(id: string, error: string): Promise<void> {
  const job = await loadJob(id);
  if (!job) return;
  job.status = 'failed';
  job.error = error;
  job.updated_at = new Date().toISOString();
  if (job.duration_ms == null) {
    job.duration_ms = Date.now() - new Date(job.created_at).getTime();
  }
  await persistJob(job);
}

async function markSucceeded(id: string, payload: {
  result_path: string;
  result_url: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const job = await loadJob(id);
  if (!job) return;
  job.status = 'succeeded';
  job.result_path = payload.result_path;
  job.result_url = payload.result_url;
  job.updated_at = new Date().toISOString();
  job.duration_ms = Date.now() - new Date(job.created_at).getTime();
  if (payload.metadata) job.metadata = { ...job.metadata, ...payload.metadata };
  await persistJob(job);
}

/**
 * Dispatch the actual provider call. Provider routing is by lowercased
 * `provider` slug. If no provider matches we fail the job with a clear
 * message rather than silently no-op.
 */
async function runJob(job: StudioJob, options: Record<string, unknown>): Promise<void> {
  await markRunning(job.id);

  if (!job.model_id) {
    await markFailed(job.id, 'No model selected and no active models in registry for this kind');
    return;
  }

  const provider = (job.provider || '').toLowerCase();

  // Fixture path for offline tests. Drop a binary at this path and the job
  // copies it verbatim, marking succeeded. Keeps CI deterministic.
  const fixtureEnv = `STUDIO_FIXTURE_${job.kind.toUpperCase()}_PATH`;
  const fixturePath = process.env[fixtureEnv];
  if (fixturePath && existsSync(fixturePath)) {
    const ext = path.extname(fixturePath).slice(1) || EXTENSION_FOR_KIND[job.kind];
    const outPath = vaultOutputPath(job.kind, job.prompt, ext);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.copyFile(fixturePath, outPath);
    await markSucceeded(job.id, {
      result_path: outPath,
      result_url: `/api/media/file?path=${encodeURIComponent(outPath)}`,
      metadata: { provider_used: 'fixture' },
    });
    return;
  }

  let providerResult: { url: string; metadata?: Record<string, unknown> };
  try {
    if (provider.includes('replicate')) {
      providerResult = await callReplicate(job, options);
    } else if (provider.includes('fal')) {
      providerResult = await callFal(job, options);
    } else if (provider.includes('kie')) {
      providerResult = await callKie(job, options);
    } else if (provider.includes('openai') && job.kind === 'image') {
      providerResult = await callOpenAiImages(job, options);
    } else if (provider.includes('elevenlabs') && job.kind === 'audio') {
      providerResult = await callElevenLabs(job, options);
    } else {
      // The model is in the registry (so it is selectable) but no generator is
      // wired for this provider+kind yet. Be honest: this is "coming soon", not
      // a misconfiguration. Discovered rows carry generates:false metadata.
      throw new Error(
        `Generation for provider "${job.provider}" + kind "${job.kind}" is registry-only (coming soon) — ` +
          `the model is selectable but its generate path is not wired yet. ` +
          `Wired now: image -> KIE / OpenAI / Fal / Replicate; video -> KIE / Fal; audio -> ElevenLabs / Fal.`
      );
    }
  } catch (err) {
    await markFailed(job.id, err instanceof Error ? err.message : String(err));
    return;
  }

  // Some connectors (ElevenLabs) already wrote the bytes to the vault
  // directly because their HTTP response is the binary payload. In that case
  // `url` is the local path and we skip the download step.
  if (providerResult.metadata && providerResult.metadata.skip_download === true) {
    const outPath = providerResult.url;
    await markSucceeded(job.id, {
      result_path: outPath,
      result_url: `/api/media/file?path=${encodeURIComponent(outPath)}`,
      metadata: providerResult.metadata,
    });
    return;
  }

  // Download the provider URL to the vault so the file is local + cacheable.
  const ext = guessExtFromUrl(providerResult.url) || EXTENSION_FOR_KIND[job.kind];
  const outPath = vaultOutputPath(job.kind, job.prompt, ext);
  try {
    await downloadToFile(providerResult.url, outPath);
  } catch (err) {
    await markFailed(job.id, `Provider returned URL but download failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  await markSucceeded(job.id, {
    result_path: outPath,
    result_url: `/api/media/file?path=${encodeURIComponent(outPath)}`,
    metadata: providerResult.metadata,
  });
}

function guessExtFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-z0-9]{2,5})(?:$|\?)/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
}

// --- provider connectors ---------------------------------------------------
// These are intentionally small. The Track C2 provider connectors will
// supersede each `call*` body once they land; until then we issue the
// minimum HTTP shape each provider documents.

async function callReplicate(job: StudioJob, options: Record<string, unknown>): Promise<{ url: string; metadata?: Record<string, unknown> }> {
  const token = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
  if (!token) throw new Error('REPLICATE_API_TOKEN missing');
  const body = {
    input: { prompt: job.prompt, ...options },
  };
  // model_id should be a Replicate slug like "stability-ai/sdxl".
  const res = await fetch(`https://api.replicate.com/v1/models/${job.model_id}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Replicate failed: ${res.status} ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as { output?: unknown; id?: string };
  const url = pickFirstUrl(json.output);
  if (!url) throw new Error('Replicate returned no output URL');
  return { url, metadata: { upstream_id: json.id } };
}

async function callFal(job: StudioJob, options: Record<string, unknown>): Promise<{ url: string; metadata?: Record<string, unknown> }> {
  const key = process.env.FAL_AI_API_KEY || process.env.FAL_KEY;
  if (!key) throw new Error('FAL_AI_API_KEY missing');
  const res = await fetch(`https://fal.run/${job.model_id}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt: job.prompt, ...options }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fal.ai failed: ${res.status} ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const url = pickFirstUrl(json);
  if (!url) throw new Error('Fal.ai returned no output URL');
  return { url, metadata: { request_id: json.request_id ?? null } };
}

async function callKie(job: StudioJob, _options: Record<string, unknown>): Promise<{ url: string; metadata?: Record<string, unknown> }> {
  // kie.ts documents KIE_API_KEY (what the box has); accept legacy spellings.
  const key = process.env.KIE_API_KEY || process.env.KIEAI_API_KEY || process.env.KIE_AI_API_KEY;
  if (!key) throw new Error('KIE_API_KEY missing');
  const res = await fetch('https://api.kie.ai/api/v1/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: job.model_id, prompt: job.prompt }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kie.ai failed: ${res.status} ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const url = pickFirstUrl(json);
  if (!url) throw new Error('Kie.ai returned no output URL');
  return { url, metadata: { upstream: json } };
}

async function callOpenAiImages(job: StudioJob, options: Record<string, unknown>): Promise<{ url: string; metadata?: Record<string, unknown> }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const size = (options.size as string) || '1024x1024';
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: job.model_id, prompt: job.prompt, size, n: 1 }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI Images failed: ${res.status} ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
  const url = json.data?.[0]?.url;
  if (!url) throw new Error('OpenAI Images returned no URL');
  return { url };
}

async function callElevenLabs(job: StudioJob, options: Record<string, unknown>): Promise<{ url: string; metadata?: Record<string, unknown> }> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY missing');
  const voiceId = (options.voice_id as string) || '21m00Tcm4TlvDq8ikWAM';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({ text: job.prompt, model_id: job.model_id || 'eleven_multilingual_v2' }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ElevenLabs failed: ${res.status} ${text.slice(0, 400)}`);
  }
  // ElevenLabs streams audio bytes directly in the HTTP response body
  // (no fetchable URL). Persist to the vault here and tell the caller to
  // skip its download step via `metadata.skip_download`.
  const buf = Buffer.from(await res.arrayBuffer());
  const outPath = vaultOutputPath('audio', job.prompt, 'mp3');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
  return {
    url: outPath,
    metadata: { skip_download: true, saved_inline: true },
  };
}

function pickFirstUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickFirstUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    // Common shapes: { url }, { image: { url } }, { images: [{ url }] },
    // { output: ... }, { audio_file: { url } }, { video: { url } }
    const obj = value as Record<string, unknown>;
    const direct = ['url', 'image_url', 'video_url', 'audio_url', 'output_url'];
    for (const k of direct) {
      const v = obj[k];
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
    }
    for (const k of Object.keys(obj)) {
      const found = pickFirstUrl(obj[k]);
      if (found) return found;
    }
  }
  return null;
}

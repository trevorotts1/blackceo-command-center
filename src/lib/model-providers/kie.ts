/**
 * Kie.ai provider connector (official KIE agent API — docs.kie.ai/ai-agent).
 *
 * Kie.ai aggregates async image/video/audio generation models behind a unified
 * JOB API. The two documented endpoints are:
 *   - POST /api/v1/jobs/createTask   submit {model, input} -> {data:{taskId}}
 *   - GET  /api/v1/jobs/recordInfo?taskId=...  poll until `state` is terminal
 * and the catalog is:
 *   - GET  /api/v1/models            -> {code, data:{total, models:[...]}}
 *
 * Three rules from the official docs that this file follows literally:
 *   - Check `code` in the RESPONSE BODY before reading `data`. Kie's gateway
 *     answers HTTP 200 on failures too, so the HTTP status alone is never
 *     proof a call succeeded.
 *   - Every createTask job is ASYNCHRONOUS. HTTP 200 on the create call only
 *     means "accepted"; the job must be polled to `state` success|fail.
 *   - Model ids come from the catalog (`data.models[].model`), never from
 *     memory or training data.
 *
 * Auth: Bearer token in the Authorization header.
 * Env:  KIE_API_KEY
 *
 * Kie is NOT a chat provider. We omit chatCompletion and expose `runKieJob()`
 * (create + poll) instead. The connector still conforms to ModelProvider
 * (slug, displayName, fetchModels) for the registry / refresh loop.
 *
 * U50/H+L.8 — CATALOG HONESTY (swallow-audit closure). This connector used
 * to wrap the `/models` call in a bare `try/catch` that fell through to
 * `CURATED_MODELS` (stamped `status: 'active'`) on ANY failure — a dead
 * key, a network error, a non-2xx response, ALL of it. That is the
 * identical "Fish Audio fallback never `active`" mirage the swallow-audit
 * closes: a dead/invalid Kie key made `refreshOneProvider()` log
 * `success: true` and re-stamp the hardcoded catalog `active` every cycle.
 * Fixed the same way as `fish-audio.ts`:
 *   - a live-call failure now PROPAGATES (no try/catch) so
 *     `refreshOneProvider()` records `success: false` with the real error;
 *   - an authenticated, successful call that legitimately lists zero
 *     models resolves to an EMPTY catalog, never substituted with
 *     `CURATED_MODELS`;
 *   - `CURATED_MODELS` is retained as documentation-only reference data
 *     (see the constant below) and is NEVER returned by `fetchModels()`.
 */

import type {
  ModelCapability,
  ModelProvider,
  ProviderModel,
  SmokeTestResult,
} from './types';

const PROVIDER_SLUG = 'kie';
const PROVIDER_DISPLAY_NAME = 'Kie.ai';

const BASE_URL = process.env.KIE_BASE_URL || 'https://api.kie.ai/api/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
// GET /chat/credit returns the caller's own account credit balance. Kie's
// gateway is unusual: it ALWAYS answers HTTP 200 and encodes the real
// outcome in the JSON body's `code` field (live-verified 2026-07-15):
// missing/bad Authorization -> HTTP 200 body
// {"code":401,"msg":"Unauthorized – Authentication failed. ..."}. So auth
// proof here reads `body.code`, never the HTTP status alone.
const CREDIT_ENDPOINT = `${BASE_URL}/chat/credit`;
// Official unified job API (docs.kie.ai/ai-agent).
const CREATE_TASK_ENDPOINT = `${BASE_URL}/jobs/createTask`;
const RECORD_INFO_ENDPOINT = `${BASE_URL}/jobs/recordInfo`;

/** Default polling cadence. Docs: 3s is a good interval; recordInfo allows
 * 10 requests/second per taskId, so 3s is well inside the limit. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;
/** Default deadline. Docs suggest 300s for image jobs; video and music take
 * longer, so callers may raise it via `runKieJob` options. */
const DEFAULT_POLL_TIMEOUT_MS = 300_000;

interface KieModelRow {
  id?: string;
  /** Official catalog field — the identifier used everywhere else. */
  model?: string;
  slug?: string;
  name?: string;
  title?: string;
  /** Official catalog field, e.g. `["Text to Video"]`. */
  taskType?: unknown;
  category?: string;
  capabilities?: string[];
  [key: string]: unknown;
}

/** Official catalog envelope: `{code, msg, data: {total, models: [...]}}`. */
interface KieModelsResponse {
  code?: number;
  msg?: string;
  data?: {
    total?: number;
    models?: KieModelRow[];
  } | KieModelRow[];
}

/** Every Kie endpoint answers `{code, msg, data}`. */
interface KieEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface KieTaskRecord {
  taskId?: string;
  state?: string;
  successFlag?: number;
  failCode?: string | number | null;
  failMsg?: string | null;
  response?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface KieJobResult {
  taskId: string;
  state: string;
  /** Parsed `data.response` from the terminal recordInfo reply. */
  response: Record<string, unknown> | null;
  /** `data.response.resultUrls` when present (most models), else []. */
  resultUrls: string[];
}

export interface KieRunJobOptions {
  /** Poll cadence in ms. Defaults to 3000. */
  pollIntervalMs?: number;
  /** Overall deadline in ms. Defaults to 300000 (image-sized); raise for video/music. */
  pollTimeoutMs?: number;
  /** Injectable clock hook for tests — awaited between polls. */
  sleep?: (ms: number) => Promise<void>;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * U50/H+L.8 — CATALOG HONESTY. This list is documentation-only as of this
 * unit. It is NEVER returned by `fetchModels()` as live data (that silent
 * substitution — a hardcoded catalog stamped `active` on any live-call
 * failure, including a dead/invalid key — was the swallow this unit closes;
 * see the retired fallback behavior in git history). Kept only so a reader
 * knows which high-traffic model ids the operator uses today.
 * `normalizeCurated()` below stamps `status: 'unavailable'` (never
 * confirmed against a live call) so this data can never masquerade as a
 * verified, assignable model if it is ever wired into a seed path.
 */
const CURATED_MODELS: Array<{ id: string; kind: ModelCapability; family: string }> = [
  { id: 'veo-3', kind: 'video_generation', family: 'veo' },
  { id: 'veo-3-fast', kind: 'video_generation', family: 'veo' },
  { id: 'midjourney-v6', kind: 'image_generation', family: 'midjourney' },
  { id: 'midjourney-v7', kind: 'image_generation', family: 'midjourney' },
  { id: 'flux-1.1-pro', kind: 'image_generation', family: 'flux' },
  { id: 'flux-kontext-pro', kind: 'image_generation', family: 'flux' },
  { id: 'suno-v4', kind: 'audio_generation', family: 'suno' },
  { id: 'runway-gen3', kind: 'video_generation', family: 'runway' },
];

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes('veo')) return 'veo';
  if (lower.includes('midjourney') || lower.includes('mj')) return 'midjourney';
  if (lower.includes('flux')) return 'flux';
  if (lower.includes('suno')) return 'suno';
  if (lower.includes('runway')) return 'runway';
  if (lower.includes('kling')) return 'kling';
  if (lower.includes('pika')) return 'pika';
  return undefined;
}

function inferCapabilities(modelId: string): ModelCapability[] {
  const lower = modelId.toLowerCase();
  // Video families -> video_generation (NOT 'streaming'); the Studio video tab
  // filters on the video_generation capability tag.
  if (lower.includes('veo') || lower.includes('runway') || lower.includes('kling') || lower.includes('pika') || lower.includes('video')) {
    return ['video_generation'];
  }
  // Audio/music families -> audio_generation (NOT 'audio_input', which is an
  // INPUT capability). The Studio audio tab filters on audio_generation.
  if (lower.includes('suno') || lower.includes('audio') || lower.includes('music')) {
    return ['audio_generation'];
  }
  return ['image_generation'];
}

/**
 * Official catalog rows carry `taskType: string[]` (for example
 * `["Text to Video"]`) instead of a `capabilities` array. Map it to Studio's
 * three capability tags, video > audio > image so an "Image to Video" model
 * lands on the Video tab rather than both. Returns null when the field is
 * absent or unrecognised, in which case the caller falls back to
 * `inferCapabilities(id)`.
 */
function capabilitiesFromTaskType(taskType: unknown): ModelCapability[] | null {
  if (!Array.isArray(taskType)) return null;
  const joined = taskType.filter((t): t is string => typeof t === 'string').join(' ');
  if (!joined) return null;
  if (/video/i.test(joined)) return ['video_generation'];
  if (/audio|music|speech|singing|tts|voice|dialogue/i.test(joined)) return ['audio_generation'];
  if (/image|photo/i.test(joined)) return ['image_generation'];
  return null;
}

function normalizeRow(row: KieModelRow): ProviderModel | null {
  // Official field order: `model` is the identifier, `slug`/`id`/`name` are
  // legacy/fallback spellings kept so a non-standard reply still normalises.
  const id = row.model || row.slug || row.id || row.name;
  if (!id) return null;
  const declared = (row.capabilities || []).filter((c): c is ModelCapability => typeof c === 'string');
  const caps =
    declared.length > 0 ? declared : capabilitiesFromTaskType(row.taskType) ?? inferCapabilities(id);
  return {
    model_id: `${PROVIDER_SLUG}/${id}`,
    label: row.title || row.name || id,
    provider: PROVIDER_SLUG,
    family: inferFamily(id),
    pricing_model: 'per_token',
    pricing_source: 'auto',
    capabilities: caps,
    status: 'active',
    raw_metadata: row as unknown as Record<string, unknown>,
  };
}

/**
 * U50/H+L.8 — documentation-only normalizer for `CURATED_MODELS`. Never
 * called from `fetchModels()`. `status: 'unavailable'` is deliberate: this
 * data has never been confirmed against a live call and must never
 * masquerade as an assignable model.
 */
function normalizeCurated(entry: { id: string; kind: ModelCapability; family: string }): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${entry.id}`,
    label: entry.id,
    provider: PROVIDER_SLUG,
    family: entry.family,
    pricing_model: 'per_token',
    pricing_source: 'hardcoded',
    capabilities: inferCapabilities(entry.id),
    status: 'unavailable',
    raw_metadata: { source: 'curated', note: 'Never confirmed live — reference only (U50/H+L.8).' },
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kie.ai request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

/**
 * Fetch a JSON envelope and enforce the body's `code` before the caller reads
 * `data`. Kie answers HTTP 200 even when the call failed (a rejected key is
 * `HTTP 200` + `{"code":401,...}`), so the HTTP status alone is INSUFFICIENT
 * proof of success — official doc rule 5. A missing/non-numeric `code` is
 * treated as a failure too (fail closed), never as success.
 */
async function fetchKieEnvelope<T>(url: string, init: RequestInit): Promise<T> {
  const payload = await fetchJson<KieEnvelope<T>>(url, init);
  if (payload?.code !== 200) {
    const msg = typeof payload?.msg === 'string' && payload.msg ? payload.msg : 'no code:200 in reply';
    throw new Error(`Kie.ai request to ${url} rejected: code ${String(payload?.code)} ${msg}`);
  }
  return payload.data as T;
}

/**
 * Fetch the Kie.ai model catalog.
 *
 * OFFICIAL SHAPE: `{"code":200, "data": {"total": N, "models": [...]}}` —
 * `data` is an OBJECT holding `models`, not a list. Reading `payload.data` as
 * an array (the pre-fix behaviour) returned [] for every successful call, so
 * the weekly refresh silently emptied the Kie catalog.
 *
 * U50/H+L.8 — CATALOG HONESTY. This used to swallow EVERY failure (a dead
 * key, a network error, a non-2xx response) into a bare `catch` that
 * returned `CURATED_MODELS` stamped `active` — so a garbage key made the
 * weekly refresh log `success: true` and re-stamped a hardcoded catalog
 * `active` forever. That swallow is gone:
 *   - a live-call failure now PROPAGATES (via `fetchJson`/`fetchKieEnvelope`,
 *     no try/catch here) so `refreshOneProvider()` catches it and records
 *     `success: false` with the real error detail, exactly like every other
 *     connector;
 *   - an authenticated, successful call that legitimately lists zero models
 *     resolves to an EMPTY catalog, never substituted with `CURATED_MODELS`
 *     — presence of a key and a 200 is not a license to invent rows.
 *
 * Model ids come from `data.models[].model` — the catalog, never memory.
 */
export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Kie.ai fetchModels called without an apiKey (set KIE_API_KEY)');
  }
  const data = await fetchKieEnvelope<KieModelsResponse['data']>(MODELS_ENDPOINT, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  const rows = Array.isArray(data) ? data : (data?.models ?? []);
  return rows.map(normalizeRow).filter((m): m is ProviderModel => m !== null);
}

const TERMINAL_STATES = new Set(['success', 'fail']);

/**
 * Numeric env override for the two polling knobs below. Docs note that 300s
 * suits image jobs and that video/music need longer, so these are
 * operator-tunable without a code change. A missing or non-numeric value
 * falls back to the constant — never to 0/NaN.
 */
function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * Submit one official KIE job: `POST /api/v1/jobs/createTask` with
 * `{model, input}`. Returns the `taskId`.
 *
 * A 200 here only means ACCEPTED — every KIE job is asynchronous and must be
 * polled with `getJobStatus`/`runKieJob`.
 */
export async function createJob(
  apiKey: string,
  model: string,
  input: Record<string, unknown>
): Promise<string> {
  if (!apiKey) {
    throw new Error('Kie.ai createJob called without an apiKey');
  }
  if (!model) {
    throw new Error('Kie.ai createJob called without a model id');
  }
  const data = await fetchKieEnvelope<{ taskId?: string; recordId?: string }>(CREATE_TASK_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({ model, input }),
  });
  const taskId = data?.taskId;
  if (!taskId) {
    throw new Error('Kie.ai createTask returned no data.taskId');
  }
  return taskId;
}

/**
 * Poll `GET /api/v1/jobs/recordInfo?taskId=...` ONCE and return the record.
 * `recordId` is not the polling key — only `taskId`.
 */
export async function getJobStatus(apiKey: string, taskId: string): Promise<KieTaskRecord> {
  if (!apiKey) {
    throw new Error('Kie.ai getJobStatus called without an apiKey');
  }
  const url = `${RECORD_INFO_ENDPOINT}?taskId=${encodeURIComponent(taskId)}`;
  return fetchKieEnvelope<KieTaskRecord>(url, { method: 'GET', headers: authHeaders(apiKey) });
}

/**
 * Official end-to-end run: createTask, then poll recordInfo until `state`
 * reaches a TERMINAL value (`success` or `fail`), or the deadline expires.
 *
 * Non-terminal states per the docs: `waiting`, `queuing`, `generating`.
 * Anything else that is not `success`/`fail` is still running. On `fail` the
 * record's `failCode`/`failMsg` are surfaced in the thrown error.
 *
 * The HTTP status alone is never treated as success at any step: `createJob`
 * and `getJobStatus` both read the body `code` first.
 */
export async function runKieJob(
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
  opts: KieRunJobOptions = {}
): Promise<KieJobResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? envInt('KIE_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, 0);
  const pollTimeoutMs = opts.pollTimeoutMs ?? envInt('KIE_POLL_TIMEOUT_MS', DEFAULT_POLL_TIMEOUT_MS, 1);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const taskId = await createJob(apiKey, model, input);
  const deadline = Date.now() + pollTimeoutMs;

  for (;;) {
    const record = await getJobStatus(apiKey, taskId);
    const state = typeof record?.state === 'string' ? record.state : '';
    if (TERMINAL_STATES.has(state)) {
      if (state === 'fail') {
        const failMsg = record.failMsg ?? 'no failMsg';
        throw new Error(
          `Kie.ai job ${taskId} failed (state=fail, failCode=${String(record.failCode ?? 'n/a')}): ${String(failMsg)}`
        );
      }
      const response = (record.response ?? null) as Record<string, unknown> | null;
      const rawUrls = Array.isArray(response?.resultUrls)
        ? (response!.resultUrls as unknown[]).filter((u): u is string => typeof u === 'string')
        : [];
      return { taskId, state, response, resultUrls: rawUrls };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Kie.ai job ${taskId} did not reach a terminal state within ${pollTimeoutMs}ms (last state=${state || 'unknown'})`
      );
    }
    await sleep(pollIntervalMs);
  }
}

/*
 * DELETED (CC-KIE-U1): `generate()` and `getJob()`.
 *
 * Both were dead. A repo-wide caller search (git grep over src/, tests/,
 * scripts/ for imports of `model-providers/kie` and for `generate`/`getJob`
 * references) found ZERO callers outside this file — the only importers of
 * kie.ts are `model-providers/index.ts` (imports `kieProvider`) and three
 * test files (which import `fetchModels`/`verifyKey`). The similarly-named
 * `getJob` in `lib/podcast/queries.ts` is an unrelated function.
 *
 * Both were also wrong against the official API: `generate()` posted to the
 * undocumented `/api/v1/<model>/generate`, and `getJob()` read the
 * undocumented `/api/v1/jobs/<id>`. The documented pair is
 * `/api/v1/jobs/createTask` + `/api/v1/jobs/recordInfo?taskId=` — see
 * `createJob`/`getJobStatus`/`runKieJob` above.
 */

interface KieCreditResponse {
  code?: number;
  msg?: string;
  [key: string]: unknown;
}

/**
 * U49/U61 (H+L.7) — real authenticated proof, never the model-list mirage.
 * Hits /chat/credit (requires a valid Bearer token) instead of /v1/models.
 * Kie's gateway always answers HTTP 200 (never a 401 status), so this reads
 * the JSON body's `code` field for the real outcome — a bare `res.ok` check
 * would be silently wrong here and would fail OPEN (treat a rejected key as
 * proven). `code === 200` is the only success case; every other code
 * (401 unauthorized, or any other value) is reported as a failure, fail-
 * closed. Used by `proveProviderAuth()` as the fallback proof method when no
 * `chatCompletion` exists (Kie is not a chat provider). The key is NEVER
 * logged or echoed.
 */
export async function verifyKey(apiKey: string): Promise<SmokeTestResult> {
  const TIMEOUT_MS = 7_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(CREDIT_ENDPOINT, {
      method: 'GET',
      headers: authHeaders(apiKey),
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Kie answers 200 even on auth failure — never trust res.ok alone.
    let payload: KieCreditResponse | null = null;
    try {
      payload = (await res.json()) as KieCreditResponse;
    } catch {
      payload = null;
    }
    if (!res.ok) {
      // Defensive: if a future Kie revision DOES use real HTTP status codes,
      // still honor a non-2xx as a failure.
      return { ok: false, status: res.status, message: payload?.msg || `${res.status} ${res.statusText}` };
    }
    if (payload && payload.code === 200) {
      return { ok: true, status: res.status };
    }
    return {
      ok: false,
      status: res.status,
      message: payload?.msg
        ? `code ${payload.code}: ${payload.msg}`
        : `unexpected credit response shape (no code:200)`,
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('abort') || msg.toLowerCase().includes('timeout');
    return {
      ok: false,
      message: isTimeout ? `timeout after ${TIMEOUT_MS / 1000}s` : msg,
    };
  }
}

export const kieProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  // KIE_API_KEY is canonical; KIEAI_API_KEY is the historical probe spelling
  // used by some installs. Both are accepted so no key is missed.
  envCandidates: ['KIE_API_KEY', 'KIEAI_API_KEY', 'KIE_AI_API_KEY'],
  fetchModels,
  verifyKey,
};

export default kieProvider;

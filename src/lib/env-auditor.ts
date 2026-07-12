/**
 * P2-04 — LLM ENV-AUDITOR ("Deep Scan").
 *
 * THE PROBLEM (operator's explicit ask)
 * --------------------------------------
 * The fixed-alias key detector (`provider-key-detection.ts` /
 * `studio/provider-discovery.ts`) only recognizes a key when it sits under one
 * of a small set of KNOWN env-var names (`OLLAMA_CLOUD_API_KEY`, `KIE_API_KEY`,
 * ...). A box that stores an equivalent key under an unconventional name (say
 * `MY_OLLAMA_TOKEN`) is invisible to it — no amount of alias-table growth can
 * close this gap in general, because the box owner can name a var anything.
 * The operator's fix: read the box's OWN env with a low-cost LLM instead of
 * hand-maintained substring/alias matching (Section 2.4 of the spec this ships
 * against — "no grepping to judge content" applies to the CC's own detection
 * exactly as it applies to QC judging).
 *
 * THE NON-NEGOTIABLE SAFETY CONTRACT
 * -----------------------------------
 *   1. VALUES ARE REDACTED BEFORE THE LLM SEES THEM. The prompt this module
 *      builds (`buildAuditPrompt`) is constructed ONLY from `RedactedCandidate`
 *      objects, whose `redacted` field is always `<SET:len=N>` — never the
 *      real value. There is no code path in this module that interpolates a
 *      raw secret into a string that could reach an LLM, a log line, or an API
 *      response.
 *   2. NEVER FABRICATE. `parseAuditResponse` only accepts a suggestion whose
 *      `env_var` is one of the candidates ACTUALLY offered and whose
 *      `provider` is a REAL, currently-registered provider slug
 *      (`ALL_PROVIDER_SLUGS`). A hallucinated env-var name or a hallucinated
 *      provider slug is silently dropped — this is a structural filter, not
 *      merely a prompt instruction, so it holds even against a
 *      misbehaving/compromised model response.
 *   3. AUTO-WIRING ONLY ON CONFIRM. `runEnvAudit` / `saveSuggestions` never
 *      write a provider key. They only persist a SUGGESTION row
 *      (`provider_key_audit_suggestions`, status='pending'). The secret value
 *      itself is never stored in that table. Only `confirmEnvAuditSuggestion`
 *      writes anything, and only after re-reading the value FRESH from its
 *      original source at confirm time (never persisted, never round-tripped
 *      through the LLM or the suggestions table).
 *   4. THE BOX'S OWN MODEL, NEVER ANTHROPIC. `resolveAuditorModel` picks a
 *      model from THIS box's own active `model_registry` inventory via the
 *      existing sovereign-default resolver (`resolveSovereignDefault` —
 *      W8.5), which already excludes Anthropic/free/forbidden models. This
 *      module adds one more explicit `isForbidden` guard on top as defense in
 *      depth. `ALL_PROVIDERS` itself never registers the Anthropic connector
 *      on a client box (see `model-providers/index.ts`), so there is no path
 *      by which this feature could route a client box's audit to Anthropic.
 *
 * SCOPE: this box only. The four named surfaces
 * (`$OPENCLAW_PROJECT_DIR/.env`, `~/.openclaw/.env`, `~/.openclaw/secrets/.env`,
 * `openclaw.json`) are all LOCAL paths — this module never opens an SSH tunnel
 * to a client box. The weekly job and the "Deep Scan" UI action both audit the
 * box Command Center is running on.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { queryAll, queryOne, run } from '@/lib/db';
import { openclawConfigPath } from '@/lib/platform';
import {
  candidateEnvFiles,
  parseDotEnv,
  extractOpenclawEnv,
  extractOpenclawProviderKeys,
  writeClientProviderKey,
} from '@/lib/studio/provider-discovery';
import { envCandidatesForProvider, resolveProviderApiKey } from '@/lib/provider-key-detection';
import { ALL_PROVIDERS, ALL_PROVIDER_SLUGS, getProviderForModelId } from '@/lib/model-providers';
import type { ModelProvider } from '@/lib/model-providers/types';
import { resolveSovereignDefault, isForbidden } from '@/lib/model-selector';
import { listModels } from '@/lib/model-registry';
import { getSelfClient } from '@/lib/clients';

// ---------------------------------------------------------------------------
// Redaction + candidate gathering.
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
 * Redact a secret value to a length-only marker. This is the ONLY form of a
 * value that is ever allowed into an LLM prompt, a log line, or an API
 * response from this module.
 */
export function redactValue(value: string): string {
  return `<SET:len=${value.length}>`;
}

/** One env-var name found on this box, with its value already redacted. */
export interface RedactedCandidate {
  env_var: string;
  /** Human-readable label of where it was found (for the prompt + UI). */
  source_label: string;
  /** Absolute path (or 'openclaw.json') the value must be RE-READ from at confirm time. */
  source_path: string;
  /** Always `<SET:len=N>` — never the real value. */
  redacted: string;
  /** The provider slug the STANDARD resolver already recognizes this env-var name for, if any. */
  already_recognized_provider: string | null;
}

/**
 * Which known provider (if any) already declares `envVar` as one of its
 * candidate names. Used so a suggestion is never surfaced for a pairing the
 * standard resolver already handles correctly.
 */
function recognizedProviderFor(envVar: string): string | null {
  for (const p of ALL_PROVIDERS) {
    if (envCandidatesForProvider(p).includes(envVar)) return p.slug;
  }
  return null;
}

/**
 * Any `*.env*`-named file directly under `~/.openclaw/` that is NOT one of the
 * three named candidate files. Per the spec this is a FILENAME LISTING ONLY —
 * we deliberately do not read or redact their content (they are outside the
 * documented candidate surfaces; surfacing just the name lets the operator
 * investigate without this module ever touching bytes it wasn't told to).
 */
export function listExtraEnvLikeFilenames(): string[] {
  try {
    const dir = path.join(os.homedir(), '.openclaw');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    const known = new Set(candidateEnvFiles().map((f) => path.basename(f)));
    return fs
      .readdirSync(dir)
      .filter((name) => {
        try {
          return /\.env/i.test(name) && !known.has(name) && fs.statSync(path.join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Gather every candidate env-var NAME across the documented surfaces
 * ($OPENCLAW_PROJECT_DIR/.env, ~/.openclaw/.env, ~/.openclaw/secrets/.env,
 * openclaw.json env/env.vars + models.providers[*].apiKey), with every value
 * REDACTED before it leaves this function. Never throws.
 */
export function gatherCandidateEnvEntries(): RedactedCandidate[] {
  const out: RedactedCandidate[] = [];
  const seen = new Set<string>();

  for (const file of candidateEnvFiles()) {
    const content = safeReadFile(file);
    if (!content) continue;
    const parsed = parseDotEnv(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || !value.trim() || seen.has(key)) continue;
      seen.add(key);
      out.push({
        env_var: key,
        source_label: file,
        source_path: file,
        redacted: redactValue(value),
        already_recognized_provider: recognizedProviderFor(key),
      });
    }
  }

  const cfgPath = openclawConfigPath();
  const cfgContent = safeReadFile(cfgPath);
  if (cfgContent) {
    let json: unknown = null;
    try {
      json = JSON.parse(cfgContent);
    } catch {
      json = null;
    }
    if (json) {
      const fromEnv = extractOpenclawEnv(json);
      for (const [key, value] of Object.entries(fromEnv)) {
        if (!value || !value.trim() || seen.has(key)) continue;
        seen.add(key);
        out.push({
          env_var: key,
          source_label: 'openclaw.json (env.vars)',
          source_path: cfgPath,
          redacted: redactValue(value),
          already_recognized_provider: recognizedProviderFor(key),
        });
      }
      const fromProviders = extractOpenclawProviderKeys(json);
      for (const [key, value] of Object.entries(fromProviders)) {
        if (!value || !value.trim() || seen.has(key)) continue;
        seen.add(key);
        out.push({
          env_var: key,
          source_label: 'openclaw.json (models.providers)',
          source_path: cfgPath,
          redacted: redactValue(value),
          already_recognized_provider: recognizedProviderFor(key),
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Prompt construction. Only ever fed RedactedCandidate objects.
// ---------------------------------------------------------------------------

/**
 * Build the audit prompt. By construction this function NEVER sees a raw
 * value — it only ever receives `RedactedCandidate.redacted` (`<SET:len=N>`).
 * There is no string concatenation path here that could carry a real secret.
 */
export function buildAuditPrompt(candidates: RedactedCandidate[], extraFiles: string[] = []): string {
  const knownSlugs = ALL_PROVIDER_SLUGS.join(', ');
  const lines = candidates.map((c) => {
    const already = c.already_recognized_provider
      ? `; already recognized by the standard resolver as "${c.already_recognized_provider}"`
      : '';
    return `- ${c.env_var} (found in ${c.source_label}; value ${c.redacted}${already})`;
  });

  const parts = [
    'You are auditing environment configuration for an AI task-dispatch platform ("Command Center").',
    'You are given ONLY key NAMES and where they were found. Every value has been REDACTED to a length ' +
      'marker (e.g. <SET:len=51>) — you never see, and must never guess, invent, or output, any real value.',
    `Known LLM / media-generation provider slugs this system supports: ${knownSlugs}.`,
    '',
    'Candidate environment keys found on this box:',
    ...(lines.length > 0 ? lines : ['(none found)']),
  ];

  if (extraFiles.length > 0) {
    parts.push(
      '',
      `Additional *.env*-named files exist under ~/.openclaw/ (names only, contents not read): ${extraFiles.join(', ')}`,
    );
  }

  parts.push(
    '',
    'TASK: classify ONLY the keys above that are genuinely LLM or media-generation provider API ' +
      'credentials (a text/image/video/audio-generation provider). Do NOT classify unrelated ' +
      'credentials — payment processors, CRMs, databases, webhooks, Telegram/Slack tokens, etc. — even ' +
      'if their name superficially resembles one, and even if you are unsure: when in doubt, omit it ' +
      'rather than guess.',
    'Respond with ONLY a single JSON object — no prose, no markdown code fence — in EXACTLY this shape:',
    '{"suggestions":[{"env_var":"<one of the candidate names above>","provider":"<one of the known ' +
      'slugs above>","confidence":"high"|"medium"|"low","reason":"<one short sentence>"}],' +
      '"unreadable_providers":["<slug>", ...]}',
    '"unreadable_providers" lists any known provider slug that appears to be configured under an ' +
      'unrecognized name but is NOT already listed as "already recognized" above.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing — structural filtering, never trusts the model blindly.
// ---------------------------------------------------------------------------

export interface EnvAuditSuggestion {
  env_var: string;
  provider: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface ParsedAuditResponse {
  suggestions: EnvAuditSuggestion[];
  unreadable_providers: string[];
}

/**
 * Parse the LLM's response. Every suggestion is checked against the REAL
 * candidate list and the REAL provider registry before it is accepted — a
 * hallucinated env-var name or a fabricated/decoy provider slug (e.g.
 * classifying a `FAKE_STRIPE_KEY` as some invented "stripe" provider — not a
 * registered LLM/media provider) cannot survive this filter, independent of
 * whether the model followed the prompt's instructions.
 */
export function parseAuditResponse(raw: string, candidates: RedactedCandidate[]): ParsedAuditResponse {
  const candidateNames = new Set(candidates.map((c) => c.env_var));
  const knownSlugs = new Set(ALL_PROVIDER_SLUGS);

  let parsed: unknown = null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { suggestions: [], unreadable_providers: [] };
  }

  const rawSuggestions = Array.isArray((parsed as Record<string, unknown>).suggestions)
    ? ((parsed as Record<string, unknown>).suggestions as unknown[])
    : [];

  const suggestions: EnvAuditSuggestion[] = [];
  const seenEnvVars = new Set<string>();
  for (const item of rawSuggestions) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const env_var = typeof s.env_var === 'string' ? s.env_var.trim() : '';
    const provider = typeof s.provider === 'string' ? s.provider.trim().toLowerCase() : '';
    const confidence: EnvAuditSuggestion['confidence'] =
      s.confidence === 'high' || s.confidence === 'medium' || s.confidence === 'low' ? s.confidence : 'low';
    const reason = typeof s.reason === 'string' ? s.reason.trim().slice(0, 300) : '';

    // Structural filter — never fabricate: the env var must be one WE offered,
    // the provider must be a REAL registered slug, and we only take the first
    // suggestion per env var.
    if (!env_var || !candidateNames.has(env_var)) continue;
    if (!provider || !knownSlugs.has(provider)) continue;
    if (seenEnvVars.has(env_var)) continue;
    seenEnvVars.add(env_var);
    suggestions.push({ env_var, provider, confidence, reason });
  }

  const rawUnreadable = Array.isArray((parsed as Record<string, unknown>).unreadable_providers)
    ? ((parsed as Record<string, unknown>).unreadable_providers as unknown[])
    : [];
  const unreadable_providers = Array.from(
    new Set(
      rawUnreadable
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim().toLowerCase())
        .filter((p) => knownSlugs.has(p)),
    ),
  );

  return { suggestions, unreadable_providers };
}

// ---------------------------------------------------------------------------
// Model resolution — the box's OWN cheap/quick tier, never Anthropic.
// ---------------------------------------------------------------------------

export interface AuditorModelChoice {
  provider: ModelProvider;
  /** Fully-qualified id, e.g. "ollama-cloud/llama3.3:70b". */
  modelId: string;
  /** The native id the connector's chatCompletion expects, e.g. "llama3.3:70b". */
  nativeModelId: string;
  apiKey: string;
}

/**
 * Pick the box's own sovereign model for the classification call. Reuses the
 * EXISTING W8.5 sovereign-default resolver (`resolveSovereignDefault`) rather
 * than introducing new selection logic — this is a read of the resolver's
 * output, never a new model added/removed/substituted. `isForbidden` is
 * checked again explicitly as defense in depth even though
 * `resolveSovereignDefault` and `ALL_PROVIDERS` (client boxes never register
 * the Anthropic connector) already guarantee it.
 *
 * Returns null when no eligible local model / key is available yet (e.g. a
 * fresh box that has never refreshed a catalog) — the caller must degrade
 * honestly rather than fabricate a classification.
 */
export function resolveAuditorModel(): AuditorModelChoice | null {
  const inventory = listModels(); // active-only by default
  if (inventory.length === 0) return null;

  const sovereign = resolveSovereignDefault(inventory, 'text');
  if (!sovereign || isForbidden(sovereign)) return null;

  const provider = getProviderForModelId(sovereign);
  if (!provider || !provider.chatCompletion) return null;

  const idx = sovereign.indexOf('/');
  if (idx <= 0) return null;
  const nativeModelId = sovereign.slice(idx + 1);

  const keyResult = resolveProviderApiKey(provider);
  if ('localEndpoint' in keyResult) {
    return { provider, modelId: sovereign, nativeModelId, apiKey: '' };
  }
  if (!keyResult.found) return null;

  return { provider, modelId: sovereign, nativeModelId, apiKey: keyResult.value };
}

/** Call the resolved model with the audit prompt. Returns the raw text content. */
export async function callAuditorLLM(choice: AuditorModelChoice, prompt: string): Promise<string> {
  if (!choice.provider.chatCompletion) {
    throw new Error(`provider ${choice.provider.slug} has no chatCompletion — cannot run the env audit`);
  }
  const res = await choice.provider.chatCompletion(choice.apiKey, {
    model: choice.nativeModelId,
    messages: [
      {
        role: 'system',
        content: 'You are a precise JSON-only classifier. Output ONLY the JSON object described by the user — no other text.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: 800,
  });
  return res.choices?.[0]?.message?.content ?? '';
}

// ---------------------------------------------------------------------------
// Persistence — suggestions only, NEVER the raw value.
// ---------------------------------------------------------------------------

export interface StoredSuggestion {
  id: number;
  run_at: string;
  env_var: string;
  source_path: string;
  source_label: string;
  suggested_provider: string;
  confidence: string;
  reason: string | null;
  status: 'pending' | 'confirmed' | 'dismissed';
  confirmed_at: string | null;
  confirmed_env_var: string | null;
}

/**
 * Persist fresh suggestions. Clears out the PREVIOUS pending batch first (a
 * re-run should replace stale suggestions, not pile up duplicates) — rows
 * already `confirmed` or `dismissed` are untouched (audit history). Skips any
 * suggestion whose (env_var, provider) pairing the standard resolver ALREADY
 * recognizes — there is nothing new to confirm there.
 */
export function saveSuggestions(
  candidates: RedactedCandidate[],
  parsed: ParsedAuditResponse,
  runAt: string = new Date().toISOString(),
): number {
  const byEnvVar = new Map(candidates.map((c) => [c.env_var, c]));
  run(`DELETE FROM provider_key_audit_suggestions WHERE status = 'pending'`);

  let count = 0;
  for (const s of parsed.suggestions) {
    const cand = byEnvVar.get(s.env_var);
    if (!cand) continue; // defensive; parseAuditResponse already guarantees this
    if (cand.already_recognized_provider === s.provider) continue; // already wired correctly

    run(
      `INSERT INTO provider_key_audit_suggestions
         (run_at, env_var, source_path, source_label, suggested_provider, confidence, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [runAt, s.env_var, cand.source_path, cand.source_label, s.provider, s.confidence, s.reason || null],
    );
    count += 1;
  }
  return count;
}

export function listPendingSuggestions(): StoredSuggestion[] {
  return queryAll<StoredSuggestion>(
    `SELECT * FROM provider_key_audit_suggestions
     WHERE status = 'pending'
     ORDER BY (confidence = 'high') DESC, (confidence = 'medium') DESC, run_at DESC`,
  );
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export interface EnvAuditRunResult {
  ok: boolean;
  candidates_found: number;
  suggestions_saved: number;
  unreadable_providers: string[];
  extra_files: string[];
  skipped_reason?: string;
}

/**
 * Run one full audit pass: gather -> redact -> prompt -> classify -> persist.
 *
 * `callOverride` lets a test (or a future non-local-model path) supply the raw
 * LLM response text directly instead of resolving + calling a live connector —
 * production code never passes it, so the default path always goes through
 * `resolveAuditorModel` + `callAuditorLLM` (the box's own sovereign model).
 */
export async function runEnvAudit(opts: {
  callOverride?: (prompt: string) => Promise<string>;
} = {}): Promise<EnvAuditRunResult> {
  const candidates = gatherCandidateEnvEntries();
  const extraFiles = listExtraEnvLikeFilenames();

  if (candidates.length === 0) {
    return { ok: true, candidates_found: 0, suggestions_saved: 0, unreadable_providers: [], extra_files: extraFiles };
  }

  const prompt = buildAuditPrompt(candidates, extraFiles);

  let rawResponse: string;
  if (opts.callOverride) {
    rawResponse = await opts.callOverride(prompt);
  } else {
    const choice = resolveAuditorModel();
    if (!choice) {
      return {
        ok: false,
        candidates_found: candidates.length,
        suggestions_saved: 0,
        unreadable_providers: [],
        extra_files: extraFiles,
        skipped_reason:
          'no local model is available yet to classify candidate keys — refresh a provider catalog first',
      };
    }
    try {
      rawResponse = await callAuditorLLM(choice, prompt);
    } catch (err) {
      return {
        ok: false,
        candidates_found: candidates.length,
        suggestions_saved: 0,
        unreadable_providers: [],
        extra_files: extraFiles,
        skipped_reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const parsed = parseAuditResponse(rawResponse, candidates);
  const savedCount = saveSuggestions(candidates, parsed, new Date().toISOString());

  return {
    ok: true,
    candidates_found: candidates.length,
    suggestions_saved: savedCount,
    unreadable_providers: parsed.unreadable_providers,
    extra_files: extraFiles,
  };
}

// ---------------------------------------------------------------------------
// Confirm / dismiss — auto-wiring happens ONLY here, and ONLY on confirm.
// ---------------------------------------------------------------------------

export interface ConfirmResult {
  ok: boolean;
  env_var?: string;
  target?: string;
  error?: string;
}

/** Re-read the CURRENT value fresh from its original source. Never logs it. */
function reReadValue(sourcePath: string, envVar: string): string | null {
  if (sourcePath === openclawConfigPath()) {
    const content = safeReadFile(sourcePath);
    if (!content) return null;
    let json: unknown = null;
    try {
      json = JSON.parse(content);
    } catch {
      return null;
    }
    const merged = { ...extractOpenclawEnv(json), ...extractOpenclawProviderKeys(json) };
    return merged[envVar]?.trim() || null;
  }
  const content = safeReadFile(sourcePath);
  if (!content) return null;
  const parsed = parseDotEnv(content);
  return parsed[envVar]?.trim() || null;
}

/**
 * Confirm one pending suggestion: re-reads the value FRESH (never from the DB
 * — the suggestions table never stores a secret), then writes it under the
 * suggested provider's canonical env-var name via the SAME `writeClientProviderKey`
 * path the existing E5 "Add API key" UI action uses. This is the ONLY function
 * in this module that ever writes a key, and it only runs when explicitly
 * called with an operator-confirmed suggestion id.
 */
export async function confirmEnvAuditSuggestion(id: number): Promise<ConfirmResult> {
  const row = queryOne<StoredSuggestion>(`SELECT * FROM provider_key_audit_suggestions WHERE id = ?`, [id]);
  if (!row) return { ok: false, error: 'suggestion not found' };
  if (row.status !== 'pending') return { ok: false, error: `suggestion already ${row.status}` };

  const value = reReadValue(row.source_path, row.env_var);
  if (!value) {
    return { ok: false, error: 'the source value could not be re-read (file changed or removed) — refusing to write' };
  }

  const client = getSelfClient();
  if (!client) return { ok: false, error: 'no self client is seeded on this box' };

  const write = await writeClientProviderKey(client, row.suggested_provider, value);
  if (!write.ok) {
    return { ok: false, error: write.error ?? 'write failed' };
  }

  run(
    `UPDATE provider_key_audit_suggestions SET status = 'confirmed', confirmed_at = ?, confirmed_env_var = ? WHERE id = ?`,
    [new Date().toISOString(), write.envVar, id],
  );
  return { ok: true, env_var: write.envVar, target: write.target };
}

export function dismissEnvAuditSuggestion(id: number): ConfirmResult {
  const row = queryOne<StoredSuggestion>(`SELECT * FROM provider_key_audit_suggestions WHERE id = ?`, [id]);
  if (!row) return { ok: false, error: 'suggestion not found' };
  if (row.status !== 'pending') return { ok: false, error: `suggestion already ${row.status}` };
  run(`UPDATE provider_key_audit_suggestions SET status = 'dismissed' WHERE id = ?`, [id]);
  return { ok: true };
}

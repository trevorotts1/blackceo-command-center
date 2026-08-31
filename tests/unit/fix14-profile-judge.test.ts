/**
 * FIX 14 — CC QC judge: stop Ollama-only.
 *
 * Spec (PRESENTATION-DEPT-FIX-SPEC.md, FIX 14):
 *   BROKEN: `qc-scorer.ts` judge selection requires an Ollama-Cloud judge model
 *   → non-Ollama clients fall to human review.
 *   FIX: allow the judge model to come from the client profile's available
 *   providers; fail-closed to human review only when NO judge is available on
 *   ANY owned provider.
 *   PROOF: a DeepSeek/OpenRouter-only profile gets auto-QC (judge runs), not an
 *   automatic human-review park.
 *
 * The client profile surface on the CC side is the provider registry + the key
 * stores `resolveProviderApiKey` scans (the same surface FIX 9's probes feed
 * and the weekly refresh job consumes). "Available" = provider connector
 * exists, a key resolves for it, AND the box's own model_registry carries at
 * least one active text-capable model for it (probed inventory — never a
 * guessed model id).
 *
 * Judge transport: whatever connector owns the selected model (OpenRouter,
 * OpenAI, Z.AI, Google, …) — the SAME sovereignty rule as before (client key,
 * never an operator/shared paid key), widened from "Ollama Cloud only" to
 * "any client-owned provider". JUDGE != WRITER still enforced.
 *
 * Rollback: PRESENTATION_QC_JUDGE_PROFILE=0 restores the Ollama-Cloud-only
 * judge selection verbatim (documented safe path).
 *
 * RED (pre-fix): with ONLY an OpenRouter key + an OpenRouter judge model
 * configured, scoreTaskForQC fails CLOSED to heuristic 'no-key' — the
 * automatic human-review park this fix removes. The probe unit test also
 * fails on the missing resolveJudgeSelection export.
 *
 * No network: the judge endpoint is a loopback HTTP stub. No secrets: keys are
 * fixture strings in env vars pointing at the stub, HOME is a temp dir.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

// ── Isolation from the host box's real key stores (P1-05 pattern) ───────────
// resolveProviderApiKey scans process.env AND os.homedir()/.openclaw/... Point
// HOME at an empty temp dir and strip every ambient provider key so a pass is
// a fixture pass, not the operator box's real credentials leaking in.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fix14-judge-home-'));
const ORIGINAL_HOME = process.env.HOME;

function clearProviderKeyEnv() {
  for (const name of [
    'OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
    'XAI_API_KEY', 'X_AI_API_KEY',
    'ZAI_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY', 'Z_AI_API_KEY',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'MOONSHOT_API_KEY', 'MINIMAX_API_KEY',
  ]) delete process.env[name];
  delete process.env.QC_JUDGE_MODEL;
  delete process.env.QC_JUDGE_MAX_TOKENS;
  delete process.env.QC_SIMULATE_PROVIDER_DOWN;
  delete process.env.QC_FIXTURE_JSON_PATH;
}

// Judge endpoint for the OpenRouter connector is read at module scope
// (BASE_URL = process.env.OPENROUTER_BASE_URL || ...) — so the stub's URL must
// be exported BEFORE the first import of any provider connector.
const OPENROUTER_STUB = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'stub-judge',
    model: 'deepseek-v4-pro',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: '{"score": 9.2, "pass": true, "reason": "Deliverable fulfills the request.", "gaps": []}' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  }));
});

const OLLAMACLOUD_STUB = http.createServer((_req, res) => {
  // The pre-fix path calls ollama-cloud when it can. If FIX 14 regresses into
  // preferring ollama-cloud despite NO ollama key, this stub stays untouched —
  // the test asserts the SELECTION, not this endpoint.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content: '{"score": 1.0, "pass": false, "reason": "wrong provider", "gaps": ["wrong provider"]}' }, finish_reason: 'stop' }],
  }));
});

let openrouterUrl = '';
let ollamaUrl = '';

beforeAll(async () => {
  await new Promise<void>((r) => OPENROUTER_STUB.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => OLLAMACLOUD_STUB.listen(0, '127.0.0.1', () => r()));
  openrouterUrl = `http://127.0.0.1:${(OPENROUTER_STUB.address() as AddressInfo).port}/v1`;
  ollamaUrl = `http://127.0.0.1:${(OLLAMACLOUD_STUB.address() as AddressInfo).port}`;
  process.env.OPENROUTER_BASE_URL = openrouterUrl;
  process.env.OLLAMA_CLOUD_BASE_URL = ollamaUrl;
});

afterAll(async () => {
  await new Promise<void>((r) => OPENROUTER_STUB.close(() => r()));
  await new Promise<void>((r) => OLLAMACLOUD_STUB.close(() => r()));
  if (process.env.OPENROUTER_BASE_URL === openrouterUrl) delete process.env.OPENROUTER_BASE_URL;
  if (process.env.OLLAMA_CLOUD_BASE_URL === ollamaUrl) delete process.env.OLLAMA_CLOUD_BASE_URL;
  process.env.HOME = ORIGINAL_HOME;
});

// The box's own probed inventory (Migration 031 model_registry): the
// "availability proof" FIX 9's probes leave behind. The judge selection reads
// this — it never invents a model id.
async function seedRegistry() {
  const db = (await import('../../src/lib/db')).getDb();
  const { run } = await import('../../src/lib/db');
  db.prepare('DELETE FROM model_registry').run();
  run(
    `INSERT INTO model_registry (model_id, label, provider, family, context_window,
       input_cost_per_million, output_cost_per_million, pricing_model, pricing_source,
       capabilities, status, added_at, last_seen_at, raw_metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'openrouter/deepseek-v4-pro', 'DeepSeek V4 Pro (via OpenRouter)', 'openrouter', 'deepseek', 131072,
      0.28, 0.42, 'per_token', 'provider_api',
      JSON.stringify(['text', 'reasoning', 'long_context', 'streaming']), 'active',
      new Date().toISOString(), new Date().toISOString(), '{}',
    ],
  );
}

const BASE_INPUT = {
  taskId: 'fix14-task',
  taskTitle: 'Build the Q3 launch deck',
  taskDescription: 'Assemble the 12-slide launch deck from the approved outline and export the final PDF plus the slide PNG bundle.',
  sopSuccessCriteria: 'Deck has 12 slides; every slide has a headline; export is a valid PDF; PNG bundle matches slide count.',
  sopName: 'Presentation SOP',
  sopSteps: null,
  departmentSlug: null,
  qcAgentId: 'qc-agent-1',
  qcAgentName: 'Presentation QC Specialist',
};

describe('FIX 14 — judge selection across client-owned providers', () => {
  it('exports resolveJudgeSelection for the widened judge scan', async () => {
    process.env.HOME = FAKE_HOME;
    clearProviderKeyEnv();
    delete process.env.PRESENTATION_QC_JUDGE_PROFILE;
    const mod = await import('../../src/lib/qc-scorer');
    const fn = (mod as unknown as Record<string, unknown>).resolveJudgeSelection;
    expect(typeof fn, 'FIX 14 export resolveJudgeSelection missing (pre-fix build)').toBe('function');
  });

  it('PROOF: a DeepSeek/OpenRouter-only profile gets auto-QC, not a human-review park', async () => {
    process.env.HOME = FAKE_HOME;
    clearProviderKeyEnv();
    delete process.env.PRESENTATION_QC_JUDGE_PROFILE;
    await seedRegistry();
    // OpenRouter-only client: key present, judge model named on OpenRouter,
    // NO ollama-cloud key anywhere (pre-fix this meant automatic park).
    process.env.OPENROUTER_API_KEY = 'fixture-openrouter-key-not-a-secret';

    const { scoreTaskForQC } = await import('../../src/lib/qc-scorer');
    const result = await scoreTaskForQC({
      ...BASE_INPUT,
      // Department QC agent configured with a NON-Ollama judge model.
      qcAgentModel: 'openrouter/deepseek-v4-pro',
      writerModel: 'ollama-cloud/deepseek-v4-flash:0731-cloud',
    });

    // THE FIX: the judge RAN on the client's OpenRouter route → real LLM
    // verdict. Pre-fix: scoringPath === 'heuristic' + heuristicReason
    // 'no-key' (the automatic human-review park).
    expect(result.scoringPath, `expected llm scoring on the OpenRouter judge, got: ${result.reason}`).toBe('llm');
    expect(result.score).toBe(9.2);
    expect(result.pass).toBe(true);
    expect(result.heuristicReason).toBeUndefined();
    expect(result.judgeModel).toBe('openrouter/deepseek-v4-pro');
    delete process.env.OPENROUTER_API_KEY;
  });

  it('selection names the owned provider + connector, never a bare guess', async () => {
    process.env.HOME = FAKE_HOME;
    clearProviderKeyEnv();
    delete process.env.PRESENTATION_QC_JUDGE_PROFILE;
    await seedRegistry();
    process.env.OPENROUTER_API_KEY = 'fixture-openrouter-key-not-a-secret';

    const mod = await import('../../src/lib/qc-scorer');
    const resolve = (mod as unknown as Record<string, unknown>).resolveJudgeSelection as
      (input: unknown) => { modelId: string; provider: string } | null;
    const sel = resolve({
      ...BASE_INPUT,
      qcAgentModel: 'openrouter/deepseek-v4-pro',
      writerModel: 'ollama-cloud/deepseek-v4-flash:0731-cloud',
    });
    expect(sel, 'judge selection must succeed for an OpenRouter-only client').not.toBeNull();
    expect(sel!.modelId).toBe('openrouter/deepseek-v4-pro');
    expect(sel!.provider).toBe('openrouter');
    delete process.env.OPENROUTER_API_KEY;
  });

  it('fail-closed ONLY when NO judge is available on ANY owned provider', async () => {
    process.env.HOME = FAKE_HOME;
    clearProviderKeyEnv();
    delete process.env.PRESENTATION_QC_JUDGE_PROFILE;
    await seedRegistry();
    // No provider key at all → no judge on ANY owned provider → human review.
    const { scoreTaskForQC } = await import('../../src/lib/qc-scorer');
    const result = await scoreTaskForQC({
      ...BASE_INPUT,
      qcAgentModel: 'openrouter/deepseek-v4-pro',
      writerModel: 'ollama-cloud/deepseek-v4-flash:0731-cloud',
    });
    expect(result.scoringPath).toBe('heuristic');
    expect(result.heuristicReason).toBe('no-key');
  });

  it('JUDGE != WRITER holds across providers (an OpenRouter writer cannot judge itself)', async () => {
    process.env.HOME = FAKE_HOME;
    clearProviderKeyEnv();
    delete process.env.PRESENTATION_QC_JUDGE_PROFILE;
    await seedRegistry();
    process.env.OPENROUTER_API_KEY = 'fixture-openrouter-key-not-a-secret';

    const { scoreTaskForQC } = await import('../../src/lib/qc-scorer');
    const result = await scoreTaskForQC({
      ...BASE_INPUT,
      qcAgentModel: 'openrouter/deepseek-v4-pro',
      writerModel: 'openrouter/deepseek-v4-pro', // same model wrote it
    });
    expect(result.scoringPath).toBe('heuristic');
    expect(result.heuristicReason).toBe('no-key');
    expect(result.reason).toMatch(/JUDGE != WRITER|judge model equals writer model/);
    delete process.env.OPENROUTER_API_KEY;
  });

  it('flag PRESENTATION_QC_JUDGE_PROFILE=0 rolls back to Ollama-Cloud-only selection', async () => {
    process.env.HOME = FAKE_HOME;
    clearProviderKeyEnv();
    process.env.PRESENTATION_QC_JUDGE_PROFILE = '0';
    await seedRegistry();
    process.env.OPENROUTER_API_KEY = 'fixture-openrouter-key-not-a-secret';

    const mod = await import('../../src/lib/qc-scorer');
    const resolve = (mod as unknown as Record<string, unknown>).resolveJudgeSelection as
      (input: unknown) => { modelId: string; provider: string } | null;
    const sel = resolve({
      ...BASE_INPUT,
      qcAgentModel: 'openrouter/deepseek-v4-pro',
      writerModel: 'ollama-cloud/deepseek-v4-flash:0731-cloud',
    });
    // Rollback path: a non-Ollama judge id is NOT selectable.
    expect(sel).toBeNull();
    delete process.env.PRESENTATION_QC_JUDGE_PROFILE;
    delete process.env.OPENROUTER_API_KEY;
  });
});
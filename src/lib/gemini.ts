/**
 * Thin Gemini synthesis wrapper.
 *
 * Per N1 (no Anthropic / no GPT in the dashboard's auto-generation paths),
 * the auto-research SOP replacement flow uses Gemini to synthesize Tavily
 * results into structured SOP JSON.
 *
 * Fixture support: set `GEMINI_FIXTURE_JSON_PATH` to a JSON file whose
 * contents are the SOP JSON Gemini would normally return. No live cost.
 */

import fs from 'fs';
import { assertNoFixtureEnvInProduction } from '@/lib/fixture-guard';

export interface GeminiGenerateOptions {
  model?: string; // default: GEMINI_SYNTHESIS_MODEL || GEMINI_MODEL || 'gemini-flash-latest'
  temperature?: number;
  response_mime_type?: 'application/json' | 'text/plain';
}

/**
 * True when a generation failure is genuinely a MODEL problem: the model id
 * is retired/unknown/unsupported for this API version. Only then may the
 * thrown error carry the "(model '<id>' retired or unavailable?)" suffix.
 */
function isModelProblem(status: number, body: string): boolean {
  return status === 404
    || /not found for API version/i.test(body)
    || /unknown model/i.test(body)
    || /does not exist/i.test(body)
    || /not[ -]?supported/i.test(body)
    || /unsupported/i.test(body);
}

/**
 * True when a generation failure is a BILLING/QUOTA wall rather than a model
 * defect. Mirrors the billing-vs-transient classification in
 * src/lib/sop-embeddings.ts (isNonRetryableBillingExhaustion): a 429 whose
 * body names depleted credits / quota / billing means the ACCOUNT is empty,
 * not that the model id is wrong. Live-proven on a real box: a 429
 * ("Your prepayment credits are depleted") against a healthy model id was
 * mislabelled as a retired model.
 */
function isBillingProblem(status: number, body: string): boolean {
  return status === 429
    || /prepayment credits are depleted/i.test(body)
    || /credits are depleted/i.test(body)
    || /insufficient credits/i.test(body)
    || /\bquota\b/i.test(body)
    || /\bbilling\b/i.test(body);
}

/**
 * Calls Gemini with a single user prompt and returns the raw text.
 * Caller is responsible for JSON.parse if response_mime_type='application/json'.
 */
export async function geminiGenerate(prompt: string, opts: GeminiGenerateOptions = {}): Promise<string> {
  // QC-11: never honor GEMINI_FIXTURE_JSON_PATH on a production box — a fixture
  // would let a hand-written SOP draft bypass live synthesis. No-op in dev/test.
  assertNoFixtureEnvInProduction();

  const fixturePath = process.env.GEMINI_FIXTURE_JSON_PATH;
  if (fixturePath) {
    return fs.readFileSync(fixturePath, 'utf8');
  }

  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY (or GEMINI_API_KEY) is not set. Set it in .env.local or pass GEMINI_FIXTURE_JSON_PATH for testing.');
  }

  // Default model: 'gemini-1.5-flash' is EOL (Google returns 404
  // "models/gemini-1.5-flash is not found for API version v1beta").
  // GEMINI_SYNTHESIS_MODEL (synthesis-specific) wins, then GEMINI_MODEL,
  // then the 'gemini-flash-latest' alias so the next EOL needs no code change.
  const model = opts.model
    || process.env.GEMINI_SYNTHESIS_MODEL
    || process.env.GEMINI_MODEL
    || 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      // QC-07: SOP synthesis must be deterministic. This wrapper's ONLY callers
      // are the SOP auto-replace / auto-authoring flows, so the default is
      // temperature 0 (grounded, repeatable output). A caller may still override.
      temperature: opts.temperature ?? 0,
      response_mime_type: opts.response_mime_type || 'application/json',
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    // Fail LOUD — but label accurately. A 429 billing wall is an empty
    // account, not a retired model; the model suffix applies ONLY to a
    // genuine model problem (404 / not-found-for-version / does-not-exist /
    // unsupported). NEVER silently fall back to a different model — that
    // would mask the next EOL exactly the way the hardcoded gemini-1.5-flash did.
    if (isModelProblem(res.status, text)) {
      console.error(`[gemini] model '${model}' appears retired or unavailable (HTTP ${res.status}). Set GEMINI_SYNTHESIS_MODEL or GEMINI_MODEL to a current id.`);
      throw new Error(`Gemini generateContent failed: ${res.status} (model '${model}' retired or unavailable?) ${text.slice(0, 200)}`);
    }
    if (isBillingProblem(res.status, text)) {
      console.error(`[gemini] billing/quota wall (HTTP ${res.status}). Check account credits/quota — the model id '${model}' is not the problem.`);
      throw new Error(`Gemini generateContent failed: ${res.status} (billing/quota exhausted — check account credits) ${text.slice(0, 200)}`);
    }
    throw new Error(`Gemini generateContent failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json() as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini returned no text content');
  }
  return text;
}

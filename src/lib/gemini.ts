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
  model?: string; // default 'gemini-1.5-flash'
  temperature?: number;
  response_mime_type?: 'application/json' | 'text/plain';
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

  const model = opts.model || 'gemini-1.5-flash';
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

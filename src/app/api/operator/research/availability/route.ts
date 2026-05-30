/**
 * GET /api/operator/research/availability
 *
 * Reports whether the Research sub-module is LIVE on this box and, if so, which
 * provider would handle a query. Backs the page's "live" banner vs the honest
 * empty-state ("Add a Perplexity/OpenAI/Ollama/xAI key to enable Research").
 *
 * Provider-agnostic as of v4.1.5. Auto-discovers keys from the environment
 * (incl. OpenClaw secret files) in the preference order PERPLEXITY > OPENAI >
 * OLLAMA (cloud) > XAI. Never fabricates a key; never throws.
 *
 * Response:
 *   {
 *     available: boolean,
 *     selected: 'perplexity'|'openai'|'ollama'|'xai'|null,
 *     selectedDisplayName: string|null,
 *     providers: [{ slug, displayName, present, defaultModel, callSummary }...],
 *     enable_env_vars: string[]   // canonical env var per provider
 *   }
 */

import { NextResponse } from 'next/server';
import { researchAvailability } from '@/lib/research/provider-discovery';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const a = researchAvailability();
    return NextResponse.json({
      available: a.available,
      selected: a.selected,
      selectedDisplayName: a.selectedDisplayName,
      providers: a.providers.map((p) => ({
        slug: p.slug,
        displayName: p.displayName,
        present: p.present,
        defaultModel: p.defaultModel,
        callSummary: p.callSummary,
      })),
      enable_env_vars: a.enableHintEnvVars,
    });
  } catch (err) {
    // Be honest but never 500 the page — report unavailable on any failure.
    return NextResponse.json({
      available: false,
      selected: null,
      selectedDisplayName: null,
      providers: [],
      enable_env_vars: ['PERPLEXITY_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_CLOUD_API_KEY', 'X_AI_API_KEY'],
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

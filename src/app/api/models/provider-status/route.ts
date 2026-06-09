/**
 * GET /api/models/provider-status
 *
 * Returns the key-detection status for every AI model provider AND every
 * registered integration (e.g. Notion), scanning ALL available env stores —
 * not just process.env. This powers the "Provider catalog" panel on the
 * Intelligence Settings page so it correctly reports providers/integrations
 * the client HAS as configured, even when the key lives in a secondary env
 * store (OpenClaw .env, openclaw.json env.vars, etc.).
 *
 * Response shape:
 * {
 *   providers: ProviderStatusEntry[],
 *   integrations: IntegrationStatusEntry[],
 *   generated_at: string,
 * }
 */

import { NextResponse } from 'next/server';
import { ALL_PROVIDERS } from '@/lib/model-providers';
import { resolveProviderApiKey, envCandidatesForProvider } from '@/lib/provider-key-detection';
import { INTEGRATION_CATALOG } from '@/lib/integration-catalog';
import {
  candidateEnvFiles,
  parseDotEnv,
  extractOpenclawEnv,
  extractOpenclawProviderKeys,
} from '@/lib/studio/provider-discovery';
import { openclawConfigPath } from '@/lib/platform';
import fs from 'fs';

export const dynamic = 'force-dynamic';

export interface ProviderStatusEntry {
  slug: string;
  displayName: string;
  /** 'api_key' | 'local_endpoint' | 'oauth' */
  authType: string;
  /** true when the provider is configured (key found in any store, or local_endpoint). */
  configured: boolean;
  /** The env-var name the key was found under. null for local_endpoint or not found. */
  foundEnvVar: string | null;
  /** Where the key was found. null when not found or local_endpoint. */
  foundInStore: 'process.env' | 'env_file' | 'openclaw_json' | null;
  /** For local_endpoint providers: the base URL being used. */
  localEndpointUrl?: string;
  /** All candidate env-var names checked (for tooltip). */
  envCandidates: string[];
}

export interface IntegrationStatusEntry {
  slug: string;
  displayName: string;
  section: string;
  description: string;
  configured: boolean;
  foundEnvVar: string | null;
  foundInStore: 'process.env' | 'env_file' | 'openclaw_json' | null;
  envCandidates: string[];
}

function safeReadFile(p: string): string | null {
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Detect whether any of `candidates` is present in any env store.
 * Returns the found env-var name, its value, and the source; or null if absent.
 */
function detectKey(candidates: readonly string[]): {
  envVar: string;
  source: 'process.env' | 'env_file' | 'openclaw_json';
} | null {
  // 1. process.env
  for (const c of candidates) {
    if (process.env[c]?.trim()) return { envVar: c, source: 'process.env' };
  }

  // 2. .env files
  for (const file of candidateEnvFiles()) {
    const content = safeReadFile(file);
    if (!content) continue;
    const parsed = parseDotEnv(content);
    for (const c of candidates) {
      if (parsed[c]?.trim()) {
        process.env[c] = parsed[c].trim(); // hydrate for future calls
        return { envVar: c, source: 'env_file' };
      }
    }
  }

  // 3. openclaw.json
  const cfgContent = safeReadFile(openclawConfigPath());
  if (cfgContent) {
    let json: unknown = null;
    try { json = JSON.parse(cfgContent); } catch { /* ignore */ }
    if (json) {
      const merged = { ...extractOpenclawEnv(json), ...extractOpenclawProviderKeys(json) };
      for (const c of candidates) {
        if (merged[c]?.trim()) {
          process.env[c] = merged[c].trim();
          return { envVar: c, source: 'openclaw_json' };
        }
      }
    }
  }

  return null;
}

export async function GET() {
  try {
    // --- AI model providers ---
    const providers: ProviderStatusEntry[] = ALL_PROVIDERS.map((p) => {
      const authType = p.authType ?? 'api_key';
      if (authType === 'local_endpoint') {
        // Local endpoint: always "configured" (no key needed). Surface the
        // endpoint URL so the operator can see what it's pointed at.
        const localUrl =
          process.env.OLLAMA_LOCAL_HOST ||
          (p.slug === 'ollama-local' ? 'http://localhost:11434' : undefined);
        return {
          slug: p.slug,
          displayName: p.displayName,
          authType,
          configured: true,
          foundEnvVar: null,
          foundInStore: null,
          localEndpointUrl: localUrl,
          envCandidates: [],
        };
      }

      const candidates = envCandidatesForProvider(p);
      const found = detectKey(candidates);
      return {
        slug: p.slug,
        displayName: p.displayName,
        authType,
        configured: found !== null,
        foundEnvVar: found?.envVar ?? null,
        foundInStore: found?.source ?? null,
        envCandidates: candidates,
      };
    });

    // --- Integrations (Notion, etc.) ---
    const integrations: IntegrationStatusEntry[] = INTEGRATION_CATALOG.map((entry) => {
      const found = detectKey(entry.envCandidates);
      return {
        slug: entry.slug,
        displayName: entry.displayName,
        section: entry.section,
        description: entry.description,
        configured: found !== null,
        foundEnvVar: found?.envVar ?? null,
        foundInStore: found?.source ?? null,
        envCandidates: Array.from(entry.envCandidates),
      };
    });

    return NextResponse.json({
      providers,
      integrations,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/models/provider-status] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load provider status', message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

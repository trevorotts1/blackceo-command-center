import { NextResponse } from 'next/server';
import { existsSync, readFileSync, statSync } from 'fs';
import { getDb } from '@/lib/db';
import { openclawConfigPath } from '@/lib/platform';

// Maximum allowed config file size (1MB) to prevent DoS
const MAX_CONFIG_SIZE_BYTES = 1024 * 1024;

interface RegistryModelRow {
  model_id: string;
  status: string;
}

/**
 * Read the active model_id list from `model_registry`. Per PRD Section 3.2
 * (Fix #2) this replaces hardcoded fallback lists. Returns an empty array if
 * the registry is empty or the table does not exist yet (fresh install
 * before Migration 031 ran), and the caller falls back to the OpenClaw
 * config file.
 */
function loadRegistryModelIds(): string[] {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT model_id, status FROM model_registry
         WHERE status IN ('active', 'preview')
         ORDER BY provider, label`
      )
      .all() as RegistryModelRow[];
    return rows.map((r) => r.model_id);
  } catch (err) {
    console.warn('[openclaw/models] model_registry read failed, falling back to OpenClaw config:', err);
    return [];
  }
}

interface OpenClawConfig {
  agents?: {
    defaults?: {
      model?: {
        primary?: string;
      };
      models?: Record<string, {
        alias?: string;
      }>;
    };
  };
  models?: {
    providers?: Record<string, {
      models?: Array<{
        id: string;
        name: string;
      }>;
    }>;
  };
}

interface OpenClawModelsResponse {
  defaultModel?: string;
  availableModels: string[];
  error?: string;
}

/**
 * GET /api/openclaw/models
 *
 * Returns the available models for this deployment, with the model_registry
 * (Migration 031) as the canonical source, OpenClaw's `openclaw.json` as a
 * fallback, and a short hardcoded list of placeholder ids as the final
 * fallback when nothing else exists yet on a brand new install.
 *
 * The config path is resolved via `openclawConfigPath()` from `platform.ts`
 * per PRD Section 3.6 (Fix #6) so this works on Mac Mini AND VPS Docker
 * deployments.
 *
 * Security: validates file size before reading to prevent DoS attacks.
 */
export async function GET() {
  const configPath = openclawConfigPath();

  try {
    const models = new Set<string>(loadRegistryModelIds());

    // Always also try to read OpenClaw config to surface provider-level
    // models that the operator added manually but the refresh job has not
    // catalogued yet. Failure here is non-fatal.
    let defaultModel: string | undefined;
    let configError: string | undefined;

    if (existsSync(configPath)) {
      const stats = statSync(configPath);
      if (stats.size > MAX_CONFIG_SIZE_BYTES) {
        configError = `Config file too large (${(stats.size / 1024).toFixed(0)}KB). Maximum allowed size is ${MAX_CONFIG_SIZE_BYTES / 1024}KB.`;
      } else {
        try {
          const configContent = readFileSync(configPath, 'utf-8');
          const config: OpenClawConfig = JSON.parse(configContent);
          defaultModel = config?.agents?.defaults?.model?.primary;

          if (config.models?.providers) {
            for (const [providerName, provider] of Object.entries(config.models.providers)) {
              if (provider.models) {
                for (const model of provider.models) {
                  models.add(`${providerName}/${model.id}`);
                  models.add(model.id);
                }
              }
            }
          }

          if (config.agents?.defaults?.models) {
            for (const modelKey of Object.keys(config.agents.defaults.models)) {
              models.add(modelKey);
            }
          }
        } catch (parseErr) {
          configError = parseErr instanceof Error ? parseErr.message : 'Failed to parse OpenClaw config';
        }
      }
    } else if (models.size === 0) {
      // No registry rows AND no OpenClaw config. Tell the caller the
      // canonical path we tried so they can fix it.
      configError = `OpenClaw config not found at ${configPath} and model_registry is empty`;
    }

    // Final fallback so the dashboard does not present an empty dropdown on
    // a brand-new install. Replaced as soon as the refresh job runs.
    if (models.size === 0) {
      models.add('anthropic/claude-sonnet-4-5');
      models.add('anthropic/claude-opus-4-5');
      models.add('anthropic/claude-haiku-4-5');
      models.add('openai/gpt-4o');
      models.add('openai/o1');
    }

    const status = models.size > 0 ? 200 : 404;
    return NextResponse.json<OpenClawModelsResponse>(
      {
        defaultModel,
        availableModels: Array.from(models).sort(),
        ...(configError ? { error: configError } : {}),
      },
      { status }
    );
  } catch (error) {
    console.error('Failed to read OpenClaw config:', error);
    return NextResponse.json<OpenClawModelsResponse>(
      {
        defaultModel: undefined,
        availableModels: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

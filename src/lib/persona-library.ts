/**
 * Shared persona-library loader (TCC-safe, cached).
 *
 * The persona catalog lives in persona-categories.json at several candidate
 * paths. Two route modules (api/personas, api/settings/intelligence) duplicate
 * the loader inline; this module provides a single source of truth that
 * isValidPersonaId can also use without importing route-layer code.
 *
 * The first call loads the file (safeReadFileUtf8) and caches the result for
 * the process lifetime. A fresh load can be forced via loadPersonaLibrary(true).
 */

import { safeReadFileUtf8 } from '@/lib/fs/safe-fs';
import { join, resolve } from 'path';
import os from 'os';

export interface PersonaCategoryEntry {
  author: string;
  book: string;
  domain: string[];
  perspective: string[];
  custom: string[];
}

let cached: { ids: Set<string>; entries: Record<string, PersonaCategoryEntry> } | null = null;

function candidatePaths(): string[] {
  const homedir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const workspaceBase = process.env.WORKSPACE_BASE_PATH
    ? resolve(process.env.WORKSPACE_BASE_PATH.replace(/^~/, homedir))
    : join(homedir, 'clawd');

  return [
    join(workspaceBase, 'coaching-personas', 'persona-categories.json'),
    join(homedir, 'Downloads', 'openclaw-master-files', 'coaching-personas', 'persona-categories.json'),
    join(
      homedir,
      '.openclaw',
      'skills',
      '22-book-to-persona-coaching-leadership-system',
      'persona-categories.json',
    ),
    join('/opt', 'openclaw', 'skills', '22-book-to-persona-coaching-leadership-system', 'persona-categories.json'),
  ];
}

/**
 * Load (and cache) the persona library.
 *
 * Returns `null` when no file could be read (none of the candidate paths
 * exist or are accessible) — callers must degrade gracefully.
 */
export function loadPersonaLibrary(
  force?: boolean,
): { ids: Set<string>; entries: Record<string, PersonaCategoryEntry> } | null {
  if (cached && !force) return cached;

  for (const p of candidatePaths()) {
    const raw = safeReadFileUtf8(p);
    if (raw == null) continue;
    try {
      const parsed = JSON.parse(raw);
      const entries: Record<string, PersonaCategoryEntry> = parsed.personas || {};
      const ids = new Set(Object.keys(entries));
      cached = { ids, entries };
      return cached;
    } catch {
      console.error(`[persona-library] Failed to parse ${p}`);
    }
  }

  console.warn('[persona-library] No persona-categories.json found — persona validation degraded to sentinel-only');
  return null;
}

/**
 * True when `id` is a key in the loaded persona-categories.json.
 *
 * Returns false when:
 *  - The id is null/undefined/empty.
 *  - The id is a known sentinel value.
 *  - The library loaded successfully AND the id is not a key in it.
 *
 * Returns true when:
 *  - The library loaded successfully AND the id is a key in it.
 *  - The library failed to load (TCC block, missing file, etc.) AND the id
 *    passes the sentinel check — graceful degradation so a missing catalog
 *    does not lock every card in Backlog.
 */
export function isKnownPersonaId(personaId: string | null | undefined): boolean {
  if (!personaId) return false;

  const v = personaId.toLowerCase().trim();

  // Sentinel fast-path — these are never valid, regardless of library state.
  const SENTINELS = new Set(['schemaversion', 'schema_version', 'null', 'none', 'undefined', '']);
  if (SENTINELS.has(v)) return false;

  const lib = loadPersonaLibrary();
  if (!lib) {
    // Library unavailable — degrade to sentinel-only (pre-existing behavior)
    // so the system stays operational. Log once to make the gap visible.
    console.warn('[persona-library] Persona gate degraded — no catalog available');
    return true;
  }

  // Require the id to actually exist in the library. This is the quality-gate
  // fix: no more garbage persona_id slipping through the Triad gate.
  return lib.ids.has(v);
}

/**
 * Clear the in-memory cache (useful for tests).
 */
export function clearPersonaLibraryCache(): void {
  cached = null;
}

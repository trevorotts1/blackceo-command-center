/**
 * Module-memory cache for the `/api/health` embeddings block (F2.3 / DEP-11).
 *
 * The probe shells out to python3 and scans two SQLite stores; a health poll
 * (or a watchdog) must not pay that on every request. Five minutes is fresh
 * enough for a status surface and cheap enough for a polled endpoint.
 *
 * This lives in `src/lib` rather than in the route file because a Next.js App
 * Router route file may export ONLY route names (GET/POST/dynamic/revalidate
 * and the like). A test-only reset helper exported from the route fails the
 * generated route type check (TS2344), which breaks every app build.
 */

const EMBEDDINGS_CACHE_MS = 5 * 60 * 1000;

let embeddingsCache: { at: number; block: Record<string, unknown> } | null = null;

/** The cached block while it is younger than the lifetime, else null. */
export function readEmbeddingsCache(): Record<string, unknown> | null {
  if (embeddingsCache && Date.now() - embeddingsCache.at < EMBEDDINGS_CACHE_MS) {
    return embeddingsCache.block;
  }
  return null;
}

/** Store a block as the current cache entry, stamped now. */
export function writeEmbeddingsCache(block: Record<string, unknown>): void {
  embeddingsCache = { at: Date.now(), block };
}

/** Test-only: drop the cached embeddings block between cases. */
export function __resetEmbeddingsCache(): void {
  embeddingsCache = null;
}

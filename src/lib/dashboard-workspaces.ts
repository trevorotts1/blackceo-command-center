/**
 * Pure decision logic for the home-dashboard producer-board slot (P1-03,
 * "Dashboard / cards intermittent-load fix").
 *
 * ROOT CAUSE (class 3, grounded in the P1-03 recon): `src/app/page.tsx`
 * fetches `/api/workspaces` to decide which producer-board cards (Anthology,
 * Podcast) to render, gated on the deployment actually having that workspace
 * seeded. Previously ANY fetch failure (network error, non-2xx) was caught
 * and swallowed, leaving `presentSlugs` empty — indistinguishable from "this
 * box genuinely has no producer engines." A transient API hiccup silently
 * read as "missing cards."
 *
 * Extracted into a pure module (no React, no DOM) so the branching logic is
 * unit-testable without a component-rendering harness, which this repo does
 * not otherwise carry (no jsdom/testing-library dependency).
 */

/** How long the dashboard waits before re-attempting /api/workspaces after a
 *  failure (P1-03 c.1: "with a 15s retry, instead of omitting them"). */
export const WORKSPACES_RETRY_MS = 15_000;

export type WorkspacesStatus = 'loading' | 'ok' | 'error';

interface WorkspaceSlugSource {
  slug?: unknown;
}

/**
 * Parse a `/api/workspaces` JSON payload into a lowercase slug Set. Tolerant
 * of a non-array payload (returns an empty set) and of entries missing/with a
 * non-string `slug` (filtered out) — never throws.
 */
export function parseWorkspaceSlugs(data: unknown): Set<string> {
  const list: WorkspaceSlugSource[] = Array.isArray(data) ? data : [];
  return new Set(
    list
      .filter((w) => typeof w?.slug === 'string' && w.slug.length > 0)
      .map((w) => (w.slug as string).toLowerCase()),
  );
}

/**
 * Build the `POST /api/events` body for a failed `/api/workspaces` fetch
 * (P1-03 c.1: "Log a `dashboard_workspaces_fetch_failed` event"). `attempt`
 * is 1-indexed (the first attempt that failed is attempt 1).
 */
export function buildWorkspacesFetchFailedEvent(
  attempt: number,
  reason: string,
): { type: string; message: string; metadata: { attempt: number; reason: string } } {
  return {
    type: 'dashboard_workspaces_fetch_failed',
    message:
      `Dashboard failed to load /api/workspaces (attempt ${attempt}): ${reason}. ` +
      `Producer-board cards degraded; retrying in ${WORKSPACES_RETRY_MS / 1000}s.`,
    metadata: { attempt, reason },
  };
}

export interface ProducerBoardCandidate {
  slug: string;
}

export type ProducerCardSelection =
  | { degraded: true }
  | { degraded: false; slugs: string[] };

/**
 * Decide which producer-board card slot(s) should render, given the current
 * `/api/workspaces` fetch status.
 *
 * - `'error'` → a single degraded sentinel slot (`{ degraded: true }`),
 *   instead of silently returning zero cards (the pre-fix fail-EMPTY bug).
 *   The caller renders this as a visible "Board data unavailable —
 *   retrying" placeholder, never omits it.
 * - `'loading' | 'ok'` → gate strictly on `presentSlugs`, exactly as before
 *   this fix — a box that genuinely has no producer engines still shows zero
 *   producer cards, which is correct (not every box has Anthology/Podcast).
 */
export function selectProducerCardSlugs(
  status: WorkspacesStatus,
  presentSlugs: Set<string>,
  candidates: ProducerBoardCandidate[],
): ProducerCardSelection {
  if (status === 'error') {
    return { degraded: true };
  }
  return {
    degraded: false,
    slugs: candidates.filter((c) => presentSlugs.has(c.slug)).map((c) => c.slug),
  };
}

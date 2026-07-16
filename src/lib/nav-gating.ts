/**
 * Pure decision logic for engine-gated global navigation (GK-15 / U77,
 * "Podcast dashboard transplant into the Command Center", Option C —
 * "the /podcast entry renders ONLY where the Podcast Production Engine
 * exists on the box").
 *
 * Mirrors the existing home-dashboard producer-board gating pattern
 * (`src/lib/dashboard-workspaces.ts`, P1-03) so the same "workspace slug
 * present" signal that gates the home-page producer card also gates the
 * matching global nav item — one source of truth for "does this box have
 * this engine", never two.
 *
 * Kept framework-agnostic (no React) so it is unit-testable without a
 * component-rendering harness, matching this repo's existing convention
 * (no jsdom/testing-library dependency).
 */

import type { WorkspacesStatus } from './dashboard-workspaces';

/**
 * Whether an engine-gated nav item should render.
 *
 * FAILS CLOSED: while the workspaces fetch is still `'loading'` or has
 * `'error'`'d, we do not yet KNOW whether the engine is present, so the nav
 * item stays hidden rather than flashing in then possibly disappearing (or
 * worse, staying visible as a dead link on a box that never has the
 * engine). It renders only once the fetch has resolved `'ok'` AND the
 * engine's workspace slug is present in the result — the same "renders ONLY
 * where the engine exists" contract as the home-page producer-board card,
 * applied to the sidebar/nav instead.
 */
export function shouldShowEngineNavItem(
  status: WorkspacesStatus,
  presentSlugs: Set<string>,
  slug: string,
): boolean {
  return status === 'ok' && presentSlugs.has(slug);
}

interface NavItemLike {
  href: string;
}

/**
 * Insert an engine-gated nav item into a base nav list, immediately after
 * the item whose `href` matches `afterHref` (falls back to appending at the
 * end if no such item exists, so a future rename of the anchor item degrades
 * gracefully instead of throwing). Returns `baseItems` unchanged (same
 * reference) when `show` is false, so callers doing referential-equality
 * checks (e.g. React memoization) see no spurious change while the engine is
 * absent.
 */
export function insertEngineNavItem<T extends NavItemLike>(
  baseItems: T[],
  afterHref: string,
  engineItem: T,
  show: boolean,
): T[] {
  if (!show) return baseItems;
  const idx = baseItems.findIndex((item) => item.href === afterHref);
  const insertAt = idx >= 0 ? idx + 1 : baseItems.length;
  return [...baseItems.slice(0, insertAt), engineItem, ...baseItems.slice(insertAt)];
}

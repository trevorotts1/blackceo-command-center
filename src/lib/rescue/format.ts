/**
 * Rescue Rangers dashboard: client-safe formatting helpers.
 *
 * No node-only imports here; this module ships to the browser bundle. It is a
 * deliberate sibling of `src/lib/podcast/format.ts` rather than an import from
 * it: the two dashboards read different stores with different timestamp
 * conventions, and cross-importing would make a podcast-side change able to
 * break the rescue page. Same technique, separately owned.
 *
 * The rescue store writes strict ISO-8601 UTC (`new Date().toISOString()`),
 * so parsing needs no dialect repair — but the guard is kept so a hand-edited
 * or legacy row renders blank instead of "Invalid Date".
 */

import { formatDistanceToNow, format as formatDate } from 'date-fns';

export function parseStoreTime(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T');
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "3 hours ago" style relative time; empty string when unknown. */
export function relativeTime(iso: string | null | undefined): string {
  const d = parseStoreTime(iso);
  return d ? formatDistanceToNow(d, { addSuffix: true }) : '';
}

/** Absolute timestamp for title attributes and the timeline gutter. */
export function absoluteTime(iso: string | null | undefined): string {
  const d = parseStoreTime(iso);
  return d ? formatDate(d, 'yyyy-MM-dd HH:mm:ss') : '';
}

/** Clock time only, for dense timeline rows. */
export function clockTime(iso: string | null | undefined): string {
  const d = parseStoreTime(iso);
  return d ? formatDate(d, 'HH:mm:ss') : '';
}

/** "42 min" / "3.5 h" for MTTR. */
export function durationCopy(minutes: number | null): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return 'n/a';
  if (minutes < 90) return `${Math.round(minutes)} min`;
  return `${Math.round((minutes / 60) * 10) / 10} h`;
}

/** Turn the store's SCREAMING_SNAKE vocabulary into readable copy. */
export function humanizeToken(token: string | null | undefined): string {
  if (!token) return '';
  return token
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

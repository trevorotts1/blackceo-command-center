/**
 * P1-03 — Dashboard / cards intermittent-load fix.
 *
 * Proves the class-3 root cause is closed: a failed `/api/workspaces` fetch
 * used to be caught-and-swallowed, leaving the producer-board slot silently
 * empty — indistinguishable from "this box has no producer engines." That is
 * fail-EMPTY. The fix is fail-LOUD-but-graceful: on a fetch failure the
 * dashboard must render a single degraded sentinel slot instead of zero
 * cards, and must log a `dashboard_workspaces_fetch_failed` event.
 *
 * This suite exercises the pure decision logic extracted to
 * `src/lib/dashboard-workspaces.ts` (no React/DOM — this repo carries no
 * jsdom/testing-library harness, so page.tsx's branching was factored into a
 * plain module specifically so it is unit-testable).
 *
 * FAIL-FIRST PROOF: every test in the `selectProducerCardSlugs` block below
 * fails against the pre-fix tree, because `src/lib/dashboard-workspaces.ts`
 * did not exist before this change (the import throws MODULE_NOT_FOUND) —
 * confirmed by `git stash` + re-run during development (see build notes).
 * Node built-in test runner under tsx (`npm run test:unit`). No DB required —
 * pure logic, no I/O.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACES_RETRY_MS,
  parseWorkspaceSlugs,
  buildWorkspacesFetchFailedEvent,
  selectProducerCardSlugs,
} from '../../src/lib/dashboard-workspaces';

// ── selectProducerCardSlugs — the class-3 fix itself ────────────────────────

test('[P1-03] selectProducerCardSlugs: status="error" returns the degraded sentinel, NEVER an empty list', () => {
  const result = selectProducerCardSlugs('error', new Set(), [{ slug: 'anthology' }, { slug: 'podcast' }]);
  assert.deepEqual(result, { degraded: true });
});

test('[P1-03] selectProducerCardSlugs: status="error" returns the degraded sentinel even when presentSlugs is non-empty (stale data from a prior success must not paper over a NEW failure)', () => {
  const result = selectProducerCardSlugs('error', new Set(['anthology']), [{ slug: 'anthology' }, { slug: 'podcast' }]);
  assert.deepEqual(result, { degraded: true });
});

test('[P1-03] selectProducerCardSlugs: status="ok" with a matching slug present returns exactly that slug (real, non-degraded selection)', () => {
  const result = selectProducerCardSlugs('ok', new Set(['anthology']), [{ slug: 'anthology' }, { slug: 'podcast' }]);
  assert.deepEqual(result, { degraded: false, slugs: ['anthology'] });
});

test('[P1-03] selectProducerCardSlugs: status="ok" with NO matching slugs returns an empty (non-degraded) list — a box with genuinely no producer engines must show zero cards, not a degraded placeholder', () => {
  const result = selectProducerCardSlugs('ok', new Set(), [{ slug: 'anthology' }, { slug: 'podcast' }]);
  assert.deepEqual(result, { degraded: false, slugs: [] });
});

test('[P1-03] selectProducerCardSlugs: status="loading" behaves like "ok" (gates strictly on presentSlugs, not degraded) — the degraded state is reserved for a CONFIRMED failure, not the initial unresolved state', () => {
  const result = selectProducerCardSlugs('loading', new Set(), [{ slug: 'anthology' }]);
  assert.deepEqual(result, { degraded: false, slugs: [] });
});

test('[P1-03] selectProducerCardSlugs: only candidates whose slug is present are selected — unrelated candidates never leak through', () => {
  const result = selectProducerCardSlugs(
    'ok',
    new Set(['podcast']),
    [{ slug: 'anthology' }, { slug: 'podcast' }, { slug: 'some-future-engine' }],
  );
  assert.deepEqual(result, { degraded: false, slugs: ['podcast'] });
});

// ── parseWorkspaceSlugs — tolerant, never-throws parsing ────────────────────

test('[P1-03] parseWorkspaceSlugs: extracts + lowercases slugs from a well-formed array', () => {
  const slugs = parseWorkspaceSlugs([{ slug: 'Anthology' }, { slug: 'PODCAST' }]);
  assert.deepEqual([...slugs].sort(), ['anthology', 'podcast']);
});

test('[P1-03] parseWorkspaceSlugs: a non-array payload (e.g. an error object) yields an empty set, never throws', () => {
  assert.deepEqual(parseWorkspaceSlugs({ error: 'boom' }), new Set());
  assert.deepEqual(parseWorkspaceSlugs(null), new Set());
  assert.deepEqual(parseWorkspaceSlugs(undefined), new Set());
});

test('[P1-03] parseWorkspaceSlugs: entries with a missing or non-string slug are filtered out, not crashed on', () => {
  const slugs = parseWorkspaceSlugs([{}, { slug: 123 }, { slug: 'anthology' }, { notSlug: 'x' }]);
  assert.deepEqual([...slugs], ['anthology']);
});

// ── buildWorkspacesFetchFailedEvent — the durable failure record ────────────

test('[P1-03] buildWorkspacesFetchFailedEvent: emits the literal event type "dashboard_workspaces_fetch_failed"', () => {
  const event = buildWorkspacesFetchFailedEvent(1, 'HTTP 500');
  assert.equal(event.type, 'dashboard_workspaces_fetch_failed');
});

test('[P1-03] buildWorkspacesFetchFailedEvent: the message names the attempt number, the reason, and the retry interval — an operator reading the events feed must be able to diagnose without more digging', () => {
  const event = buildWorkspacesFetchFailedEvent(3, 'Failed to fetch');
  assert.match(event.message, /attempt 3/);
  assert.match(event.message, /Failed to fetch/);
  assert.match(event.message, new RegExp(`retrying in ${WORKSPACES_RETRY_MS / 1000}s`));
  assert.deepEqual(event.metadata, { attempt: 3, reason: 'Failed to fetch' });
});

test('[P1-03] WORKSPACES_RETRY_MS is 15 seconds, matching the spec\'s literal "15s retry"', () => {
  assert.equal(WORKSPACES_RETRY_MS, 15_000);
});

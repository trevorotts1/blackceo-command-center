/**
 * U77 / GK-15 — "Podcast dashboard transplant into the Command Center"
 * (engine-gated nav, Option C — the standing recommendation, adopted, not
 * reopened).
 *
 * Proves the AppShell sidebar's `/podcast` entry renders ONLY where the
 * Podcast Production Engine's workspace is present on this box, and NEVER
 * while that presence is still unknown (loading) or unconfirmable (a failed
 * /api/workspaces read) — same fail-closed posture as the home-page
 * producer-board card (P1-03), reusing its `WorkspacesStatus`/
 * `parseWorkspaceSlugs` types/helpers so there is exactly one "does this box
 * have this engine" signal, never two independently-drifting ones.
 *
 * This suite exercises the pure decision logic extracted to
 * `src/lib/nav-gating.ts` (no React/DOM — this repo carries no
 * jsdom/testing-library harness, matching the P1-03 convention). Node
 * built-in test runner under tsx (`npm run test:unit`). No DB, no network —
 * pure logic only.
 *
 * FAIL-FIRST PROOF: every test below fails against the pre-U77 tree, because
 * `src/lib/nav-gating.ts` did not exist before this change (the import
 * throws MODULE_NOT_FOUND) — confirmed during development via `git stash`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { insertEngineNavItem, shouldShowEngineNavItem } from '../../src/lib/nav-gating';

// ── shouldShowEngineNavItem — the engine-gated nav decision (BINARY acceptance d) ──

test('[U77] shouldShowEngineNavItem: status="ok" + slug present -> true (engine confirmed present)', () => {
  assert.equal(shouldShowEngineNavItem('ok', new Set(['podcast']), 'podcast'), true);
});

test('[U77] shouldShowEngineNavItem: status="ok" + slug absent -> false (a box genuinely without the engine renders no nav entry — BINARY acceptance (d), first half)', () => {
  assert.equal(shouldShowEngineNavItem('ok', new Set(), 'podcast'), false);
});

test('[U77] shouldShowEngineNavItem: status="ok" + a DIFFERENT slug present -> false (unrelated engines never leak the nav item on)', () => {
  assert.equal(shouldShowEngineNavItem('ok', new Set(['anthology']), 'podcast'), false);
});

test('[U77] shouldShowEngineNavItem: status="loading" -> false even with the slug already present from stale state (fails CLOSED while unresolved, never flashes on)', () => {
  assert.equal(shouldShowEngineNavItem('loading', new Set(['podcast']), 'podcast'), false);
});

test('[U77] shouldShowEngineNavItem: status="error" -> false even with the slug present from a prior successful read (a fetch failure must never leave a stale nav item visible)', () => {
  assert.equal(shouldShowEngineNavItem('error', new Set(['podcast']), 'podcast'), false);
});

// ── insertEngineNavItem — placement + referential stability ─────────────────

const BASE = [
  { href: '/', label: 'Home' },
  { href: '/ceo-board', label: 'CEO Board' },
  { href: '/workspace', label: 'Departments' },
  { href: '/settings', label: 'Settings' },
];

test('[U77] insertEngineNavItem: show=false returns the SAME array reference, unchanged (referential stability for memoization; no item inserted)', () => {
  const result = insertEngineNavItem(BASE, '/workspace', { href: '/podcast', label: 'Podcast' }, false);
  assert.equal(result, BASE);
  assert.deepEqual(result.map((i) => i.href), ['/', '/ceo-board', '/workspace', '/settings']);
});

test('[U77] insertEngineNavItem: show=true inserts immediately after the named anchor href, per the payload WIRING.md placement note ("after the Departments entry")', () => {
  const result = insertEngineNavItem(BASE, '/workspace', { href: '/podcast', label: 'Podcast' }, true);
  assert.deepEqual(result.map((i) => i.href), ['/', '/ceo-board', '/workspace', '/podcast', '/settings']);
});

test('[U77] insertEngineNavItem: show=true with a base list that no longer has the anchor href appends at the end instead of throwing (a future AppShell rename degrades gracefully)', () => {
  const result = insertEngineNavItem(
    [{ href: '/', label: 'Home' }, { href: '/settings', label: 'Settings' }],
    '/workspace-renamed-away',
    { href: '/podcast', label: 'Podcast' },
    true,
  );
  assert.deepEqual(result.map((i) => i.href), ['/', '/settings', '/podcast']);
});

test('[U77] insertEngineNavItem: does not mutate the original base array (returns a new array on insert)', () => {
  const before = BASE.map((i) => i.href);
  insertEngineNavItem(BASE, '/workspace', { href: '/podcast', label: 'Podcast' }, true);
  assert.deepEqual(BASE.map((i) => i.href), before);
});

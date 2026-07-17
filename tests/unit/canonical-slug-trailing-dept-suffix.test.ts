/**
 * Unit tests for `canonicalDeptSlug()`'s trailing "-dept" suffix gap
 * (src/lib/routing/canonical-slug.ts).
 *
 * BACKGROUND — this is a real, previously-disclosed, owed gap, not a
 * hypothetical. v6.0.46's CHANGELOG entry ("da-chips-fix") already states:
 *   "canonicalDeptSlug handles a leading dept- prefix but not a trailing
 *    -dept suffix, so five legacy fabricated ids would still render
 *    raw+gray... routed as an owed leg for whoever touches this next."
 * The five ids are the DEMO_RECOMMENDATIONS fingerprints migration 103
 * purges by exact (department_id, title) match: `marketing-dept`,
 * `sales-dept`, `operations-dept`, `creative-dept`, `support-dept`
 * (src/lib/db/migrations.ts, migration 103). Migration 024 also proves a
 * legacy `da_challenges` import PRESERVES a raw `department_id` like
 * `sales-dept` without ever canonicalizing it
 * (tests/unit/u59-da-challenges-round-trip.test.ts, "department_id carries
 * over"). And `src/app/api/departments/[id]/personas/route.ts` already
 * carries its OWN independent, duplicate `<id>-dept` strip
 * (`.replace(/-dept$/, '')`) specifically because canonicalDeptSlug does
 * not cover this shape — its own comment names it "legacy `<id>-dept`
 * suffixed folder... very old installs". On the operator's own box, the
 * live `~/.openclaw/agents/` runtime tree carries three dozen real
 * directories in exactly this shape (`dept-crm-dept`, `dept-legal-dept`,
 * `dept-appdev-dept`, `dept-marketing-dept`, etc.) — the leading `dept-`
 * auto-seed prefix plus a legacy trailing `-dept` suffix baked into the
 * underlying department name itself.
 *
 * `canonicalDeptSlug()` is called directly by
 * `src/components/ceo-board/DevilsAdvocateFeed.tsx` (line 280) on
 * `challenge.department_id`, and by dozens of routing/dispatch call sites
 * including `src/lib/task-dispatcher.ts` (the exact file PR #212 patches
 * for the alias-reverse-probe gap) — so a trailing-`-dept` id reaching any
 * of those call sites resolves to nothing today and silently degrades
 * (gray chip, unrouted dispatch probe) instead of resolving to its real
 * department.
 *
 * OVER-STRIPPING GUARD — the fix must be RECOGNITION-GATED, not a blind
 * suffix strip: it may only rewrite a trailing-`-dept` slug when the
 * stripped form is ALREADY a known alias or canonical slug. An arbitrary
 * custom id that merely ends in "-dept" and does NOT resolve to anything
 * known (e.g. a client's own `my-custom-dept` workspace, or the
 * intentionally-realistic `contest-dept` fixture in
 * tests/unit/c8-test-fixture-residue.test.ts asserting it is a "real
 * client dept") must come back completely UNCHANGED — this repo already
 * has an existing pinned contract test
 * (tests/unit/prd-2.9f-null-dept-slug.test.ts:117,
 * `canonicalDeptSlug('my-custom-dept') === 'my-custom-dept'`) that a blind
 * strip would break.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalDeptSlug } from '../../src/lib/routing/canonical-slug';

// ── 1. The exact sibling-reported repro case ──────────────────────────────
test('canonicalDeptSlug: trailing "-dept" resolves a bare canonical slug (sales-dept -> sales)', () => {
  assert.strictEqual(canonicalDeptSlug('sales-dept'), 'sales');
});

// ── 2. The five migration-103 fabricated demo ids (v6.0.46's owed leg) ────
test('canonicalDeptSlug: the five legacy fabricated demo-seed ids all resolve to a real department', () => {
  assert.strictEqual(canonicalDeptSlug('marketing-dept'), 'marketing');
  assert.strictEqual(canonicalDeptSlug('sales-dept'), 'sales');
  // 'operations' and 'creative' are legacy ALIAS_MAP passthrough entries
  // (no canonical equivalent yet) — the suffix must still be stripped so
  // the legacy alias form is reached, not left as raw "operations-dept".
  assert.strictEqual(canonicalDeptSlug('operations-dept'), 'operations');
  assert.strictEqual(canonicalDeptSlug('creative-dept'), 'creative');
  // 'support' DOES have a real canonical target.
  assert.strictEqual(canonicalDeptSlug('support-dept'), 'customer-support');
});

// ── 3. Real live directories on the operator's own ~/.openclaw/agents/ tree ─
test('canonicalDeptSlug: real ~/.openclaw/agents/ runtime-tree slugs (leading dept- AND trailing -dept) resolve', () => {
  // dept-crm-dept -> strip leading "dept-" -> "crm-dept" -> strip trailing
  // "-dept" -> "crm", which IS canonical.
  assert.strictEqual(canonicalDeptSlug('dept-crm-dept'), 'crm');
  assert.strictEqual(canonicalDeptSlug('dept-legal-dept'), 'legal');
  // dept-appdev-dept -> "appdev-dept" -> "appdev" -> ALIAS_MAP -> app-development.
  assert.strictEqual(canonicalDeptSlug('dept-appdev-dept'), 'app-development');
  assert.strictEqual(canonicalDeptSlug('dept-marketing-dept'), 'marketing');
});

// ── 4. Case/whitespace insensitivity carries through the new step ─────────
test('canonicalDeptSlug: trailing-"-dept" resolution is case- and whitespace-insensitive', () => {
  assert.strictEqual(canonicalDeptSlug('  SALES-DEPT  '), 'sales');
  assert.strictEqual(canonicalDeptSlug('Billing-Dept'), 'billing-finance');
});

// ── 5. OVER-STRIPPING GUARD: an unresolvable "-dept" id is NEVER mutated ──
test('canonicalDeptSlug: an unrecognized "-dept" id passes through completely UNCHANGED (no corruption)', () => {
  // This is the exact existing pinned contract
  // (tests/unit/prd-2.9f-null-dept-slug.test.ts) — re-asserted here as the
  // direct regression guard for this fix.
  assert.strictEqual(canonicalDeptSlug('my-custom-dept'), 'my-custom-dept');
  // The exact fixture DevilsAdvocateFeed's own test suite uses for "never
  // crashes, falls back to the raw id" (tests/unit/devils-advocate-feed-render.test.tsx).
  assert.strictEqual(canonicalDeptSlug('totally-made-up-dept'), 'totally-made-up-dept');
  // The exact fixture tests/unit/c10-sops-alias-filter.test.ts pins via
  // expandDeptSlugAliases (which calls canonicalDeptSlug internally).
  assert.strictEqual(canonicalDeptSlug('totally-unknown-dept'), 'totally-unknown-dept');
  // A deliberately realistic "looks like residue but isn't" real client
  // department name (mirrors tests/unit/c8-test-fixture-residue.test.ts's
  // own "contest-dept (real client dept)" fixture, chosen because it is a
  // near-miss for the "test-dept" residue pattern AND ends in "-dept").
  assert.strictEqual(canonicalDeptSlug('contest-dept'), 'contest-dept');
});

// ── 6. Already-canonical values are returned by Step 4, never touched by
//       the new suffix-strip step (no double-processing / no regression) ──
test('canonicalDeptSlug: already-canonical and already-aliased slugs are unaffected by the new step', () => {
  assert.strictEqual(canonicalDeptSlug('marketing'), 'marketing');
  assert.strictEqual(canonicalDeptSlug('dept-marketing'), 'marketing');
  assert.strictEqual(canonicalDeptSlug('ceo-com'), 'master-orchestrator');
  assert.strictEqual(canonicalDeptSlug('billing'), 'billing-finance');
  assert.strictEqual(canonicalDeptSlug(null), '');
  assert.strictEqual(canonicalDeptSlug(undefined), '');
});

// ── 7. A bare "-dept" (nothing before the suffix) never underflows / crashes ─
test('canonicalDeptSlug: a bare "-dept" or "dept" input never throws and never over-strips to empty', () => {
  assert.doesNotThrow(() => canonicalDeptSlug('-dept'));
  assert.doesNotThrow(() => canonicalDeptSlug('dept'));
  // '-dept' has length 5, so the `s.length > 5` guard must refuse to strip
  // it down to an empty string.
  assert.strictEqual(canonicalDeptSlug('-dept'), '-dept');
  assert.strictEqual(canonicalDeptSlug('dept'), 'dept');
});

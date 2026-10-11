/**
 * Unit test — the Daily Briefings alias pair in canonical-slug.ts.
 *
 * The board workspace row is slug `daily-briefings` (plural), while the live
 * runtime folder / openclaw.json agents.entries key is `daily-briefing-dept`
 * (singular, folder key "<name>-dept"). Before this fix ALIAS_MAP and
 * CANONICAL_SLUGS held no daily-briefing entry, so expandDeptSlugAliases
 * bridged neither spelling: guard-department-runtime-parity failed 1/63 and
 * Daily Briefings dispatch could not resolve its runtime.
 *
 * CONTRACT: two ALIAS_MAP entries so BOTH spellings canonicalize to the same
 * bare slug `daily-briefing`:
 *   'daily-briefings'     -> 'daily-briefing'   (board plural -> bare)
 *   'daily-briefing-dept' -> 'daily-briefing'   (folder-key base -> bare)
 * `daily-briefing` itself stays a Step-4/Step-6 passthrough.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalDeptSlug, expandDeptSlugAliases } from '../../src/lib/routing/canonical-slug';

test('board plural daily-briefings and runtime folder base daily-briefing-dept canonicalize to the SAME slug', () => {
  assert.strictEqual(canonicalDeptSlug('daily-briefings'), 'daily-briefing');
  assert.strictEqual(canonicalDeptSlug('daily-briefing-dept'), 'daily-briefing');
  // The dept- prefixed runtime id and the bare board plural agree too.
  assert.strictEqual(canonicalDeptSlug('dept-daily-briefings'), 'daily-briefing');
  assert.strictEqual(canonicalDeptSlug('dept-daily-briefing-dept'), 'daily-briefing');
  // The bare singular is already the canonical target: passthrough, unchanged.
  assert.strictEqual(canonicalDeptSlug('daily-briefing'), 'daily-briefing');
  // Both spellings agree.
  assert.strictEqual(
    canonicalDeptSlug('daily-briefings'),
    canonicalDeptSlug('daily-briefing-dept'),
  );
});

test('expandDeptSlugAliases bridges board slug to the live runtime folder spellings', () => {
  const set = new Set(expandDeptSlugAliases('daily-briefings'));
  // The live agents dir / openclaw.json entry on a box:
  assert.ok(set.has('dept-daily-briefing-dept'),
    'expand(daily-briefings) must include dept-daily-briefing-dept so the specialist-runtime probe finds the live dir');
  assert.ok(set.has('daily-briefing-dept'));
  assert.ok(set.has('daily-briefing'));
  assert.ok(set.has('dept-daily-briefing'));
  assert.ok(set.has('daily-briefings'));
});

test('reverse direction: expand(daily-briefing-dept) also covers the board slug', () => {
  const set = new Set(expandDeptSlugAliases('daily-briefing-dept'));
  assert.ok(set.has('daily-briefings'), 'expand of the runtime spelling must include the board plural');
  assert.ok(set.has('dept-daily-briefing-dept'));
});

// OVER-STRIP GUARD: the existing pinned contracts must stay intact.
test('existing pinned contract: unrecognized -dept ids are never mutated', () => {
  assert.strictEqual(canonicalDeptSlug('my-custom-dept'), 'my-custom-dept');
  assert.strictEqual(canonicalDeptSlug('totally-unknown-dept'), 'totally-unknown-dept');
  assert.strictEqual(canonicalDeptSlug('contest-dept'), 'contest-dept');
});

/**
 * PERS-02 — CATEGORY_KEYWORDS / inferTaskCategory golden-parity + tie-break lock.
 *
 * The persona selector (persona-selector-v2.py) keys the persona_assignment table
 * by the (department_id, task_category) pair, and the CC resolver derives that
 * same category with `inferTaskCategory` (a verbatim TS port of the Python
 * infer_task_category). Any drift between the two engines re-introduces the
 * RESOLVER-CATEGORY misroute (Gap E): an unpinned task inherits the WRONG
 * category's persona.
 *
 * This test locks the TS side against a fixed golden corpus — including explicit
 * TIE cases where two categories score equally and the pinned tie-break
 * (declaration order + strict `>`) must decide. Run the SAME corpus through the
 * onboarding Python engine (openclaw-onboarding/23-ai-workforce-blueprint/scripts/
 * infer-task-category.py) to close cross-repo parity; this file cannot import the
 * Python engine, so the cross-repo half is a follow-up for the integrator.
 *
 * Pure function (no DB) — inferTaskCategory only reads CATEGORY_KEYWORDS. Env is
 * still set defensively before the dynamic import so no lazy DB open touches the
 * real dashboard database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Defensive: point any lazy DB open at a throwaway path (inferTaskCategory does
// not touch the DB, but the resolver module imports @/lib/db).
process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pers02-')),
  'mission-control.test.db',
);

type ResolverModule = typeof import('../../src/lib/intelligence-resolver');
let inferTaskCategory: ResolverModule['inferTaskCategory'];
let CATEGORY_KEYWORDS: ResolverModule['CATEGORY_KEYWORDS'];

test.before(async () => {
  const mod = (await import('../../src/lib/intelligence-resolver')) as ResolverModule;
  inferTaskCategory = mod.inferTaskCategory;
  CATEGORY_KEYWORDS = mod.CATEGORY_KEYWORDS;
});

// ── GOLDEN CORPUS ────────────────────────────────────────────────────────────
// [input, expected category]. Keep this identical to the Python golden corpus.
const GOLDEN: Array<[string, string]> = [
  // Unambiguous single-category wins.
  ['Send a cold email newsletter to the client list', 'email-outreach'],
  ['Design a logo, visual layout and mockup', 'design'],
  ['Write a long-form blog article and essay', 'content-write'],
  ['Research, analyze and investigate the market', 'research'],
  ['Create a strategy roadmap and framework', 'strategy'],
  ['Refund the customer ticket complaint', 'customer-service'],
  ['Draft the contract and NDA terms', 'legal'],
  // No keyword hit → default.
  ['Ship the widget to the loading dock', 'general'],
  ['', 'general'],
];

// ── TIE CASES (the PERS-02 contract) ─────────────────────────────────────────
// Each input scores 1 in exactly two categories; the EARLIER-declared category
// must win (strict `>` never displaces an equal earlier best). 'story' lives in
// BOTH social-post (#2) and content-write (#3); 'post on' (social-post) ties
// 'blog' (content-write).
const TIES: Array<[string, string]> = [
  ['tell a story', 'social-post'],
  ['post on the blog', 'social-post'],
];

test('PERS-02: golden corpus resolves to the expected category', () => {
  for (const [input, expected] of GOLDEN) {
    assert.equal(
      inferTaskCategory(input),
      expected,
      `inferTaskCategory(${JSON.stringify(input)}) should be "${expected}"`,
    );
  }
});

test('PERS-02: score ties resolve to the earlier-declared category (pinned tie-break)', () => {
  for (const [input, expected] of TIES) {
    assert.equal(
      inferTaskCategory(input),
      expected,
      `tie input ${JSON.stringify(input)} must break to the earlier-declared "${expected}"`,
    );
  }
});

test('PERS-02: declaration order is stable (tie-break is order-dependent)', () => {
  // If a future edit reorders CATEGORY_KEYWORDS the TS/Python tie-break diverges.
  // Locking the exact key order here makes such a change fail loudly and forces a
  // matching reorder (and re-run) on the Python side.
  const expectedOrder = [
    'email-outreach',
    'social-post',
    'content-write',
    'video-script',
    'research',
    'strategy',
    'design',
    'ops',
    'finance',
    'legal',
    'hr',
    'customer-service',
    'coaching-prompt',
    'review-feedback',
  ];
  assert.deepEqual(
    Object.keys(CATEGORY_KEYWORDS),
    expectedOrder,
    'CATEGORY_KEYWORDS key order changed — update the Python dict + this lock together',
  );
});

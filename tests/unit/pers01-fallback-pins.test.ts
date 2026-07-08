/**
 * PERS-01 — TS fallback-pin constants must match the Python-side pins.
 *
 * resolvePersonaAndPin's terminal tier pins DEFAULT_PERSONA_FALLBACK (and the
 * dispatcher hands GOVERNANCE_PERSONA_FALLBACK to mechanical tasks). These must
 * match the pins in openclaw-onboarding/23-ai-workforce-blueprint/scripts/
 * persona-selector-v2.py (next to GEMINI_MODEL) AND must be real seeded catalog
 * slugs — pinning a slug that predates/omits the catalog leaves the doer unable
 * to load a blueprint (the P19 "unverifiable pin" hazard).
 *
 * This locks the TS values so an accidental edit is caught. Cross-repo parity vs
 * the live Python source cannot be checked from this repo — that half is an
 * integrator follow-up (PLAUSIBLE, needs the onboarding Python).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pers01-')),
  'mission-control.test.db',
);
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';

type SelectorModule = typeof import('../../src/lib/persona-selector');
type DispatchModule = typeof import('../../src/lib/persona-dispatch');

// The documented Python pins (persona-selector-v2.py). Keep in sync with Python.
const PYTHON_DEFAULT_PERSONA_FALLBACK = 'blackceo-house-voice';
const PYTHON_GOVERNANCE_PERSONA_FALLBACK = 'covey-7-habits';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let selector: SelectorModule;
let dispatch: DispatchModule;

test.before(async () => {
  selector = (await import('../../src/lib/persona-selector')) as SelectorModule;
  dispatch = (await import('../../src/lib/persona-dispatch')) as DispatchModule;
});

test('PERS-01: DEFAULT_PERSONA_FALLBACK matches the Python pin and is slug-shaped', () => {
  assert.equal(selector.DEFAULT_PERSONA_FALLBACK, PYTHON_DEFAULT_PERSONA_FALLBACK);
  assert.ok(SLUG_RE.test(selector.DEFAULT_PERSONA_FALLBACK), 'is a well-formed catalog slug');
});

test('PERS-01: GOVERNANCE_PERSONA_FALLBACK matches the Python pin and is slug-shaped', () => {
  assert.equal(selector.GOVERNANCE_PERSONA_FALLBACK, PYTHON_GOVERNANCE_PERSONA_FALLBACK);
  assert.ok(SLUG_RE.test(selector.GOVERNANCE_PERSONA_FALLBACK), 'is a well-formed catalog slug');
});

test('PERS-01: the persona-selector and persona-dispatch governance pins agree', () => {
  // Two independent copies of the governance fallback exist (selector + dispatch);
  // they must never drift.
  assert.equal(dispatch.GOVERNANCE_PERSONA_FALLBACK, selector.GOVERNANCE_PERSONA_FALLBACK);
});

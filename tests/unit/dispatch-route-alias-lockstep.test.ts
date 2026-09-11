/**
 * Lockstep regression — the THREE copies of resolveSpecialistSessionKey must
 * all probe canonical → legacy-alias runtime dirs.
 *
 * BUG (live client box, 2026-09-11):
 *   `src/lib/routing/executor-runtime.ts` and `src/lib/task-dispatcher.ts` were
 *   both fixed to probe every alias of a canonical slug
 *   (`expandDeptSlugAliases`), but `src/app/api/tasks/[id]/dispatch/route.ts`
 *   kept the OLD `canonicalSlug !== candidateSlug` guard, which skips the whole
 *   alias block whenever the workspace slug is ALREADY canonical.
 *
 *   The two paths therefore disagreed: auto-dispatch could reach a department
 *   that manual "Send to Agent" declared unreachable. On the affected box every
 *   Billing and Legal Compliance agent lived in a canonical workspace
 *   (`billing-finance`, `legal`) whose runtime dir is provisioned under the
 *   legacy alias (`dept-billing`, `dept-legal-compliance`), so this route
 *   refused them with no_specialist_runtime and their tasks were held as
 *   "routed but not dispatched" — surfaced to the owner by her own agent as
 *   "we're not wired up".
 *
 * tests/unit/dispatch-canonical-alias-reverse-probe.test.ts already proves the
 * BEHAVIOUR for task-dispatcher.ts. This file pins the remaining copies
 * statically so a future edit cannot silently re-introduce the drift.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..');

const COPIES = [
  'src/app/api/tasks/[id]/dispatch/route.ts',
  'src/lib/routing/executor-runtime.ts',
  'src/lib/task-dispatcher.ts',
];

/** Strip comments so prose ABOUT the retired guard never trips the check. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('every resolveSpecialistSessionKey copy probes canonical → alias runtimes', () => {
  for (const rel of COPIES) {
    const file = path.join(REPO, rel);
    if (!fs.existsSync(file)) continue; // copy retired — nothing to pin
    const raw = fs.readFileSync(file, 'utf8');
    const src = codeOnly(raw);
    // Only pin copies that IMPLEMENT the resolver. A module that merely imports
    // or re-exports it (task-dispatcher.ts delegates to executor-runtime.ts)
    // inherits the fixed behaviour and has nothing of its own to drift.
    const implementsIt =
      /function\s+resolveSpecialistSessionKey/.test(src) ||
      /(?:const|let)\s+resolveSpecialistSessionKey\s*[:=]/.test(src);
    if (!implementsIt) continue;

    assert.ok(
      src.includes('expandDeptSlugAliases'),
      `${rel}: resolveSpecialistSessionKey must probe every alias of the canonical ` +
        `slug via expandDeptSlugAliases, or a canonical workspace slug can never ` +
        `find a legacy-alias runtime dir (billing-finance -> dept-billing).`,
    );

    assert.ok(
      !/canonicalSlug\s*!==\s*candidateSlug/.test(src),
      `${rel}: the guard "canonicalSlug !== candidateSlug" skips alias probing ` +
        `whenever the slug is ALREADY canonical — exactly the case this bug is ` +
        `about. Probe every alias instead of short-circuiting.`,
    );
  }
});

test('expandDeptSlugAliases actually yields the legacy runtime spellings', async () => {
  const { expandDeptSlugAliases } = await import('../../src/lib/routing/canonical-slug');
  assert.ok(
    expandDeptSlugAliases('billing-finance').includes('dept-billing'),
    'billing-finance must expand to the dept-billing runtime spelling',
  );
  assert.ok(
    expandDeptSlugAliases('legal').includes('dept-legal-compliance'),
    'legal must expand to the dept-legal-compliance runtime spelling',
  );
});

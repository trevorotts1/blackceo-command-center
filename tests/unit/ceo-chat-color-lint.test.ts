/**
 * ceo-chat-color-lint.test.ts (U60 / JM-U63b)
 *
 * Proves the CI lint gate (`scripts/lint-ceo-chat-colors.ts` /
 * `scripts/lib/ceo-chat-color-scan.ts`) both (a) passes clean against the real
 * tree today and (b) actually FAILS when an indigo/purple/fuchsia utility
 * class is introduced — the "gate fails on introduction — proven once by
 * mutation" binary acceptance item. The mutation writes a throwaway file
 * under `src/components/ceo-chat/` and removes it in `finally`, so this test
 * never leaves the tree dirty even if an assertion fails midway.
 *
 * No DB — pure filesystem scan — so this needs no `_isolated-db` import.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { findViolations } from '../../scripts/lib/ceo-chat-color-scan';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MUTATION_FILE = path.join(REPO_ROOT, 'src/components/ceo-chat', '__lint-mutation-probe.tsx');

test('the real tree is clean — zero indigo/purple/fuchsia under the My AI CEO surface', () => {
  const violations = findViolations(REPO_ROOT);
  assert.deepEqual(
    violations,
    [],
    `Unexpected off-brand color violation(s): ${JSON.stringify(violations, null, 2)}`,
  );
});

test('mutation: introducing a banned color class flips the gate to FAIL, then clean again once removed', () => {
  assert.ok(!fs.existsSync(MUTATION_FILE), 'mutation probe file should not pre-exist');
  try {
    fs.writeFileSync(MUTATION_FILE, `export const probe = 'bg-indigo-500 text-purple-700';\n`, 'utf-8');
    const violations = findViolations(REPO_ROOT);
    assert.ok(violations.length > 0, 'gate must detect the injected violation');
    assert.ok(
      violations.some((v) => v.file.includes('__lint-mutation-probe.tsx')),
      'the detected violation must point at the mutated file',
    );
  } finally {
    fs.rmSync(MUTATION_FILE, { force: true });
  }

  // Clean again once the mutation is removed.
  const after = findViolations(REPO_ROOT);
  assert.deepEqual(after, []);
});

/**
 * cc-start-launcher-matrix.test.ts — maintained launcher acceptance gate.
 *
 * Runs the real scripts/cc-start.sh through the isolated seven-case matrix in
 * cc-start-launcher-matrix.fixture.sh. The fixture creates throwaway app trees,
 * stubs Node/next and port probes, proves launch state from a marker file, and
 * writes a dated JSON receipt for every case.
 *
 * This wrapper keeps the matrix in npm run test:unit, so CI executes the real
 * launcher contract rather than only inspecting its source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'cc-start-launcher-matrix.fixture.sh');

test('cc-start real-launcher matrix holds all seven build-state contracts', () => {
  const result = spawnSync('bash', [fixture], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `launcher matrix failed:\n${output}`);
  assert.match(output, /ALL PASS/);
});

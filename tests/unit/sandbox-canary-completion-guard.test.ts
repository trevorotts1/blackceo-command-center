import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSandboxCanaryTask } from '../../src/lib/task-lifecycle';

test('sandbox completion guard identifies only explicitly marked podcast canaries', () => {
  assert.equal(isSandboxCanaryTask({ source: 'podcast-engine', title: 'Episode (sandbox-canary)', description: '' }), true);
  assert.equal(isSandboxCanaryTask({ source: 'podcast-engine', title: 'Episode', description: 'ordinary podcast work' }), false);
  assert.equal(isSandboxCanaryTask({ source: 'other', title: 'Episode (sandbox-canary)', description: '' }), false);
});

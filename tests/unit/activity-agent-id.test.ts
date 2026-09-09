import test from 'node:test';
import assert from 'node:assert/strict';
import { CreateActivitySchema } from '../../src/lib/validation';

test('worker activities accept installed department IDs and legacy UUIDs', () => {
  for (const agent_id of ['dept-social-media', 'main', '3172aac2-092a-4681-bad9-c931c05213a4']) {
    assert.equal(CreateActivitySchema.safeParse({ activity_type: 'progress', message: 'Draft prepared', agent_id }).success, true);
  }
});
test('worker activities reject malformed IDs', () => {
  for (const agent_id of ['', '../foreign', 'agent with spaces', 'x'.repeat(201)]) {
    assert.equal(CreateActivitySchema.safeParse({ activity_type: 'progress', message: 'Draft prepared', agent_id }).success, false);
  }
});

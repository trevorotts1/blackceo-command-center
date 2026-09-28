import test from 'node:test';
import assert from 'node:assert/strict';
let calls = 0;
test.mock.module('@/lib/task-dispatcher', {
  namedExports: { autoDispatchTask: async () => { calls++; } },
});
test('probe namedExports', async () => {
  const mod = await import('@/lib/task-dispatcher');
  console.log('typeof named:', typeof mod.autoDispatchTask);
  await mod.autoDispatchTask('x', 'probe');
  console.log('calls:', calls);
  assert.equal(calls, 1);
});

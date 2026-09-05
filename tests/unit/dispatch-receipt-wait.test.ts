import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForDispatchReceipt } from '../helpers/wait-for-dispatch-receipt';

const receipt = { task_id: 'task-a', type: 'task_dispatched', metadata: JSON.stringify({ execution_id: 'execution-a' }) };

function clock() {
  let elapsed = 0;
  return { now: () => elapsed, sleep: async (ms: number) => { elapsed += ms; } };
}

test('waits for the exact execution audit after delayed runtime-model resolution', async () => {
  const time = clock();
  const result = await waitForDispatchReceipt({
    taskId: 'task-a', executionId: 'execution-a', timeoutMs: 1_000, ...time,
    readEvents: async () => time.now() >= 750 ? [receipt] : [],
    diagnostics: async () => ({ state: 'accepted' }),
  });
  assert.equal(result, receipt);
  assert.equal(time.now(), 800);
});

test('missing audit fails at its deadline despite accepted execution, with diagnostics', async () => {
  const time = clock();
  await assert.rejects(waitForDispatchReceipt({
    taskId: 'task-a', executionId: 'execution-a', timeoutMs: 250, ...time,
    readEvents: async () => [],
    diagnostics: async () => ({ state: 'accepted', runtimeModel: 'pending' }),
  }), /actual dispatch event: task=task-a execution=execution-a.*accepted.*pending/);
  assert.equal(time.now(), 250);
});

test('another task, old execution, acceptance event or malformed metadata cannot satisfy the wait', async () => {
  const time = clock();
  await assert.rejects(waitForDispatchReceipt({
    taskId: 'task-a', executionId: 'execution-a', timeoutMs: 100, ...time,
    readEvents: async () => [
      { ...receipt, task_id: 'task-b' },
      { ...receipt, metadata: JSON.stringify({ execution_id: 'old-execution' }) },
      { ...receipt, type: 'execution_accepted' },
      { ...receipt, metadata: '{broken' },
      { ...receipt, metadata: null },
    ],
    diagnostics: async () => ({ state: 'accepted' }),
  }), /Timeout waiting/);
});

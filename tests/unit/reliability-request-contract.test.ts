import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createTaskOnce, findTaskRequest, TASK_REQUEST_SCHEMA_SQL, taskRequestFingerprint, TaskRequestConflict } from '../../src/lib/task-request-identity';
import { checkedJson } from '../../src/lib/checked-json';
import { verifiedBuild, verifiedCommandCenter } from '../../src/lib/interview/build-verification';

const identity = { companyId: 'a', source: 'message', operationId: 'event-1', fingerprint: taskRequestFingerprint({ title: 'One' }) };
function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY); CREATE TABLE events(id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id));');
  db.exec(TASK_REQUEST_SCHEMA_SQL);
  return db;
}

test('failure inside initial event creation rolls back task, identity and dispatch intent', () => {
  const db = fixture();
  assert.throws(() => createTaskOnce(db, identity, 'task-a', 'now', () => {
    db.prepare('INSERT INTO tasks VALUES (?)').run('task-a');
    throw new Error('event write failed');
  }, true), /event write failed/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks').get() as {n:number}).n, 0);
  assert.equal(findTaskRequest(db, identity), null);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM task_dispatch_intents').get() as {n:number}).n, 0);
  db.close();
});

test('same operation ID remains separate across companies and payload conflicts refuse', () => {
  const db = fixture();
  for (const companyId of ['a', 'b']) createTaskOnce(db, { ...identity, companyId }, companyId, 'now', () => db.prepare('INSERT INTO tasks VALUES (?)').run(companyId), true);
  assert.equal(findTaskRequest(db, identity), 'a');
  assert.equal(findTaskRequest(db, { ...identity, companyId: 'b' }), 'b');
  assert.throws(() => findTaskRequest(db, { ...identity, fingerprint: 'changed' }), TaskRequestConflict);
  db.close();
});

test('legacy timestamp, missing checks and different build cannot certify completion', () => {
  assert.equal(verifiedBuild({ buildCompletedAt: 'yesterday' }), false);
  const state = { buildId: 'new', completionVerification: {version:1, status:'verified',buildId:'old',unmetRequirements:[]} };
  assert.equal(verifiedBuild(state), false);
  state.completionVerification.buildId = 'new';
  assert.equal(verifiedBuild(state), true);
  assert.equal(verifiedBuild({ ...state, completionVerification: { ...state.completionVerification, unmetRequirements:['libraries'] } }), false);
});

test('HTTP failures reject before a success-shaped response body can clear an error', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401,403,500]) {
      globalThis.fetch = async () => new Response('[]', { status });
      await assert.rejects(checkedJson('/api/tasks'), status < 500 ? /Access could not be verified/ : /HTTP 500/);
    }
    globalThis.fetch = async () => Response.json([{ id:'recovered' }]);
    assert.deepEqual(await checkedJson('/api/tasks'), [{ id:'recovered' }]);
  } finally { globalThis.fetch = original; }
});

test('a hanging fetch is aborted at the request deadline', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {once:true});
    });
    await assert.rejects(checkedJson('/api/tasks', undefined, 5), /timed out/);
  } finally { globalThis.fetch = original; }
});

test('a verified workforce cannot claim a ready board with missing or degraded installation phases', () => {
  const state:Record<string,unknown> = {commandCenterStatus:'done'};
  assert.equal(verifiedCommandCenter(state),false);
  for(const key of ['commandCenterBuildFresh','commandCenterWorkspacesSeeded','commandCenterDepartmentsSynced','commandCenterMdContentSynced','commandCenterDashboardContentSeeded','commandCenterDeptRuntimeParity','commandCenterTenantReady']) state[key]=true;
  assert.equal(verifiedCommandCenter(state),true);
  assert.equal(verifiedCommandCenter({...state,commandCenterStatus:'done-degraded'}),false);
  assert.equal(verifiedCommandCenter({...state,commandCenterTenantReady:false}),false);
});

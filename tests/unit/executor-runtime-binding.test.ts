import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../../src/lib/types';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cc-runtime-binding-'));
process.env.OPENCLAW_ROOT=root;
process.env.CC_TEST_FIXTURE_ROOT=root;
let run: typeof import('../../src/lib/db')['run'];
let queryOne: typeof import('../../src/lib/db')['queryOne'];
let closeDb: typeof import('../../src/lib/db')['closeDb'];
let resolveSpecialistSessionKey: typeof import('../../src/lib/routing/executor-runtime')['resolveSpecialistSessionKey'];
test.before(async()=>{
 ({run,queryOne,closeDb}=await import('../../src/lib/db'));
 ({resolveSpecialistSessionKey}=await import('../../src/lib/routing/executor-runtime'));
run("INSERT INTO companies(id,name,slug) VALUES('binding-company','Binding','binding-company')");
run("INSERT INTO workspaces(id,name,slug,company_id) VALUES('binding-workspace','Master Orchestrator','master-orchestrator','binding-company')");
run("INSERT INTO agents(id,name,role,is_master,status,workspace_id,openclaw_agent_id) VALUES('binding-worker','main','CEO',1,'standby','binding-workspace','main')");
fs.mkdirSync(path.join(root,'agents','main'),{recursive:true});
});
const config=path.join(root,'openclaw.json');
function resolve(allow=true,workspace='binding-workspace') {
  return resolveSpecialistSessionKey(queryOne<Agent>('SELECT * FROM agents WHERE id=?',['binding-worker'])!,'execution-unique',workspace,'binding-test',allow);
}
test.after(()=>{closeDb();fs.rmSync(root,{recursive:true,force:true});});
test('explicit registered main binding requires catch-all execution authorization',()=>{
 fs.writeFileSync(config,JSON.stringify({agents:{list:[{id:'main'}]}}));
 assert.equal(resolve(false),null);
 assert.equal(resolve(),'agent:main:execution-unique');
});
test('unregistered runtime and mismatched workspace cannot resolve main',()=>{
 fs.writeFileSync(config,JSON.stringify({agents:{list:[]}}));
 assert.equal(resolve(),null);
 fs.writeFileSync(config,JSON.stringify({agents:{list:[{id:'main'}]}}));
 assert.equal(resolve(true,'foreign-workspace'),null);
});
test('main display name never substitutes for explicit runtime binding',()=>{
 run("UPDATE agents SET openclaw_agent_id=NULL WHERE id='binding-worker'");
 assert.equal(resolve(),null);
 run("UPDATE agents SET openclaw_agent_id='main' WHERE id='binding-worker'");
});
test('path traversal in a stored runtime binding is refused',()=>{
 run("UPDATE agents SET openclaw_agent_id='../main' WHERE id='binding-worker'");
 assert.equal(resolve(),null);
});

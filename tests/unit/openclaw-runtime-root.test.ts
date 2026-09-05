import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-root-proof-'));
process.env.DATABASE_PATH=path.join(root,'fixture.db');
process.env.CC_TEST_FIXTURE_ROOT=root;
process.env.OPENCLAW_ROOT=path.join(root,'runtime');
process.env.OPENCLAW_GATEWAY_URL='not-a-valid-url';
let db:typeof import('../../src/lib/db');
let qc:typeof import('../../src/lib/qc-scorer');
let dispatch:typeof import('../../src/lib/task-dispatcher');
let model:typeof import('../../src/lib/runtime-model');
test.before(async()=>{
 db=await import('../../src/lib/db');qc=await import('../../src/lib/qc-scorer');dispatch=await import('../../src/lib/task-dispatcher');model=await import('../../src/lib/runtime-model');db.getDb();
 db.run("INSERT INTO workspaces(id,name,slug) VALUES('root-ws','Root fixture','root-fixture')");
 db.run("INSERT INTO agents(id,name,role,workspace_id) VALUES('root-agent','Root Agent','fixture','root-ws')");
 db.run("INSERT INTO tasks(id,title,workspace_id,assigned_agent_id) VALUES('root-task','Generate image','root-ws','root-agent')");
 db.run("INSERT INTO openclaw_sessions(id,task_id,agent_id,openclaw_session_id) VALUES('root-session','root-task','root-agent','root-execution')");
 const sessions=path.join(process.env.OPENCLAW_ROOT!,'agents','root-agent','sessions');fs.mkdirSync(sessions,{recursive:true});
 fs.mkdirSync(path.join(process.env.OPENCLAW_ROOT!,'agents','dept-root-fixture'),{recursive:true});
 fs.writeFileSync(path.join(sessions,'root-execution.jsonl'),JSON.stringify({type:'tool_use',name:'bash',input:{command:'python3 scripts/kie_generate.py # api.kie.ai'}}));
 fs.writeFileSync(path.join(process.env.OPENCLAW_ROOT!,'openclaw.json'),JSON.stringify({agents:{list:[{id:'fixture',model:{primary:'fixture/model'}}]}}));
});
test.after(()=>{db.closeDb();fs.rmSync(root,{recursive:true,force:true});});
test('configured runtime drives dispatch, QC trace and runtime model config',()=>{
 const agent=db.queryOne<any>('SELECT * FROM agents WHERE id=?',['root-agent'])!;
 assert.equal(dispatch.resolveSpecialistSessionKey(agent,'root-execution','root-ws','fixture'),'agent:dept-root-fixture:root-execution');
 const result=qc.runAFI14Guardrail('root-task','root-agent','graphics',true);assert.equal(result.traceFound,true);assert.equal(result.violated,false);
 assert.equal(model.readOpenClawConfig()!.agents!.list![0].model!.primary,'fixture/model');
});
test('invalid explicit runtime never falls back to installed runtimes, traces or config',()=>{
 const original=process.env.OPENCLAW_ROOT;const agent=db.queryOne<any>('SELECT * FROM agents WHERE id=?',['root-agent'])!;
 try {for(const invalid of ['', 'relative/runtime']){
 process.env.OPENCLAW_ROOT=invalid;
 assert.equal(dispatch.resolveSpecialistSessionKey(agent,'root-execution','root-ws','fixture'),null);
 const result=qc.runAFI14Guardrail('root-task','root-agent','graphics',true);assert.equal(result.traceFound,false);assert.equal(result.violated,true);
 assert.equal(model.readOpenClawConfig(),null);
 }}finally{process.env.OPENCLAW_ROOT=original;}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'persona-decision-'));
process.env.CC_TEST_FIXTURE_ROOT=temp;
process.env.DATABASE_PATH=path.join(temp,'test.db');
process.env.WORKSPACE_BASE_PATH=temp;
process.env.OPENCLAW_COMPANY_ROOT=temp;
process.env.DISABLE_QC_AUTO_SCORER='true';
process.env.OPENCLAW_GATEWAY_URL='not-a-valid-url';
process.env.PERSONA_FIXTURE_JSON='{}';
let db:typeof import('../../src/lib/db');
let tasks:typeof import('../../src/lib/tasks');
let selectors:typeof import('../../src/lib/persona-selector');
let state:typeof import('../../src/lib/persona-state');
test.before(async()=>{db=await import('../../src/lib/db');db.getDb();db.run("INSERT OR IGNORE INTO workspaces(id,name,slug) VALUES('persona-ws','Persona Workspace','persona-ws')");tasks=await import('../../src/lib/tasks');selectors=await import('../../src/lib/persona-selector');state=await import('../../src/lib/persona-state');});
test.after(()=>{db.closeDb();fs.rmSync(temp,{recursive:true,force:true});});
let index=0;
function task(){const id=`persona-test-${++index}`;db.run("INSERT INTO tasks(id,title,status,department,workspace_id) VALUES(?,'Write email','backlog','marketing',NULL)",[id]);return id;}
function bundle(voice='voice-one',audience='Audience A'){return {confirm_required:true,voice:{audience_persona:{id:voice,why:'voice'},topic_persona:{id:'topic-one',why:'topic'},collapsed:false},resolved_audience:{label:audience,candidates:[audience],source:'asked',confidence:.9},blend_directive:`Use ${voice} voice with topic-one expertise.`,task_personas:[],catalog_version:'test-v1'} as any;}
test('real fixture parser to pin to renderer preserves hybrid secondary and clears it on single replacement',async()=>{const id=task();process.env.PERSONA_FIXTURE_JSON=JSON.stringify({persona_id:'leader-one',persona_name:'Leader One',interaction_mode:'hybrid',secondary_persona_id:'coach-one',secondary_persona_name:'Coach One',secondary_persona_score:.9});await tasks.resolvePersonaAndPin(id,'Lead a team and coach','marketing');const row=db.queryOne<any>('SELECT * FROM tasks WHERE id=?',[id]);assert.equal(row.secondary_persona_id,'coach-one');const renderer=await import('../../src/lib/persona-dispatch');assert.match(renderer.buildPersonaBlock(row,{persona:'auto',personaSource:'hardcoded_default'}),/coach-one/);process.env.PERSONA_FIXTURE_JSON=JSON.stringify({persona_id:'single-one',persona_name:'Single One'});await tasks.resolvePersonaAndPin(id,'Single operation','marketing');assert.equal(db.queryOne<any>('SELECT secondary_persona_id FROM tasks WHERE id=?',[id])!.secondary_persona_id,null);});
test('deferred selector cannot overwrite a later operator decision and department',async()=>{const id=task();process.env.PERSONA_FIXTURE_JSON=JSON.stringify({persona_id:'stale-one',persona_name:'Stale One'});const pending=tasks.resolvePersonaAndPin(id,'Old Marketing brief','marketing');db.run("UPDATE tasks SET persona_id='operator-one',department='engineering' WHERE id=?",[id]);assert.equal(await pending,null);assert.equal(db.queryOne<any>('SELECT persona_id FROM tasks WHERE id=?',[id])!.persona_id,'operator-one');});
test('bundle and mirrors rollback together when second write fails',()=>{const id=task();selectors.persistPersonaBundle(id,bundle());db.run(`CREATE TRIGGER fail_persona_mirror BEFORE UPDATE OF voice_persona_id ON tasks WHEN NEW.id='${id}' BEGIN SELECT RAISE(ABORT,'injected mirror failure'); END`);assert.throws(()=>selectors.persistPersonaBundle(id,bundle('voice-two')),/injected mirror failure/);db.run('DROP TRIGGER fail_persona_mirror');assert.equal(JSON.parse(db.queryOne<any>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?',[id])!.bundle_json).voice.audience_persona.id,'voice-one');assert.equal(db.queryOne<any>('SELECT voice_persona_id FROM tasks WHERE id=?',[id])!.voice_persona_id,'voice-one');});
test('same audience preserves confirmation; changed audience starts a new pending deadline',()=>{const id=task();selectors.persistPersonaBundle(id,bundle());db.run("UPDATE task_persona_bundle SET confirm_state='confirmed',created_at='2000-01-01' WHERE task_id=?",[id]);selectors.persistPersonaBundle(id,bundle('voice-two'));assert.equal(db.queryOne<any>('SELECT confirm_state FROM task_persona_bundle WHERE task_id=?',[id])!.confirm_state,'confirmed');selectors.persistPersonaBundle(id,bundle('voice-two','Audience B'));const row=db.queryOne<any>('SELECT confirm_state,created_at FROM task_persona_bundle WHERE task_id=?',[id])!;assert.equal(row.confirm_state,'pending');assert.notEqual(row.created_at,'2000-01-01');});
test('producer IDs alone remain unverified; complete hash-matched bundle retains decision',()=>{const id=task();tasks.pinProducerPersonaBundle(id,{voice_persona_id:'voice-one'});assert.equal(tasks.checkPersonaDispatchReady(id).ready,false);const full=bundle();full.confirm_required=false;tasks.pinProducerPersonaBundle(id,{voice_persona_id:'voice-one',persona_bundle:full,bundle_sha:state.personaBundleHash(full)});assert.equal(JSON.parse(db.queryOne<any>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?',[id])!.bundle_json).voice.topic_persona.id,'topic-one');assert.throws(()=>tasks.pinProducerPersonaBundle(id,{voice_persona_id:'voice-one',persona_bundle:full,bundle_sha:'wrong'}),/producer_persona_bundle_invalid/);});
test('operator voice lock atomically refreshes bundle while preserving audience and topic',()=>{
 const id=task();const full=bundle();full.confirm_required=false;selectors.persistPersonaBundle(id,full);
 db.run("UPDATE tasks SET persona_id='voice-one',workspace_id='persona-ws' WHERE id=?",[id]);
 db.run("INSERT INTO agent_settings(id,department_id,role_id,setting_type,value) VALUES('test-voice-lock','persona-ws',NULL,'persona','locked-voice')");
 try {tasks.applyPersonaOperatorLock(id);const row=db.queryOne<any>('SELECT * FROM tasks WHERE id=?',[id])!;
 assert.equal(row.persona_id,'locked-voice');assert.equal(row.voice_persona_id,'locked-voice');assert.equal(row.topic_persona_id,'topic-one');
 assert.match(row.blend_directive,/explicit operator lock/);assert.equal(tasks.checkPersonaDispatchReady(id).ready,true);
 } finally {db.run("DELETE FROM agent_settings WHERE id='test-voice-lock'");}
});
test('current execution requires whole persona manifest, scope evidence and unchanged local artifact',async()=>{
 const {randomUUID,createHash}=await import('node:crypto');const attempts=await import('../../src/lib/execution-attempts');const conformance=await import('../../src/lib/persona-conformance');
 const id=task(),agent=randomUUID();db.run("INSERT INTO agents(id,name,role,workspace_id) VALUES(?,'Evidence Worker','builder','persona-ws')",[agent]);
 db.run("UPDATE tasks SET assigned_agent_id=?,workspace_id='persona-ws',status='assigned',persona_contract_version=1 WHERE id=?",[agent,id]);
 const full=bundle();full.confirm_required=false;selectors.persistPersonaBundle(id,full);
 const execution=attempts.reserveExecution(db.queryOne<any>('SELECT * FROM tasks WHERE id=?',[id])!,'agent:evidence:session',randomUUID()).execution!;assert.ok(execution);attempts.beginExecutionSend(execution);
 const artifact=path.join(temp,'conformance.txt');fs.writeFileSync(artifact,'Actual delivered content');const delivery=randomUUID();db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title,path) VALUES(?,?,'file','Evidence',?)",[delivery,id,artifact]);
 assert.equal(conformance.requirePersonaConformanceForCompletion(id).reason,'persona_conformance_not_reported');
 const stored=JSON.parse(db.queryOne<any>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?',[id])!.bundle_json);
 const report={kind:'persona_used',execution_id:execution.id,...conformance.expectedPersonaManifest(stored),conformance_passed:true,artifacts:[{deliverable_id:delivery,sha256:createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')}]};
 const aid=randomUUID();db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,metadata) VALUES(?,?,?,'completed','Persona evidence',?)",[aid,id,agent,JSON.stringify(report)]);
 assert.equal(conformance.requirePersonaConformanceForCompletion(id).pass,true);
 db.run('UPDATE task_activities SET metadata=? WHERE id=?',[JSON.stringify({...report,topic_persona_id:'wrong-topic'}),aid]);assert.equal(conformance.requirePersonaConformanceForCompletion(id).reason,'persona_topic_mismatch');
 db.run('UPDATE task_activities SET metadata=? WHERE id=?',[JSON.stringify(report),aid]);fs.appendFileSync(artifact,' Changed after report');assert.equal(conformance.requirePersonaConformanceForCompletion(id).reason,'persona_artifact_revision_changed');
 fs.writeFileSync(artifact,'Actual delivered content');selectors.persistPersonaBundleScope(id,'landing',full);
 assert.equal(conformance.requirePersonaConformanceForCompletion(id).reason,'persona_scope_conformance_missing');
 const scoped=JSON.parse(db.queryOne<any>('SELECT bundle_json FROM task_persona_bundle_scope WHERE task_id=?',[id])!.bundle_json);
 db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,metadata) VALUES(?,?,?,'completed','Scope evidence',?)",[randomUUID(),id,agent,JSON.stringify({...report,...conformance.expectedPersonaManifest(scoped),scope:'landing'})]);assert.equal(conformance.requirePersonaConformanceForCompletion(id).pass,true);
 const mismatch=await import('../../src/lib/persona-mismatch');mismatch.recordPersonaUsedAndCompare(id,{...report,topic_persona_id:'wrong-topic'});assert.ok(mismatch.getOpenPersonaMismatch(id));mismatch.recordPersonaUsedAndCompare(id,report);assert.equal(mismatch.getOpenPersonaMismatch(id),null);
 db.run("UPDATE tasks SET persona_input_revision=persona_input_revision+1 WHERE id=?",[id]);assert.equal(conformance.requirePersonaConformanceForCompletion(id).reason,'persona_input_changed');
});
test('prepared prompt snapshot loses ownership if an operator installs another ready bundle',async()=>{
 const {randomUUID}=await import('node:crypto');const attempts=await import('../../src/lib/execution-attempts');const id=task(),agent=randomUUID();
 db.run("INSERT INTO agents(id,name,role,workspace_id) VALUES(?,'Race Worker','builder','persona-ws')",[agent]);db.run("UPDATE tasks SET status='assigned',assigned_agent_id=?,workspace_id='persona-ws' WHERE id=?",[agent,id]);
 const full=bundle();full.confirm_required=false;selectors.persistPersonaBundle(id,full);
 const old=db.queryOne<any>('SELECT * FROM tasks WHERE id=?',[id])!;const snapshot=state.capturePersonaSnapshot(id);
 await Promise.resolve();selectors.persistPersonaBundle(id,{...full,voice:{...full.voice,audience_persona:{id:'changed-voice',why:'operator update'}}});
 assert.equal(tasks.checkPersonaDispatchReady(id).ready,true);
 const claim=attempts.reserveExecution({...old,persona_snapshot:snapshot},'agent:race:session',randomUUID());assert.equal(claim.reason,'dispatch_prompt_context_changed');assert.equal(attempts.latestExecution(id),undefined);
});
test('PATCH and unique-session webhook complete only their exact attempt and preserve busy worker on duplicate',async()=>{
 process.env.DISABLE_QC_AUTO_SCORER='true';process.env.WEBHOOK_SECRET='fixture-webhook-secret';
 const {randomUUID,createHmac}=await import('node:crypto');const attempts=await import('../../src/lib/execution-attempts');const patch=await import('../../src/app/api/tasks/[id]/route');const webhook=await import('../../src/app/api/webhooks/agent-completion/route');
 const agent=randomUUID();db.run("INSERT INTO agents(id,name,role,workspace_id,status) VALUES(?,'Callback Worker','builder','persona-ws','working')",[agent]);
 const make=()=>{const id=task();db.run("UPDATE tasks SET title='Verify dataset',status='assigned',assigned_agent_id=?,workspace_id='persona-ws' WHERE id=?",[agent,id]);const e=attempts.reserveExecution(db.queryOne<any>('SELECT * FROM tasks WHERE id=?',[id])!,`agent:callback:${id}`,randomUUID()).execution!;assert.ok(e);attempts.beginExecutionSend(e);const artifact=path.join(temp,`${id}.txt`);fs.writeFileSync(artifact,'Delivered output');db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title,path) VALUES(?,?,'file','Output',?)",[randomUUID(),id,artifact]);return {id,e};};
 const one=make();const patchRequest=(body:unknown)=>new Request(`http://localhost/api/tasks/${one.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)}) as any;
 assert.equal((await patch.PATCH(patchRequest({status:'review',execution_id:randomUUID()}),{params:Promise.resolve({id:one.id})})).status,409);
 assert.equal((await patch.PATCH(patchRequest({status:'review',execution_id:one.e.id}),{params:Promise.resolve({id:one.id})})).status,200);assert.equal(attempts.latestExecution(one.id)!.state,'succeeded');
 const two=make();const send=async(body:unknown)=>{const raw=JSON.stringify(body);return webhook.POST(new Request('http://localhost/api/webhooks/agent-completion',{method:'POST',body:raw,headers:{'x-webhook-signature':createHmac('sha256','fixture-webhook-secret').update(raw).digest('hex')}}) as any);};
 assert.equal((await send({task_id:two.id,execution_id:one.e.id,summary:'stale'})).status,409);
 db.run('DELETE FROM openclaw_sessions WHERE task_id=?',[two.id]);assert.equal((await send({session_id:two.e.session_id,message:'TASK_COMPLETE: Delivered'})).status,200);assert.equal(attempts.latestExecution(two.id)!.state,'succeeded');
 const three=make();db.run("UPDATE agents SET status='working' WHERE id=?",[agent]);assert.equal((await send({task_id:two.id,execution_id:two.e.id,summary:'duplicate'})).status,200);assert.equal(db.queryOne<any>('SELECT status FROM agents WHERE id=?',[agent])!.status,'working');assert.equal(attempts.latestExecution(three.id)!.state,'sending');
 db.run("UPDATE tasks SET department='other',assignment_version=assignment_version+1 WHERE id=?",[two.id]);assert.equal((await send({task_id:two.id,execution_id:two.e.id,summary:'superseded'})).status,409);
});
test('mapped canonical object catalog validates company identity, unknown IDs and explicit operator locks',async()=>{
 const company='persona-company',root=path.join(temp,'scoped-company');fs.mkdirSync(root);const config=path.join(root,'company-config.json'),catalog=path.join(root,'persona-categories.json');
 fs.writeFileSync(config,JSON.stringify({companyId:company,companySlug:'scoped-company'}));fs.writeFileSync(catalog,JSON.stringify({version:'test-v1',personas:{'voice-one':{},'topic-one':{},'locked-voice':{}}}));
 const previousMap=process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON,previousFixture=process.env.PERSONA_FIXTURE_JSON;
 process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON=JSON.stringify({[company]:{companyRoot:root,companyConfig:config,companySlug:'scoped-company',personaCatalog:catalog}});
 try {
  tasks.validateProducerPersonaBundle({voice_persona_id:'voice-one'},company);assert.throws(()=>tasks.validateProducerPersonaBundle({voice_persona_id:'not-in-catalog'},company),/catalog_mismatch/);
  const full=bundle();full.company_id=company;full.confirm_required=false;
  assert.throws(()=>tasks.validateProducerPersonaBundle({voice_persona_id:'voice-one',persona_bundle:full,bundle_sha:state.personaBundleHash(full)},company),/confirmation_missing/);
  full.confirmation={actor_id:'verified-producer',confirmed_at:new Date().toISOString(),audience_hash:state.personaBundleHash(full.resolved_audience)};
  tasks.validateProducerPersonaBundle({voice_persona_id:'voice-one',persona_bundle:full,bundle_sha:state.personaBundleHash(full)},company);
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)',[company,'Persona Company','scoped-company']);db.run("INSERT INTO workspaces(id,name,slug,company_id) VALUES('scoped-ws','Scoped','scoped-ws',?)",[company]);const id=task();db.run("UPDATE tasks SET workspace_id='scoped-ws',persona_id='voice-one' WHERE id=?",[id]);selectors.persistPersonaBundle(id,full);db.run("INSERT INTO agent_settings(id,department_id,setting_type,value) VALUES('scoped-lock','scoped-ws','persona','locked-voice')");delete process.env.PERSONA_FIXTURE_JSON;
  tasks.applyPersonaOperatorLock(id);assert.equal(db.queryOne<any>('SELECT voice_persona_id FROM tasks WHERE id=?',[id])!.voice_persona_id,'locked-voice');
  const {personaCompanyContext}=await import('../../src/lib/persona-company');fs.writeFileSync(config,JSON.stringify({companyId:'another-company'}));assert.throws(()=>personaCompanyContext(company),/config_mismatch/);
 } finally {if(previousMap===undefined)delete process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON;else process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON=previousMap;if(previousFixture===undefined)delete process.env.PERSONA_FIXTURE_JSON;else process.env.PERSONA_FIXTURE_JSON=previousFixture;}
});

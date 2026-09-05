import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb, queryOne, run } from '../../src/lib/db';
import { resolveTenantContext, signTenantGrant, verifyTenantGrant } from '../../src/lib/auth/tenant-context';
import { queueInterviewOperation, tenantAnswers, ensureTenantInterview } from '../../src/lib/interview/remote-store';
import { verifyRemoteBody, signRemoteBody, deliverInterviewOperation } from '../../src/lib/interview/remote-protocol';
import { routeTaskDecision, comDispatch, type AgentWithLoad } from '../../src/lib/routing/department-router';
import { checkSweepLiveness, WATCHED_JOB_CADENCE_MINUTES } from '../../src/lib/jobs/sweep-liveness';
import { runIntakeAdvanceSweep } from '../../src/lib/jobs/intake-advance-sweep';

process.env.MC_API_TOKEN='fixture-api-token';
process.env.MC_INTERVIEW_COOKIE_SECRET='fixture-cookie-key';
process.env.MC_INTERVIEW_SECRET='fixture-encryption-key';
process.env.OPENCLAW_WORKSPACE_ROOT=process.env.CC_TEST_FIXTURE_ROOT;
process.env.OPENCLAW_SKILL23_SCRIPTS=path.join(process.env.CC_TEST_FIXTURE_ROOT!,'absent-scripts');
delete process.env.OPENAI_API_KEY; delete process.env.GOOGLE_API_KEY;
const registry={
 'a.example':{tenantId:'tenant-a',companyId:'company-a',kind:'client',clientId:'client-a',installationId:'install-a'},
 'b.example':{tenantId:'tenant-b',companyId:'company-b',kind:'client',clientId:'client-b',installationId:'install-b'},
 'self.example':{tenantId:'operator',companyId:'company-self',kind:'self',installationId:'install-self'},
};
process.env.MC_TENANT_REGISTRY_JSON=JSON.stringify(registry);
function req(host:string,url='/api/interview/state',headers:Record<string,string>={}){return new NextRequest(`https://${host}${url}`,{headers:{host,...headers}});}
async function context(host='a.example'){return resolveTenantContext(req(host,'/api/interview/state',{authorization:'Bearer fixture-api-token'}));}
getDb();
for(const id of ['company-a','company-b','company-self'])run('INSERT OR IGNORE INTO companies(id,name,slug) VALUES(?,?,?)',[id,id,id]);
for(const id of ['client-a','client-b'])run('INSERT OR IGNORE INTO clients(id,name,is_self) VALUES(?,?,0)',[id,id]);

 test('tenant auth rejects unknown hosts and unsigned edge assertions',async()=>{
  await assert.rejects(resolveTenantContext(req('unknown.example','/api/interview/state',{authorization:'Bearer fixture-api-token'})));
  await assert.rejects(resolveTenantContext(req('a.example','/api/interview/state',{'cf-access-jwt-assertion':'NOT_A_JWT','cf-ray':'invented','cf-access-authenticated-user-email':'owner@example.test'})));
 });
 test('signed browser grant binds tenant, host, installation, purpose and expiry',async()=>{
  const token=await signTenantGrant({purpose:'session',tenantId:'tenant-a',subject:'owner:a',host:'a.example',installationId:'install-a',exp:Date.now()/1000+60,nonce:randomUUID()});
  assert.equal((await resolveTenantContext(req('a.example','/api/interview/state',{cookie:`mc_tenant_session=${token}`}))).tenantId,'tenant-a');
  await assert.rejects(resolveTenantContext(req('b.example','/api/interview/state',{cookie:`mc_tenant_session=${token}`})));
  assert.equal(await verifyTenantGrant(token,'a.example','enrollment'),null);
  const expired=await signTenantGrant({purpose:'session',tenantId:'tenant-a',subject:'owner:a',host:'a.example',installationId:'install-a',exp:1,nonce:randomUUID()});
  assert.equal(await verifyTenantGrant(expired,'a.example','session'),null);
 });
 test('real RSA verification checks issuer, audience and membership',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kid:'fixture-key',alg:'RS256'};
  const original=globalThis.fetch;
  process.env.MC_TENANT_REGISTRY_JSON=JSON.stringify({...registry,'a.example':{...registry['a.example'],issuer:'https://fixture.cloudflareaccess.com',audience:'aud-a',subjects:['subject-a']}});
  globalThis.fetch=async()=>new Response(JSON.stringify({keys:[jwk]}),{status:200});
  const make=(sub:string,aud:string)=>{
    const content=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture-key'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({iss:'https://fixture.cloudflareaccess.com',sub,aud:[aud],exp:Date.now()/1000+60})).toString('base64url');
    return content+'.'+sign('RSA-SHA256',Buffer.from(content),privateKey).toString('base64url');
  };
  try{
    assert.equal((await resolveTenantContext(req('a.example','/api/interview/state',{'cf-access-jwt-assertion':make('subject-a','aud-a')}))).subject,'subject-a');
    await assert.rejects(resolveTenantContext(req('a.example','/api/interview/state',{'cf-access-jwt-assertion':make('subject-b','aud-a')})));
    await assert.rejects(resolveTenantContext(req('a.example','/api/interview/state',{'cf-access-jwt-assertion':make('subject-a','aud-b')})));
  }finally{globalThis.fetch=original;process.env.MC_TENANT_REGISTRY_JSON=JSON.stringify(registry);}
 });
 test('durable answers preserve content, revisions and tenant separation; retries are idempotent',async()=>{
  const a=await context(),b=await context('b.example');
  const first=queueInterviewOperation(a,'answer',{questionId:'vision',prompt:'What is your vision?',answer:'A_PRIVATE'},'fixture-answer-a');
  assert.equal(queueInterviewOperation(a,'answer',{questionId:'vision',prompt:'What is your vision?',answer:'A_PRIVATE'},'fixture-answer-a').operation_id,first.operation_id);
  assert.throws(()=>queueInterviewOperation(b,'answer',{questionId:'vision',prompt:'What is your vision?',answer:'B_PRIVATE'},'fixture-answer-a'));
  queueInterviewOperation(b,'answer',{questionId:'vision',prompt:'What is your vision?',answer:'B_PRIVATE'},'fixture-answer-b');
  assert.deepEqual(tenantAnswers(a.tenantId).map(a=>a.answer_text),['A_PRIVATE']);
  assert.deepEqual(tenantAnswers(b.tenantId).map(a=>a.answer_text),['B_PRIVATE']);
  assert.match(queryOne<{answer_text:string}>('SELECT answer_text FROM tenant_interview_answers WHERE operation_id=?',['fixture-answer-a'])!.answer_text,/^enc:v1:/);
 });
 test('real readback/export deny unknown hosts and never expose operator transcript to clients',async()=>{
  const {GET:exportAnswers}=await import('../../src/app/api/interview/answers/export/route');
  const {GET:readback}=await import('../../src/app/api/interview/answers/route');
  const dir=path.join(process.env.OPENCLAW_WORKSPACE_ROOT!,'company-discovery');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'workforce-interview-answers.md'),'**Q:** Operator?\n**A:** OPERATOR_CANARY\n');
  assert.equal((await exportAnswers(req('unknown.example','/api/interview/answers/export',{authorization:'Bearer fixture-api-token'}))).status,403);
  for(const host of ['a.example','b.example']){
    const exportResponse=await exportAnswers(req(host,'/api/interview/answers/export',{authorization:'Bearer fixture-api-token'}));
    assert.equal(exportResponse.status,200);const text=await exportResponse.text();assert.ok(!text.includes('OPERATOR_CANARY'));
    assert.ok(text.includes(host==='a.example'?'A_PRIVATE':'B_PRIVATE'));
    const readbackResponse=await readback(req(host,'/api/interview/answers',{authorization:'Bearer fixture-api-token'}));
    assert.equal(readbackResponse.status,200);assert.ok(!(await readbackResponse.text()).includes('OPERATOR_CANARY'));
  }
 });
 test('remote signatures reject tampering',()=>{
  const raw=JSON.stringify({tenant:'a',payload:'hello'}),sig=signRemoteBody(raw,'fixture');
  assert.equal(verifyRemoteBody(raw,sig,'fixture'),true);assert.equal(verifyRemoteBody(raw+' ',sig,'fixture'),false);assert.equal(verifyRemoteBody(raw,sig,'different'),false);
 });
 test('routing never picks a foreign department for explicit target or to avoid load',async()=>{
  const dept={id:'engineering',name:'Engineering',purpose:'Software',keywords:['software'],agentRoles:['Engineer'],priority:8};
  const make=(id:string,ws:string,load:number):AgentWithLoad=>({id,name:id,role:'Engineer',workspace_id:ws,status:'active',is_master:false,active_tasks:load,avatar_emoji:'',created_at:'',updated_at:''});
  assert.equal(await comDispatch({title:'Software',description:'',priority:'high',department:'Engineering'},[make('foreign','graphics',0)],[dept]),null);
  assert.equal((await comDispatch({title:'Software',description:'',priority:'high',department:'Engineering'},[make('foreign','graphics',0),make('local','engineering',10)],[dept]))?.agentId,'local');
 });
 test('fresh error ticks fail health and recovery restores it',()=>{
  for(const name of Object.keys(WATCHED_JOB_CADENCE_MINUTES))run(`INSERT INTO job_liveness(job_name,last_ran_at,last_status,consecutive_failures,last_success_at) VALUES(?,?,'error',2,?) ON CONFLICT(job_name) DO UPDATE SET last_ran_at=excluded.last_ran_at,last_status='error',consecutive_failures=2,last_success_at=excluded.last_success_at`,[name,new Date().toISOString(),new Date().toISOString()]);
  assert.equal(checkSweepLiveness().pass,false);
  run("UPDATE job_liveness SET last_status='ok',consecutive_failures=0,last_finished_at=last_ran_at,last_success_at=last_ran_at");
  assert.equal(checkSweepLiveness().pass,true);
 });
 test('25 unroutable oldest rows do not starve the 26th and dispatch counts are honest',async()=>{
  run("INSERT OR IGNORE INTO workspaces(id,name,slug,company_id) VALUES('fixture-intake-ws','Communications','fixture-intake-ws','company-a')");
  run("INSERT OR IGNORE INTO agents(id,name,role,status,workspace_id,is_master) VALUES('fixture-worker','Communications','Writer','standby','fixture-intake-ws',0)");
  for(let i=0;i<26;i++)run(`INSERT INTO tasks(id,title,status,priority,workspace_id,department,created_at,updated_at) VALUES(?,?,'inbox','medium','fixture-intake-ws','Communications',?,?)`,[`routing-${i}`,`task${i}`,`2020-01-${String(i+1).padStart(2,'0')}T00:00:00Z`,`2020-01-${String(i+1).padStart(2,'0')}T00:00:00Z`]);
  const route=async(task:any):Promise<any>=>task.title==='task25'?{status:'assigned',routing:{agentId:'fixture-worker',agentName:'Communications',department:'Communications',workspaceId:'fixture-intake-ws',companyId:'company-a',method:'semantic',confidence:0.7,score:0.3,reason:'eligible'}}:{status:'no_capable_worker',reason:'missing configuration',owner:'SYSTEM',retryable:false};
  const dispatch=async()=>({status:'held' as const,reason:'fixture capacity hold'});
  const one=await runIntakeAdvanceSweep({route,dispatch});assert.equal(one.dispatched,0);
  const two=await runIntakeAdvanceSweep({route,dispatch});assert.equal(two.routed,1,JSON.stringify({one,two,task:queryOne("SELECT * FROM tasks WHERE id='routing-25'"),worker:queryOne("SELECT a.id,a.is_master,a.workspace_id,w.company_id FROM agents a JOIN workspaces w ON w.id=a.workspace_id WHERE a.id='fixture-worker'")}));assert.equal(two.dispatched,0);
  assert.equal(queryOne<any>("SELECT assigned_agent_id FROM tasks WHERE id='routing-25'").assigned_agent_id,'fixture-worker');
  assert.equal(queryOne<any>("SELECT routing_wait_owner FROM tasks WHERE id='routing-0'").routing_wait_owner,'SYSTEM');
 });

 test('remote receiver authenticates capability and applies a canonical answer exactly once',async()=>{
  const {POST:receiver}=await import('../../src/app/api/interview/remote/route');
  const transport=globalThis.fetch;
  const fullRegistry={...registry,'a.example':{...registry['a.example'],remoteUrl:'https://receiver-a.example',remoteSecret:'receiver-fixture'},'receiver-a.example':{tenantId:'tenant-a',companyId:'company-a',kind:'self',installationId:'install-a'}};
  process.env.MC_TENANT_REGISTRY_JSON=JSON.stringify(fullRegistry);
  process.env.MC_INTERVIEW_REMOTE_SECRET='receiver-fixture';
  const scripts=process.env.OPENCLAW_SKILL23_SCRIPTS!;fs.mkdirSync(scripts,{recursive:true});
  fs.writeFileSync(path.join(scripts,'update-interview-state.sh'),'#!/bin/sh\nexit 0\n');
  let calls=0;
  globalThis.fetch=async(input:any,init:any)=>{
    calls++;
    const url=new URL(String(input));
    assert.equal(url.hostname,'receiver-a.example');
    return receiver(new NextRequest(url,{method:'POST',headers:{...init.headers,host:url.hostname},body:init.body}));
  };
  try {
    // Previously pending fixtures are superseded by this isolated transport test.
    run("UPDATE interview_remote_operations SET state='acknowledged' WHERE tenant_id='tenant-a'");
    const ctx=await context();
    const op=queueInterviewOperation(ctx,'answer',{questionId:'company_mission',prompt:'What is your mission?',answer:'REMOTE_DURABLE_CANARY'},'fixture-remote-answer');
    const first=await deliverInterviewOperation(ctx,op);
    assert.equal(first.state,'acknowledged',JSON.stringify(first));
    const second=await deliverInterviewOperation(ctx,op);
    assert.equal(second.state,'acknowledged');
    const {readTranscriptText}=await import('../../src/lib/interview/seam');
    assert.equal(readTranscriptText().text.split('REMOTE_DURABLE_CANARY').length-1,1,'duplicate receipt cannot append a duplicate answer');
    assert.ok(calls>=2);
    const bad=await receiver(new NextRequest('https://receiver-a.example/api/interview/remote',{method:'POST',headers:{host:'receiver-a.example','x-interview-signature':'bad'},body:'{}'}));
    assert.equal(bad.status,403);
  }finally{globalThis.fetch=transport;process.env.MC_TENANT_REGISTRY_JSON=JSON.stringify(registry);delete process.env.MC_INTERVIEW_REMOTE_SECRET;}
 });
 test('delayed routing cannot overwrite an owner cancellation',async()=>{
  run(`INSERT INTO tasks(id,title,status,priority,workspace_id,department,created_at,updated_at) VALUES('cancel-during-route','cancel me','inbox','medium','fixture-intake-ws','Communications','2020-01-01','2020-01-01')`);
  const route=async(task:any):Promise<any>=>{
    if(task.title==='cancel me')run("UPDATE tasks SET killed_at=?,updated_at=? WHERE id='cancel-during-route'",[new Date().toISOString(),new Date().toISOString()]);
    return {status:'assigned',routing:{agentId:'fixture-worker',agentName:'Communications',department:'Communications',workspaceId:'fixture-intake-ws',companyId:'company-a',score:1,reason:'eligible'}};
  };
  let sends=0;
  await runIntakeAdvanceSweep({route,dispatch:async()=>{sends++;return {status:'held',reason:'fixture'};}});
  const current=queryOne<any>("SELECT assigned_agent_id,killed_at FROM tasks WHERE id='cancel-during-route'");
  assert.ok(current.killed_at);assert.equal(current.assigned_agent_id,null);assert.equal(sends,0);
 });
 test('enrollment is one use and readiness validates the installed identity',async()=>{
  const {POST:enroll}=await import('../../src/app/api/auth/interview-session/route');
  const ticket=await signTenantGrant({purpose:'enrollment',tenantId:'tenant-a',subject:'owner:a',host:'a.example',installationId:'install-a',exp:Date.now()/1000+60,nonce:randomUUID()});
  const request=()=>new NextRequest('https://a.example/api/auth/interview-session',{method:'POST',headers:{host:'a.example','content-type':'application/json'},body:JSON.stringify({ticket})});
  assert.equal((await enroll(request())).status,200);
  assert.equal((await enroll(request())).status,409);
  const {GET:ready}=await import('../../src/app/api/auth/tenant-ready/route');
  process.env.MC_INSTALLATION_ID='wrong-install';
  assert.equal((await ready(req('self.example','/api/auth/tenant-ready',{authorization:'Bearer fixture-api-token'}))).status,503);
  process.env.MC_INSTALLATION_ID='install-self';
  const notConfigured=await ready(req('self.example','/api/auth/tenant-ready',{authorization:'Bearer fixture-api-token'}));
  assert.equal(notConfigured.status,503);
  assert.ok((await notConfigured.json()).missing.includes('persona_company_context_or_catalog'));
  const personaRoot=path.join(process.env.CC_TEST_FIXTURE_ROOT!,'self-persona');
  fs.mkdirSync(personaRoot,{recursive:true});
  fs.writeFileSync(path.join(personaRoot,'company-config.json'),JSON.stringify({company_id:'company-self'}));
  fs.writeFileSync(path.join(personaRoot,'catalog.json'),JSON.stringify({personas:[]}));
  process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON=JSON.stringify({'company-self':{companyRoot:personaRoot,companyConfig:path.join(personaRoot,'company-config.json'),companySlug:'company-self',personaCatalog:path.join(personaRoot,'catalog.json')}});
  const ok=await ready(req('self.example','/api/auth/tenant-ready',{authorization:'Bearer fixture-api-token'}));
  assert.equal(ok.status,200);assert.equal((await ok.json()).installationId,'install-self');
  delete process.env.MC_INSTALLATION_ID;
 });
 test('foreign interview polling is refused before a gateway can be contacted',async()=>{
  const {GET:poll}=await import('../../src/app/api/interview/turn/route');
  const response=await poll(req('a.example','/api/interview/turn?sessionId=foreign-session',{authorization:'Bearer fixture-api-token'}));
  assert.equal(response.status,403);assert.equal((await response.json()).error,'foreign_interview_session');
 });
 test('completion grants cannot be copied between tenant scopes',async()=>{
  const {signInterviewToken,verifyInterviewToken}=await import('../../src/lib/interview/gate-cookie');
  const signed=await signInterviewToken(true,'tenant-a:install-a:a.example');
  assert.equal((await verifyInterviewToken(signed.value,'tenant-a:install-a:a.example')).valid,true);
  assert.equal((await verifyInterviewToken(signed.value,'tenant-b:install-b:b.example')).complete,false);
 });

 test('middleware refuses forged edge identity and attests only authenticated own installation',async()=>{
  const {middleware}=await import('../../src/middleware');
  const fake=await middleware(req('a.example','/api/interview/answers/export',{origin:'https://a.example','cf-access-jwt-assertion':'NOT_A_JWT','cf-access-authenticated-user-email':'invented@example.test'}));
  assert.notEqual(fake.headers.get('x-middleware-next'),'1');
  process.env.MC_INSTALLATION_ID='install-self';
  const valid=await middleware(req('self.example','/api/tasks',{authorization:'Bearer fixture-api-token','x-expected-installation-id':'install-self'}));
  assert.equal(valid.headers.get('x-installation-id'),'install-self');
  const wrong=await middleware(req('self.example','/api/tasks',{authorization:'Bearer fixture-api-token','x-expected-installation-id':'foreign'}));
  assert.equal(wrong.status,403);
  delete process.env.MC_INSTALLATION_ID;
 });

 test('legacy SSE query token cannot expose the operator stream on client or unknown hosts',async()=>{
  const {middleware}=await import('../../src/middleware');
  for(const host of ['a.example','unknown.example']) {
    const response=await middleware(req(host,'/api/events/stream?token=fixture-api-token'));
    assert.equal(response.status,403);
    assert.notEqual(response.headers.get('x-middleware-next'),'1');
  }
  process.env.MC_INSTALLATION_ID='install-self';
  const response=await middleware(req('self.example','/api/events/stream?token=fixture-api-token'));
  assert.equal(response.headers.get('x-middleware-next'),'1');
  assert.equal(response.headers.get('x-installation-id'),'install-self');
  delete process.env.MC_INSTALLATION_ID;
 });

 test('actual turn handler fences simultaneous first sessions, stale mint completion, and cancellation',async()=>{
  const {POST:turn}=await import('../../src/app/api/interview/turn/route');
  const {OpenClawClient}=await import('../../src/lib/openclaw/client');
  const proto=OpenClawClient.prototype;
  const originals={isConnected:proto.isConnected,createSession:proto.createSession,getSessionHistory:proto.getSessionHistory,sendMessage:proto.sendMessage};
  let minted=0,sent=0;
  proto.isConnected=()=>true;
  proto.getSessionHistory=async()=>[];
  proto.sendMessage=async()=>{sent++;throw new Error('fixture transport stops after session ownership check');};
  const request=(signal?:AbortSignal)=>new NextRequest('https://self.example/api/interview/turn',{method:'POST',headers:{host:'self.example',authorization:'Bearer fixture-api-token','content-type':'application/json'},body:JSON.stringify({content:'start interview'}),signal});
  const reset=()=>run("UPDATE tenant_interviews SET gateway_session_id=NULL,session_reservation=NULL,session_reserved_at=NULL WHERE tenant_id='operator'");
  ensureTenantInterview('operator');
  try {
    reset();
    let release!:(value:any)=>void, entered!:()=>void;
    const enteredPromise=new Promise<void>(r=>entered=r);
    proto.createSession=async()=>{minted++;entered();return new Promise<any>(r=>release=r);};
    const first=turn(request());await enteredPromise;
    const concurrent=await turn(request());
    assert.equal(concurrent.status,503);assert.equal(minted,1);assert.equal(sent,0);
    release({id:'stable-first-session'});await first;
    assert.equal(queryOne<any>("SELECT gateway_session_id FROM tenant_interviews WHERE tenant_id='operator'").gateway_session_id,'stable-first-session');
    await turn(request());assert.equal(minted,1,'retry resumes the committed session');

    reset();sent=0;
    let lateRelease!:(value:any)=>void, lateEntered!:()=>void;
    const lateEnteredPromise=new Promise<void>(r=>lateEntered=r);
    proto.createSession=async()=>{lateEntered();return new Promise<any>(r=>lateRelease=r);};
    const stale=turn(request());await lateEnteredPromise;
    run("UPDATE tenant_interviews SET session_reserved_at='2000-01-01' WHERE tenant_id='operator'");
    proto.createSession=async()=>({id:'replacement-session'} as any);
    await turn(request());
    lateRelease({id:'late-stale-session'});
    assert.equal((await stale).status,503);
    assert.equal(queryOne<any>("SELECT gateway_session_id FROM tenant_interviews WHERE tenant_id='operator'").gateway_session_id,'replacement-session');
    assert.equal(sent,1,'late reservation owner never sends into the orphan session');

    reset();sent=0;
    let cancelRelease!:(value:any)=>void, cancelEntered!:()=>void;
    const cancelEnteredPromise=new Promise<void>(r=>cancelEntered=r);
    proto.createSession=async()=>{cancelEntered();return new Promise<any>(r=>cancelRelease=r);};
    const controller=new AbortController();const cancelled=turn(request(controller.signal));
    await cancelEnteredPromise;controller.abort();cancelRelease({id:'cancelled-session'});
    assert.equal((await cancelled).status,503);
    const saved=queryOne<any>("SELECT gateway_session_id,session_reservation FROM tenant_interviews WHERE tenant_id='operator'");
    assert.equal(saved.gateway_session_id,null);assert.equal(saved.session_reservation,null);assert.equal(sent,0);
  }finally{Object.assign(proto,originals);reset();}
 });

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {NextRequest} from 'next/server';
const root=process.env.CC_TEST_FIXTURE_ROOT!;
const companyRoot=path.join(root,'company'),workspace=path.join(root,'workspace'),runtimeRoot=path.join(root,'runtime'),scripts=path.join(root,'scripts');
Object.assign(process.env,{OPENCLAW_GATEWAY_URL:'ws://127.0.0.1:1',OPENCLAW_ROOT:runtimeRoot,OPENCLAW_WORKSPACE_ROOT:workspace,OPENCLAW_SKILL23_SCRIPTS:scripts,MC_API_TOKEN:'launch-fixture-token',MC_INSTALLATION_ID:'launch-install',MC_COMPANY_ID:'launch-company',DISABLE_CRON:'1',DISABLE_BRIDGE_BOOTSTRAP:'1'});
process.env.MC_TENANT_REGISTRY_JSON=JSON.stringify({'launch.example':{kind:'self',tenantId:'launch-tenant',companyId:'launch-company',installationId:'launch-install'}});
process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON=JSON.stringify({'launch-company':{companyRoot,companyConfig:path.join(companyRoot,'company-config.json'),companySlug:'launch-company',personaCatalog:path.join(companyRoot,'catalog.json')}});
let db:typeof import('../../src/lib/db');let GET:typeof import('../../src/app/api/auth/interview-ready/route')['GET'];
let seam:typeof import('../../src/lib/interview/seam');
const statePath=path.join(workspace,'.workforce-build-state.json'),catalogPath=path.join(companyRoot,'catalog.json');
const fresh=()=>({tenantId:'launch-tenant',companyId:'launch-company',installationId:'launch-install',interviewComplete:false,buildType:'legacy',buildId:'build-one'});
const writeState=(state:unknown)=>fs.writeFileSync(statePath,JSON.stringify(state));
const req=(host='launch.example',token='launch-fixture-token')=>new NextRequest(`https://${host}/api/auth/interview-ready`,{headers:{host,authorization:`Bearer ${token}`}});
const oldFetch=globalThis.fetch;let networkCalls=0;
test.before(async()=>{
 globalThis.fetch=async()=>{networkCalls++;throw new Error('Launch fixture forbids network');};
 for(const dir of [companyRoot,workspace,scripts,path.join(runtimeRoot,'agents','main','agent')])fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(companyRoot,'company-config.json'),JSON.stringify({companyId:'launch-company',companySlug:'launch-company'}));
 fs.writeFileSync(catalogPath,JSON.stringify({personas:{'canonical-voice':{name:'Canonical Voice'}}}));
 for(const script of ['update-interview-state.sh','record-dept-decision.sh','list-canonical-departments.py'])fs.writeFileSync(path.join(scripts,script),'# fixture implementation\n');
 fs.writeFileSync(path.join(runtimeRoot,'openclaw.json'),JSON.stringify({agents:{entries:{main:{workspace,model:{primary:'fixture/local-model'}}}}}));
 writeState(fresh());db=await import('../../src/lib/db');db.getDb();
 db.run("INSERT INTO companies(id,name,slug) VALUES('launch-company','Launch Company','launch-company')");
 db.run("INSERT INTO workspaces(id,name,slug,company_id) VALUES('launch-ws','General Task','general-task','launch-company')");
 ({GET}=await import('../../src/app/api/auth/interview-ready/route'));seam=await import('../../src/lib/interview/seam');
});
test.after(()=>{globalThis.fetch=oldFetch;db.closeDb();});
test('fresh scoped shell proves prerequisites before answers without claiming provider liveness',async()=>{
 const response=await GET(req());const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
 assert.deepEqual([body.protocol,body.tenantId,body.companyId,body.installationId,body.host,body.interviewComplete],['interview-launch.v1','launch-tenant','launch-company','launch-install','launch.example',false]);
 assert.equal(body.ready,true);assert.equal(body.capabilities.state,true);assert.equal(body.capabilities.enrollment,true);assert.equal(body.capabilities.localInterviewPrerequisites,true);assert.equal(body.capabilities.providerLiveness,'unverified');assert.equal(networkCalls,0);
 assert.equal(body.foundation.ready,false,'legacy shell does not fabricate a standard foundation');
});
test('unknown host, missing enrollment authorization and conflicting installation fail closed',async()=>{
 assert.equal((await GET(req('foreign.example'))).status,403);assert.equal((await GET(req('launch.example','wrong'))).status,403);
 for(const field of ['companyId','installationId','tenantId']){writeState({...fresh(),[field]:'foreign'});const response=await GET(req());assert.equal(response.status,503);assert.ok((await response.json()).missing.includes('scoped_interview_state'));}
 writeState(fresh());
});
test('empty catalogs, absent state, missing scripts and invalid runtime cannot pass',async()=>{
 for(const catalog of [{},[],{personas:[]},{personas:{}},{personas:[{}]}]){fs.writeFileSync(catalogPath,JSON.stringify(catalog));assert.equal((await GET(req())).status,503);}
 fs.writeFileSync(catalogPath,JSON.stringify({personas:[{id:'canonical-voice'}]}));
 fs.unlinkSync(statePath);assert.equal((await GET(req())).status,503);writeState(fresh());
 const script=path.join(scripts,'update-interview-state.sh');fs.renameSync(script,script+'.bak');assert.equal((await GET(req())).status,503);fs.renameSync(script+'.bak',script);
 fs.renameSync(path.join(runtimeRoot,'agents','main'),path.join(runtimeRoot,'agents','absent'));assert.equal((await GET(req())).status,503);fs.renameSync(path.join(runtimeRoot,'agents','absent'),path.join(runtimeRoot,'agents','main'));
 assert.equal((await GET(req())).status,200);
});
test('standard foundation requires scoped current receipt, matching artifacts and same-company board',async()=>{
 const file=path.join(companyRoot,'departments','general-task','SOUL.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'Canonical General foundation');
 const chosen=path.join(companyRoot,'departments.json');fs.writeFileSync(chosen,JSON.stringify([{id:'general-task'}]));
 const receipt={version:1,status:'verified',companyId:'launch-company',buildId:'build-one',artifacts:[{path:'departments/general-task/SOUL.md',sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')},{path:'departments.json',sha256:createHash('sha256').update(fs.readFileSync(chosen)).digest('hex')}],workspaceSlugs:['general-task']};
 const state={...fresh(),buildType:'standard-first',standardPrebuild:{status:'done',prebuiltDepartments:['general-task'],foundationVerification:receipt}};
 writeState({...state,standardPrebuild:{status:'done'}});assert.equal(seam.readStandardPrebuild().standardReady,false);assert.equal((await GET(req())).status,503);
 writeState(state);assert.equal(seam.readStandardPrebuild().standardReady,true);assert.equal((await GET(req())).status,200);
 writeState({...state,standardPrebuild:{...state.standardPrebuild,prebuiltDepartments:['general-task','missing-dept']}});assert.equal(seam.readStandardPrebuild().standardReady,false,'partial receipt cannot certify an unmaterialized department');
 writeState({...state,standardPrebuild:{...state.standardPrebuild,foundationVerification:{...receipt,artifacts:receipt.artifacts.filter(a=>a.path==='departments.json')}}});assert.equal(seam.readStandardPrebuild().standardReady,false,'chosen JSON alone is not department materialization');
 writeState(state);
 writeState({...state,buildId:'new-build'});assert.equal(seam.readStandardPrebuild().standardReady,false);
 writeState(state);fs.appendFileSync(file,' changed');assert.equal(seam.readStandardPrebuild().standardReady,false);fs.writeFileSync(file,'Canonical General foundation');
 db.run("UPDATE workspaces SET company_id='default' WHERE id='launch-ws'");assert.equal(seam.readStandardPrebuild().standardReady,false);db.run("UPDATE workspaces SET company_id='launch-company' WHERE id='launch-ws'");
 fs.unlinkSync(file);assert.equal(seam.readStandardPrebuild().standardReady,false);assert.equal((await GET(req())).status,503);
 writeState(fresh());
});


test('configured custom agentDir and string model match actual interviewer workspace',async()=>{
 const configPath=path.join(runtimeRoot,'openclaw.json'),original=fs.readFileSync(configPath);
 const custom=path.join(root,'custom-interviewer');fs.mkdirSync(custom,{recursive:true});
 try {
  fs.writeFileSync(configPath,JSON.stringify({agents:{entries:{interviewer:{agentDir:custom,workspace,model:'fixture/local-model'}}}}));
  assert.equal((await GET(req())).status,200,'sole named agent supports explicit custom runtime directory and string model');
  fs.writeFileSync(configPath,JSON.stringify({agents:{entries:{main:{agentDir:path.join(root,'missing-runtime'),workspace,model:'fixture/local-model'}}}}));
  assert.equal((await GET(req())).status,503,'stale default main directory cannot mask missing explicit agentDir');
  fs.writeFileSync(configPath,JSON.stringify({agents:{entries:{main:{agentDir:custom,workspace:companyRoot,model:'fixture/local-model'}}}}));
  assert.equal((await GET(req())).status,503,'interviewer must read the same scoped state workspace');
 } finally {fs.writeFileSync(configPath,original);}
});

test('ambient systemAgent selection wins; ownerless multi-agent fleet cannot guess main',async()=>{
 const configPath=path.join(runtimeRoot,'openclaw.json'),original=fs.readFileSync(configPath);
 const custom=path.join(root,'custom-interviewer');fs.mkdirSync(custom,{recursive:true});
 const entries={main:{workspace:companyRoot,model:'fixture/wrong-workspace'},interviewer:{agentDir:custom,workspace,model:'fixture/local-model'}};
 try {
  fs.writeFileSync(configPath,JSON.stringify({agents:{ownership:'explicit',defaults:{systemAgent:{agentId:'interviewer'}},entries}}));
  assert.equal((await GET(req())).status,200);
  fs.writeFileSync(configPath,JSON.stringify({agents:{ownership:'explicit',entries}}));
  assert.equal((await GET(req())).status,503);
  fs.writeFileSync(configPath,JSON.stringify({agents:{defaults:{systemAgent:{agentId:'missing'}},entries}}));
  assert.equal((await GET(req())).status,503);
 } finally {fs.writeFileSync(configPath,original);}
});

test('sender-issued one-use invitation redeems to authenticated state and preserves answers',async()=>{
 const {POST:issue}=await import('../../src/app/api/auth/interview-invitation/route');
 const {POST:redeem}=await import('../../src/app/api/auth/interview-session/route');
 const {GET:stateGET}=await import('../../src/app/api/interview/state/route');
 const call=()=>issue(new NextRequest('https://launch.example/api/auth/interview-invitation',{method:'POST',headers:{host:'launch.example',authorization:'Bearer launch-fixture-token','content-type':'application/json'},body:JSON.stringify({recipientHash:'a'.repeat(64)})}));
 writeState({...fresh(),interviewProgress:{savedAnswer:'Keep this answer'}});
 const denied=await stateGET(new NextRequest('https://launch.example/api/interview/state',{headers:{host:'launch.example'}}));assert.equal(denied.status,403);
 const response=await call(),invitation=await response.json();assert.equal(response.status,200,JSON.stringify(invitation));
 assert.equal(invitation.companyId,'launch-company');assert.equal(invitation.protocol,'interview-invitation.v1');
 const ticket=new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('enroll')!;assert.ok(ticket);assert.ok(invitation.expiresAt<=Date.now()/1000+86400);
 const redemption=(host='launch.example')=>redeem(new NextRequest(`https://${host}/api/auth/interview-session`,{method:'POST',headers:{host,'content-type':'application/json'},body:JSON.stringify({ticket})}));
 assert.equal((await redemption('foreign.example')).status,403);
 const enrolled=await redemption();assert.equal(enrolled.status,200);assert.equal((await redemption()).status,409);
 const cookie=enrolled.headers.get('set-cookie')!.split(';')[0];
 const state=await stateGET(new NextRequest('https://launch.example/api/interview/state',{headers:{host:'launch.example',cookie}}));assert.equal(state.status,200,await state.text());
 assert.equal(JSON.parse(fs.readFileSync(statePath,'utf8')).interviewProgress.savedAnswer,'Keep this answer');
 const freshInvitation=await call();assert.equal(freshInvitation.status,200);assert.notEqual((await freshInvitation.json()).url,invitation.url,'fresh invitation preserves tenant answers with a new one-use token');
 writeState(fresh());
});

test('invitation uses configured public origin behind an internal proxy and rejects forged forwarding',async()=>{
 const {POST:issue}=await import('../../src/app/api/auth/interview-invitation/route');
 const previousOrigin=process.env.MC_TENANT_PUBLIC_URL,previousMode=process.env.NODE_ENV;
 const call=()=>issue(new NextRequest('http://127.0.0.1:4000/api/auth/interview-invitation',{method:'POST',headers:{host:'launch.example',authorization:'Bearer launch-fixture-token','content-type':'application/json','x-forwarded-host':'foreign.example','x-forwarded-proto':'http'},body:JSON.stringify({recipientHash:'a'.repeat(64)})}));
 try {
  Object.assign(process.env,{NODE_ENV:'production',MC_TENANT_PUBLIC_URL:'https://launch.example'});
  const response=await call();assert.equal(response.status,200);assert.ok((await response.json()).url.startsWith('https://launch.example/interview#enroll='));
  process.env.MC_TENANT_PUBLIC_URL='https://foreign.example';assert.equal((await call()).status,409);
  delete process.env.MC_TENANT_PUBLIC_URL;assert.equal((await call()).status,409);
 } finally {
  if(previousOrigin===undefined)delete process.env.MC_TENANT_PUBLIC_URL;else process.env.MC_TENANT_PUBLIC_URL=previousOrigin;
  if(previousMode===undefined)delete process.env.NODE_ENV;else Object.assign(process.env,{NODE_ENV:previousMode});
 }
});

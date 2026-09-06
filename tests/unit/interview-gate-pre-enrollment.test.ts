import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Use Next's actual request stores, so the exported action calls real headers()/cookies().
Object.assign(globalThis, { AsyncLocalStorage });
const root = process.env.CC_TEST_FIXTURE_ROOT!;
Object.assign(process.env, {
  OPENCLAW_WORKSPACE_ROOT: root, OPENCLAW_ROOT: path.join(root, 'runtime'),
  MC_TENANT_SESSION_SECRET: 'gate-fixture-secret', MC_INTERVIEW_COOKIE_SECRET: 'gate-fixture-secret',
  MC_TENANT_REGISTRY_JSON: JSON.stringify({'gate.example':{kind:'self',tenantId:'gate-tenant',companyId:'gate-company',installationId:'gate-install'}}),
});
const statePath = path.join(root,'.workforce-build-state.json');
const requestStore = require('next/dist/server/app-render/work-unit-async-storage.external.js').workUnitAsyncStorage;
const workStore = require('next/dist/server/app-render/work-async-storage.external.js').workAsyncStorage;
const { ResponseCookies } = require('next/dist/compiled/@edge-runtime/cookies');
async function refresh(cookie?: string) {
  const {refreshInterviewGate}=await import('../../src/components/interview/gate-actions');
  const jar=new ResponseCookies(new Headers());
  for(const name of ['mc_interview_complete','mc_interview_gate_latch','mc_interview_bypass'])jar.set(name,'stale');
  const headers=new Headers({host:'gate.example',...(cookie?{cookie}: {})});
  await workStore.run({route:'/interview'},()=>requestStore.run({type:'request',phase:'action',headers,cookies:jar,mutableCookies:jar,userspaceMutableCookies:jar},refreshInterviewGate));
  return jar;
}
test('public pre-enrollment refresh stays locked; real signed enrollment session restores scoped refresh',async()=>{
  fs.writeFileSync(statePath,JSON.stringify({interviewComplete:true}));
  const before=await refresh();
  assert.equal(before.get('mc_interview_complete')?.value,'');
  assert.equal(before.get('mc_interview_gate_latch')?.value,'');
  assert.equal(before.get('mc_interview_bypass')?.value,'');
  const {signTenantGrant}=await import('../../src/lib/auth/tenant-context');
  const {POST}=await import('../../src/app/api/auth/interview-session/route');
  const {NextRequest}=await import('next/server');
  const ticket=await signTenantGrant({purpose:'enrollment',tenantId:'gate-tenant',installationId:'gate-install',host:'gate.example',subject:'owner:fixture',nonce:crypto.randomUUID(),exp:Math.floor(Date.now()/1000)+900});
  const enrolled=await POST(new NextRequest('https://gate.example/api/auth/interview-session',{method:'POST',headers:{host:'gate.example','content-type':'application/json'},body:JSON.stringify({ticket})}));
  assert.equal(enrolled.status,200);
  const session=enrolled.headers.get('set-cookie')!.split(';')[0];
  fs.writeFileSync(statePath,JSON.stringify({interviewComplete:false}));
  const after=await refresh(session);
  const payload=JSON.parse(Buffer.from(after.get('mc_interview_complete').value.split('.')[0],'base64url').toString());
  assert.equal(payload.complete,false);assert.equal(payload.scope,'gate-tenant:gate-install:gate.example');
  assert.equal(after.get('mc_interview_gate_latch')?.value,'');
  fs.writeFileSync(statePath,JSON.stringify({interviewComplete:true}));
  const completed=await refresh(session);
  const completePayload=JSON.parse(Buffer.from(completed.get('mc_interview_complete').value.split('.')[0],'base64url').toString());
  assert.equal(completePayload.complete,true);
  assert.equal(completePayload.scope,'gate-tenant:gate-install:gate.example');
  assert.ok(completed.get('mc_interview_gate_latch')?.value);
  const forged=await refresh('mc_tenant_session=forged');
  assert.equal(forged.get('mc_interview_complete')?.value,'');
  assert.equal(forged.get('mc_interview_gate_latch')?.value,'');
});

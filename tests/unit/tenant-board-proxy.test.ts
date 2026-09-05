import test from 'node:test';
import assert from 'node:assert/strict';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';
import { proxyTenantBoard } from '../../src/lib/tenant-board-proxy';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
test.afterEach(() => { process.env = { ...originalEnv }; globalThis.fetch = originalFetch; });
async function request(host = 'a.example') {
  process.env.MC_TENANT_SESSION_SECRET = 'fixture-secret-for-proxy-tests-only';
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'a.example': { tenantId:'a',companyId:'a',clientId:'client-a',kind:'client',installationId:'install-a',remoteUrl:'https://a-board.example',remoteApiToken:'token-a' },
    'b.example': { tenantId:'b',companyId:'b',clientId:'client-b',kind:'client',installationId:'install-b',remoteUrl:'https://b-board.example',remoteApiToken:'token-b' },
  });
  const grant = await signTenantGrant({purpose:'session',tenantId:'a',subject:'owner-a',host:'a.example',installationId:'install-a',exp:Math.floor(Date.now()/1000)+60,nonce:'test'});
  return new Request(`https://${host}/api/tenant-board/events/stream?lastEventId=4`, { headers:{host,cookie:`mc_tenant_session=${grant}`} });
}

test('client board and event stream go only to its own installation without browser credentials', async () => {
  const req = await request();
  const calls: URL[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(new URL(String(url)));
    assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer token-a');
    assert.equal(new Headers(init!.headers).get('cookie'), null);
    return new Response('data: {"company":"a"}\n\n', { headers:{'content-type':'text/event-stream','x-installation-id':'install-a'} });
  };
  const response = await proxyTenantBoard(req,['events','stream']);
  assert.equal(response.status,200);
  assert.equal(calls[0].href,'https://a-board.example/api/events/stream?lastEventId=4');
  assert.equal(await response.text(),'data: {"company":"a"}\n\n');
});

test('a tenant A grant cannot select tenant B board', async () => {
  const req = await request('b.example');
  let calls=0;globalThis.fetch = async () => { calls++; throw new Error('must not call'); };
  assert.equal((await proxyTenantBoard(req,['tasks'])).status,403);
  assert.equal(calls,0);
});

test('missing target credentials never fall back to local board', async () => {
  const req=await request();
  const registry=JSON.parse(process.env.MC_TENANT_REGISTRY_JSON!);delete registry['a.example'].remoteApiToken;
  process.env.MC_TENANT_REGISTRY_JSON=JSON.stringify(registry);
  let calls=0;globalThis.fetch = async () => { calls++; throw new Error('must not call'); };
  assert.equal((await proxyTenantBoard(req,['tasks'])).status,503);
  assert.equal(calls,0);
});

test('wrong installation receipt and cross-host redirects expose no response data', async () => {
  const req=await request();
  globalThis.fetch=async()=>new Response('PRIVATE-B',{headers:{'x-installation-id':'install-b'}});
  const mismatch=await proxyTenantBoard(req,['tasks']);
  assert.equal(mismatch.status,502);assert.equal((await mismatch.text()).includes('PRIVATE-B'),false);
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:'https://other.example'}});
  assert.equal((await proxyTenantBoard(req,['tasks'])).status,502);
});

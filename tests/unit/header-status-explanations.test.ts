/**
 * Header status rows: an idle box is not a Cloudflare Access fault, every
 * non-healthy row has a plain-English explanation, and a failed owner send says
 * WHY it failed (timeout vs exit code vs missing CLI).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_CF_ACCESS = 'true';

test('cloudflare access: idle (no requests) is live, not degraded', async () => {
  const { probeCloudflareAccess, __resetCfAccessProbe } = await import('../../src/lib/probes/cloudflare-access-probe');
  __resetCfAccessProbe();
  const r = await probeCloudflareAccess();
  assert.equal(r.status, 'live');
  assert.equal((r.detail as { idle?: boolean }).idle, true);
});

test('cloudflare access: a JWT within the window is live; requests arriving WITHOUT one are degraded', async () => {
  const { probeCloudflareAccess, recordCfAccessSeen, __resetCfAccessProbe } = await import('../../src/lib/probes/cloudflare-access-probe');
  __resetCfAccessProbe();
  recordCfAccessSeen('owner@client.test', true);
  assert.equal((await probeCloudflareAccess()).status, 'live');
  __resetCfAccessProbe();
  recordCfAccessSeen(null, false);
  const bad = await probeCloudflareAccess();
  assert.equal(bad.status, 'degraded');
  assert.match(bad.error ?? '', /without a CF Access JWT/);
  // A later request that does carry the header clears it.
  recordCfAccessSeen('owner@client.test', true);
  assert.equal((await probeCloudflareAccess()).status, 'live');
});


test('every non-healthy row has an explanation; healthy rows have none', async () => {
  const { explainStatus } = await import('../../src/lib/status-explanations');
  const components = ['database', 'openclaw_gateway', 'telegram', 'memory', 'jobs', 'disk', 'agents', 'cli',
    'cloudflare_tunnel', 'cloudflare_access', 'live_feed', 'embedding_readiness', 'provider_moonshot', 'some_future_probe'];
  for (const component of components) {
    const e = explainStatus({ component, status: 'degraded' });
    assert.ok(e, component);
    assert.ok(e.meaning.length > 20 && e.nextStep.length > 20, component);
    assert.doesNotMatch(e.meaning + e.nextStep, /HTTP \d{3}|\bprobe|\bJWT\b|\bECONN/i, `${component} must not leak jargon`);
  }
  assert.equal(explainStatus({ component: 'database', status: 'live' }), null);
});

test('moonshot 401 says the key was rejected, affects only Kimi models, and needs no action', async () => {
  const { explainStatus } = await import('../../src/lib/status-explanations');
  const e = explainStatus({ component: 'provider_moonshot', status: 'degraded', error: 'auth rejected (HTTP 401)' })!;
  assert.match(e.meaning, /key was rejected/);
  assert.match(e.meaning, /Kimi/);
  assert.equal(e.actionNeeded, false);
  assert.match(e.nextStep, /ignore/i);
});

test('critical problems say the owner must act', async () => {
  const { explainStatus } = await import('../../src/lib/status-explanations');
  assert.equal(explainStatus({ component: 'database', status: 'offline' })!.actionNeeded, true);
  assert.equal(explainStatus({ component: 'openclaw_gateway', status: 'offline' })!.actionNeeded, true);
});

test('send failures name the real cause', async () => {
  const { describeSendFailure } = await import('../../src/lib/notify');
  assert.match(describeSendFailure({ message: 'Command failed: openclaw message send', killed: true, signal: 'SIGTERM' }, '', 30000), /timeout.*30000ms/);
  assert.match(describeSendFailure({ message: 'x', code: 'ENOENT' }), /not found on PATH/);
  const exit = describeSendFailure({ message: 'Command failed', code: 2 }, 'chat not found\n');
  assert.match(exit, /exited with code 2/);
  assert.match(exit, /chat not found/);
});

/** Synthetic client approvals and mocked fetch only. No database, browser or paid I/O. */
import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { GET, POST } from '../../src/app/api/operator/tts/route';
import { speak, listTtsProviders, selectTtsProvider } from '../../src/lib/voice/tts-streaming';

const voice = 'synthetic-approved-client-voice';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-config-'));
const file = path.join(root, 'config/fish-audio-voice.json');
fs.mkdirSync(path.dirname(file));
const binding = () => ({ schema_version: 1, company_id: 'test-company',
  voice_id_sha256: createHash('sha256').update(voice).digest('hex'), approval_ref: 'fixture-owner-approval-1' });
const keys = ['OPENCLAW_ROOT', 'FISH_AUDIO_API_KEY', 'FISH_AUDIO_VOICE_ID', 'FISH_AUDIO_MODEL',
  'MC_COMPANY_ID', 'FISH_AUDIO_VOICE_BINDING_FILE', 'DEFAULT_CALL_TTS_PROVIDER',
  'OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'X_AI_API_KEY'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { OPENCLAW_ROOT: root, FISH_AUDIO_API_KEY: 'synthetic-api-key',
    FISH_AUDIO_VOICE_ID: voice, MC_COMPANY_ID: 'test-company', DEFAULT_CALL_TTS_PROVIDER: 'fish_audio' });
  fs.writeFileSync(file, JSON.stringify(binding()), { mode: 0o600 });
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('synthetic-audio', { headers: { 'content-type': 'audio/mpeg' } });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function request(query = '?provider=fish_audio') {
  return new NextRequest('http://localhost/api/operator/tts' + query, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Approved text' }),
  });
}
async function available() {
  const data = await (await GET()).json();
  return data.providers.find((provider: { id: string }) => provider.id === 'fish_audio').available;
}
async function rejected(query = '?provider=fish_audio') {
  assert.equal(await available(), false);
  const response = await POST(request(query));
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('x-tts-fallback'), 'blocked');
  const text = await response.text();
  for (const secret of ['synthetic-api-key', voice, binding().voice_id_sha256]) assert.ok(!text.includes(secret));
  assert.equal(calls.length, 0);
}

test('missing and wrong voice fail before paid I/O, including when another provider is configured', async () => {
  process.env.OPENAI_API_KEY = 'synthetic-other-provider-key';
  for (const value of ['', 'wrong-client-voice', '<placeholder>']) {
    process.env.FISH_AUDIO_VOICE_ID = value;
    await rejected();
  }
});
test('missing key or company fails closed', async () => {
  for (const key of ['FISH_AUDIO_API_KEY', 'MC_COMPANY_ID']) {
    const value = process.env[key]; delete process.env[key];
    await rejected(); process.env[key] = value;
  }
});
test('missing/malformed/foreign/self-certified approval cannot claim readiness', async () => {
  fs.unlinkSync(file); await rejected();
  for (const record of ['invalid json', 'null', '[]', '{}', JSON.stringify({ ...binding(), company_id: 'other-company' }),
    JSON.stringify({ ...binding(), approval_ref: '' }), JSON.stringify({ ...binding(), voice_id_sha256: voice })]) {
    fs.writeFileSync(file, record); await rejected();
  }
});
test('placeholder company identities cannot approve a voice', async () => {
  for (const company of ['default', 'command-center', '<client-id>']) {
    process.env.MC_COMPANY_ID = company;
    fs.writeFileSync(file, JSON.stringify({ ...binding(), company_id: company }));
    await rejected();
  }
});
test('default Fish Audio also fails closed when unready', async () => {
  process.env.FISH_AUDIO_VOICE_ID = 'wrong-voice';
  await rejected('');
});
test('matching voice sends Drama-3 in the header, correct reference and 64 kbps', async () => {
  assert.equal(await available(), true);
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-tts-provider'), 'fish_audio');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.fish.audio/v1/tts');
  assert.equal(new Headers(calls[0].init?.headers).get('model'), 'drama-3');
  const body = JSON.parse(calls[0].init?.body as string);
  assert.equal(body.reference_id, voice);
  assert.equal(body.mp3_bitrate, 64);
  assert.equal(body.latency, 'normal');
  assert.ok(!('model' in body));
});
test('explicit prior generation is honored; free, empty, legacy and unknown models are rejected', async () => {
  process.env.FISH_AUDIO_MODEL = 's2.1-pro';
  assert.equal((await POST(request())).status, 200);
  assert.equal(new Headers(calls[0].init?.headers).get('model'), 's2.1-pro');
  calls = [];
  for (const model of ['', 's1', 's2-pro', 's2.1-pro-free', 'drama-typo', 'unknown']) {
    process.env.FISH_AUDIO_MODEL = model; await rejected();
  }
});
test('request override must match the independently approved voice', async () => {
  const denied = await POST(request('?provider=fish_audio&voice=other-voice'));
  assert.equal(denied.status, 409);
  assert.equal(calls.length, 0);
  assert.equal((await POST(request('?provider=fish_audio&voice=' + voice))).status, 200);
});
test('binding override must be absolute and company-bound', async () => {
  process.env.FISH_AUDIO_VOICE_BINDING_FILE = 'relative.json'; await rejected();
  process.env.FISH_AUDIO_VOICE_BINDING_FILE = file;
  assert.equal((await POST(request())).status, 200);
});
test('provider rejection never retries a model/provider or echoes provider error text', async () => {
  process.env.OPENAI_API_KEY = 'synthetic-other-provider-key';
  for (const status of [401, 403, 429, 503]) {
    calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init });
      return new Response('synthetic-api-key ' + voice, { status }); };
    const response = await POST(request());
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('x-tts-fallback'), 'blocked');
    assert.equal(calls.length, 1);
    const text = await response.text();
    assert.ok(!text.includes(voice)); assert.ok(!text.includes('synthetic-api-key'));
  }
});
test('transport errors and successful non-audio responses fail without substitution', async () => {
  for (const response of [null, new Response('{}', { headers: { 'content-type': 'application/json' } }),
    new Response('', { headers: { 'content-type': 'audio/mpeg' } })]) {
    globalThis.fetch = async () => { if (!response) throw new Error(voice); return response; };
    const result = await POST(request());
    assert.equal(result.status, 502); assert.ok(!(await result.text()).includes(voice));
    assert.equal(result.headers.get('x-tts-fallback'), 'blocked');
  }
});
test('browser helper respects the server voice block instead of substituting speech synthesis', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 409, headers: { 'x-tts-fallback': 'blocked' } });
  await assert.rejects(speak('hello', { provider: 'fish_audio' }), /selected client voice is unavailable/);
  await assert.rejects(speak('hello'), /selected client voice is unavailable/);
  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(speak('hello', { provider: 'fish_audio' }), /selected client voice is unavailable/);
  await assert.rejects(speak('hello'), /selected client voice is unavailable/);
  for (const status of [401, 502, 503]) {
    globalThis.fetch = async () => new Response('{}', { status });
    await assert.rejects(speak('hello', { provider: 'fish_audio' }), /selected client voice is unavailable/);
    await assert.rejects(speak('hello'), /selected client voice is unavailable/);
  }
});
test('Call Mode preserves saved/default Fish selection while blocked, even with OpenAI available', async () => {
  process.env.FISH_AUDIO_VOICE_ID = 'wrong-voice';
  process.env.OPENAI_API_KEY = 'synthetic-other-provider-key';
  const metadata = await (await GET()).json();
  globalThis.fetch = async () => Response.json(metadata);
  const providers = await listTtsProviders();
  for (const stored of ['fish_audio', null] as const) {
    const selected = selectTtsProvider(providers, stored);
    assert.equal(selected, 'fish_audio');
    const response = await POST(request('?provider=' + selected));
    assert.equal(response.status, 409);
    assert.equal(calls.length, 0);
  }
  assert.equal(selectTtsProvider(providers, 'openai'), 'openai', 'an explicit user choice can change providers');
  assert.equal(selectTtsProvider([{ id: 'browser', label: 'Browser', available: true }], 'fish_audio'), 'fish_audio');
});
test('unverified provider metadata never invents an available browser voice', async () => {
  for (const metadata of [null, {}, { default: 'fish_audio', providers: [] },
    { default: 'fish_audio', providers: [{ id: 'unknown', label: 'Unknown', available: true }] },
    { default: 'fish_audio', providers: [{ id: 'fish_audio', label: 'Fish', available: 'true' }] }]) {
    globalThis.fetch = async () => metadata === null ? new Response('{}', { status: 502 }) : Response.json(metadata);
    await assert.rejects(listTtsProviders(), /configuration could not be verified/);
  }
  assert.throws(() => selectTtsProvider([], null), /configuration could not be verified/);
});
test('vendored policy matches its source fingerprint', () => {
  const policy = fs.readFileSync(path.join(process.cwd(), 'src/lib/voice/fish-audio-policy.vendored.json'));
  const expected = fs.readFileSync(path.join(process.cwd(), 'src/lib/voice/fish-audio-policy.vendored.json.sha256'), 'utf8').trim();
  assert.equal(createHash('sha256').update(policy).digest('hex'), expected);
  const source = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/lib/voice/fish-audio-policy.vendored.source.json'), 'utf8'));
  assert.equal(source.repository, 'trevorotts1/openclaw-onboarding');
  assert.equal(source.path, '30-fish-audio-api-reference/production-policy.json');
  assert.match(source.commit, /^[a-f0-9]{40}$/);
  assert.equal(source.sha256, expected);
});
test('build inventory detects policy drift while preserving per-client runtime config', () => {
  const fixture = path.join(root, 'inventory');
  fs.mkdirSync(path.join(fixture, 'src/lib/voice'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'config'), { recursive: true });
  const policyFile = path.join(fixture, 'src/lib/voice/fish-audio-policy.vendored.json');
  fs.writeFileSync(policyFile, fs.readFileSync('src/lib/voice/fish-audio-policy.vendored.json'));
  const runtimeFile = path.join(fixture, 'config/company-config.json');
  fs.writeFileSync(runtimeFile, '{}');
  const helper = path.join(process.cwd(), 'scripts/lib/build-inventory.sh');
  const digest = () => execFileSync('bash', ['-c', 'source "$1"; _ccbi_inventory_digest "$2"', 'fish-inventory', helper, fixture], { encoding: 'utf8' }).trim();
  const before = digest();
  fs.appendFileSync(policyFile, '\n');
  const changed = digest();
  assert.notEqual(changed, before, 'the compiled model policy must affect the build fingerprint');
  fs.writeFileSync(runtimeFile, '{"companyName":"Synthetic renamed company"}');
  assert.equal(digest(), changed, 'runtime client config must not invalidate the compiled build');
});

/**
 * P1-05 — QC judge-proof probe (src/lib/probes/qc-judge-probe.ts).
 *
 * Coverage:
 *   1. No QC_JUDGE_MODEL set                       -> judge_unprovisioned
 *   2. QC_JUDGE_MODEL set but not an Ollama Cloud id -> judge_unprovisioned
 *   3. QC_JUDGE_MODEL set, no key anywhere           -> judge_unprovisioned
 *   4. THE MIRAGE TEST (break-it, spec 2.1/P1-05 (e)): a bogus key that would
 *      make GET /v1/models return 200 + a full catalog (the documented
 *      v19.48.0 A-FINDING mirage) must NOT be trusted. The probe fires a real
 *      POST /v1/chat/completions call; when THAT call 401s, the probe must
 *      report judge_auth_dead — never judge_ok — regardless of what
 *      /v1/models would have said.
 *   5. Live chat-completion succeeds with real content -> judge_ok
 *   6. Live chat-completion returns 200 with an empty/unparseable body ->
 *      judge_auth_dead (a 200 alone is never proof — same mirage principle)
 *
 * Runs via the Node built-in test runner (`npm run test:unit`), stubbing
 * globalThis.fetch — the same pattern as tests/unit/provider-key-hardening
 * .test.ts's `stubFetch` helper for the Ollama Cloud connector. No network,
 * no live keys required.
 */

// C8 — DB isolation: qc-scorer.ts (imported transitively for isOllamaCloudModel)
// pulls in '@/lib/db' at module scope. Must stay the first import.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// resolveProviderApiKey (src/lib/provider-key-detection.ts) reads from
// os.homedir()/.openclaw/... (config file + auth store), not just
// process.env — by design, it scans every store on the box. On THIS
// machine that is the operator's real home directory, which really does
// have an Ollama Cloud key configured. Point HOME at an empty temp dir for
// the whole suite so "no key found" tests are genuinely isolated from the
// host's real credentials, instead of racing a real (and here, sandboxed /
// unreachable) network call. os.homedir() honors $HOME on POSIX.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-p105-judge-probe-home-'));
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = FAKE_HOME;

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const orig = (globalThis as Record<string, unknown>).fetch;
  (globalThis as Record<string, unknown>).fetch = impl;
  return () => {
    if (orig === undefined) delete (globalThis as Record<string, unknown>).fetch;
    else (globalThis as Record<string, unknown>).fetch = orig;
  };
}

function clearJudgeEnv() {
  delete process.env.QC_JUDGE_MODEL;
  delete process.env.OLLAMA_CLOUD_API_KEY;
  delete process.env.OLLAMA_API_KEY;
}

type ProbeModule = typeof import('../../src/lib/probes/qc-judge-probe');
let checkJudgeProvisioning: ProbeModule['checkJudgeProvisioning'];

test.before(async () => {
  const mod = await import('../../src/lib/probes/qc-judge-probe');
  checkJudgeProvisioning = mod.checkJudgeProvisioning;
});

test.beforeEach(() => {
  clearJudgeEnv();
});

test.after(() => {
  clearJudgeEnv();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── 1. No QC_JUDGE_MODEL at all ───────────────────────────────────────────────

test('[P1-05] no QC_JUDGE_MODEL set -> judge_unprovisioned', async () => {
  const outcome = await checkJudgeProvisioning();
  assert.equal(outcome.verdict, 'judge_unprovisioned');
  assert.equal(outcome.judgeModel, null);
  assert.match(outcome.reason, /unset/i);
});

// ── 2. QC_JUDGE_MODEL set but not an Ollama Cloud id ──────────────────────────

test('[P1-05] QC_JUDGE_MODEL set to a non-Ollama-Cloud id -> judge_unprovisioned (fails closed)', async () => {
  process.env.QC_JUDGE_MODEL = 'gpt-4o';
  process.env.OLLAMA_CLOUD_API_KEY = 'sk-does-not-matter';
  const outcome = await checkJudgeProvisioning();
  assert.equal(outcome.verdict, 'judge_unprovisioned');
  assert.equal(outcome.judgeModel, 'gpt-4o');
  assert.match(outcome.reason, /not an Ollama Cloud model id/i);
});

// ── 3. QC_JUDGE_MODEL set, Ollama Cloud shape, but NO key anywhere ────────────

test('[P1-05] QC_JUDGE_MODEL set (ollama-cloud shape), no key found -> judge_unprovisioned', async () => {
  process.env.QC_JUDGE_MODEL = 'deepseek-v3:cloud';
  // Deliberately no OLLAMA_CLOUD_API_KEY / OLLAMA_API_KEY.
  const outcome = await checkJudgeProvisioning();
  assert.equal(outcome.verdict, 'judge_unprovisioned');
  assert.equal(outcome.judgeModel, 'deepseek-v3:cloud');
  assert.match(outcome.reason, /no Ollama Cloud API key/i);
});

// ── 4. THE MIRAGE TEST — bogus key, /v1/models would 200, real call 401s ─────

test('[P1-05 MIRAGE] bogus key: /v1/models 200 + full catalog, but the real chat-completion call 401s -> judge_auth_dead (never judge_ok)', async () => {
  process.env.QC_JUDGE_MODEL = 'deepseek-v3:cloud';
  process.env.OLLAMA_CLOUD_API_KEY = 'sk-bogus-dead-key';

  let modelsWasHit = false;
  let chatWasHit = false;

  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/v1/models')) {
      // THE MIRAGE: an unauthenticated/dead key still gets 200 + full catalog.
      modelsWasHit = true;
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v3:cloud' }, { id: 'qwen3:cloud' }] }),
        { status: 200 },
      );
    }
    if (u.includes('/v1/chat/completions')) {
      // The REAL call proves the key is actually dead.
      chatWasHit = true;
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, statusText: 'Unauthorized' });
    }
    throw new Error(`unexpected fetch to ${u}`);
  });

  try {
    const outcome = await checkJudgeProvisioning();
    assert.equal(chatWasHit, true, 'the probe must fire a real chat-completion call, not just check /v1/models');
    assert.equal(
      outcome.verdict,
      'judge_auth_dead',
      `must report judge_auth_dead despite the /v1/models mirage, got: ${outcome.verdict}`,
    );
    assert.notEqual(outcome.verdict, 'judge_ok', 'a dead key must NEVER be reported judge_ok');
    // The probe itself never needs to call /v1/models (that IS the mirage
    // endpoint) — assert it did not, proving the fix isn't "also check
    // /v1/models" but "never trust it at all".
    assert.equal(modelsWasHit, false, 'the probe must not rely on GET /v1/models at all');
  } finally {
    restore();
  }
});

// ── 5. Live call succeeds with real content -> judge_ok ───────────────────────

test('[P1-05] live chat-completion succeeds with real content -> judge_ok', async () => {
  process.env.QC_JUDGE_MODEL = 'deepseek-v3:cloud';
  process.env.OLLAMA_CLOUD_API_KEY = 'sk-real-working-key';

  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) {
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${u}`);
  });

  try {
    const outcome = await checkJudgeProvisioning();
    assert.equal(outcome.verdict, 'judge_ok');
    assert.equal(outcome.judgeModel, 'deepseek-v3:cloud');
  } finally {
    restore();
  }
});

// ── 6. 200 OK but empty completion body -> judge_auth_dead ────────────────────

test('[P1-05] chat-completion 200 but empty content -> judge_auth_dead (a 200 is never proof by itself)', async () => {
  process.env.QC_JUDGE_MODEL = 'deepseek-v3:cloud';
  process.env.OLLAMA_CLOUD_API_KEY = 'sk-half-alive-key';

  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) {
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '' } }] }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${u}`);
  });

  try {
    const outcome = await checkJudgeProvisioning();
    assert.equal(outcome.verdict, 'judge_auth_dead');
  } finally {
    restore();
  }
});

// ── 7. ollama-cloud/ registry prefix form is accepted and stripped before the call ─

test('[P1-05] "ollama-cloud/<m>" registry-form judge id is accepted and the prefix is stripped before the wire call', async () => {
  process.env.QC_JUDGE_MODEL = 'ollama-cloud/deepseek-v3:cloud';
  process.env.OLLAMA_CLOUD_API_KEY = 'sk-real-working-key';

  let sentModel: string | undefined;
  const restore = stubFetch(async (url, init) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      sentModel = body.model;
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${u}`);
  });

  try {
    const outcome = await checkJudgeProvisioning();
    assert.equal(outcome.verdict, 'judge_ok');
    assert.equal(sentModel, 'deepseek-v3:cloud', 'the "ollama-cloud/" registry prefix must be stripped before the wire call');
  } finally {
    restore();
  }
});

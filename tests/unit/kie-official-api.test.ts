/**
 * CC-KIE-U1 — the KIE integration defects from
 * KIE-OFFICIAL-SKILLS-REPO-PLAN-CLEAN.md section 4.3, locked down.
 *
 * Four defects, four proofs:
 *
 *  1. `callKie` posted to the UNDOCUMENTED `/api/v1/generations` with a flat
 *     `{model, prompt}`, checked only the HTTP status, and never polled —
 *     though every KIE job is asynchronous. Now it submits
 *     `POST /api/v1/jobs/createTask {model, input}` and polls
 *     `GET /api/v1/jobs/recordInfo?taskId=` to a TERMINAL `state`.
 *     Proven by "callKie submits to the official path and polls to terminal"
 *     and "runKieJob ... polls recordInfo to a terminal state".
 *
 *  2. `provider-discovery.ts` seeded KIE model ids typed from MEMORY with
 *     `generates: true`. The official docs' rule 1 forbids it outright.
 *     Proven by "provider-discovery seeds no KIE model ids from memory".
 *
 *  3. `kie.ts fetchModels()` read `payload.data` as a LIST; the official reply
 *     is `data: { total, models: [...] }`. Proven by the data.models test and
 *     by the "HTTP 200 but body code != 200" fail-closed test.
 *
 *  4. `generate()` / `getJob()` were dead AND undocumented. A repo-wide caller
 *     search (imports of `model-providers/kie` across src/, tests/, scripts/)
 *     found zero callers, so they are deleted. Proven by the export test.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * No network: every HTTP call is a stubbed `globalThis.fetch`.
 *
 * '_isolated-db' MUST stay the first import (C8 guard): `provider-discovery`
 * transitively reaches `@/lib/db`, whose DB_PATH is frozen at module-eval.
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as kieModule from '../../src/lib/model-providers/kie';
import { fetchModels, runKieJob } from '../../src/lib/model-providers/kie';
import { PROVIDER_DISCOVERY } from '../../src/lib/studio/provider-discovery';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── fetch stub ───────────────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

interface StubbedFetch {
  calls: RecordedCall[];
  restore: () => void;
}

/**
 * Replace `globalThis.fetch` with a recorder. `handler` returns the reply for
 * each call by index (default: HTTP 200 with the given JSON body).
 */
function stubFetch(
  handler: (call: RecordedCall, index: number) => { status?: number; json: unknown }
): StubbedFetch {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: rawBody ? JSON.parse(rawBody) : null,
    };
    calls.push(call);
    const reply = handler(call, calls.length - 1);
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const NEVER_ASLEEP = async () => {};

// ── defect 3: official catalog shape ─────────────────────────────────────────

test('fetchModels parses the OFFICIAL data.models envelope (data is an object, not a list)', async () => {
  const { calls, restore } = stubFetch(() => ({
    json: {
      code: 200,
      msg: 'success',
      data: {
        total: 2,
        models: [
          { model: 'wan/3-0-video', title: 'Wan 3.0 Video', taskType: ['Text to Video'] },
          { model: 'gpt-image-2-text-to-image', title: 'GPT Image 2', taskType: ['Text to Image'] },
        ],
      },
    },
  }));
  try {
    const models = await fetchModels('kie-fake-key');
    assert.equal(models.length, 2, 'data.models must be read as a list — a flat `data` array returns 0 rows');
    assert.equal(models[0].model_id, 'kie/wan/3-0-video');
    assert.deepEqual(models[0].capabilities, ['video_generation'], 'taskType "Text to Video" -> video_generation');
    assert.deepEqual(models[1].capabilities, ['image_generation'], 'taskType "Text to Image" -> image_generation');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/v1\/models$/);
  } finally {
    restore();
  }
});

test('fetchModels fails CLOSED when HTTP is 200 but the body code is not 200', async () => {
  // Kie's gateway answers HTTP 200 even on auth failure — the status alone is
  // never proof of success (official doc rule 5).
  const { restore } = stubFetch(() => ({ status: 200, json: { code: 401, msg: 'Unauthorized' } }));
  try {
    await assert.rejects(() => fetchModels('bad-key'), /code 401/);
  } finally {
    restore();
  }
});

// ── defect 1: official createTask + poll to terminal ─────────────────────────

test('runKieJob posts to /api/v1/jobs/createTask then polls recordInfo to a terminal state', async () => {
  const { calls, restore } = stubFetch((_call, index) => {
    if (index === 0) {
      return { json: { code: 200, msg: 'success', data: { taskId: 'task-1', recordId: 'rec-1' } } };
    }
    if (index === 1) {
      return { json: { code: 200, msg: 'success', data: { taskId: 'task-1', state: 'waiting', successFlag: 0 } } };
    }
    if (index === 2) {
      return { json: { code: 200, msg: 'success', data: { taskId: 'task-1', state: 'generating', successFlag: 0 } } };
    }
    return {
      json: {
        code: 200,
        msg: 'success',
        data: {
          taskId: 'task-1',
          state: 'success',
          successFlag: 1,
          response: { resultUrls: ['https://cdn.kie.example/out.png'] },
        },
      },
    };
  });
  try {
    const result = await runKieJob('kie-fake-key', 'wan/3-0-video', { prompt: 'a red maple leaf' }, {
      pollIntervalMs: 0,
      pollTimeoutMs: 10_000,
      sleep: NEVER_ASLEEP,
    });

    assert.equal(result.taskId, 'task-1');
    assert.equal(result.state, 'success', 'must run until a TERMINAL state, not stop at the create call');
    assert.deepEqual(result.resultUrls, ['https://cdn.kie.example/out.png']);

    assert.equal(calls.length, 4, '1 createTask + 3 recordInfo polls');
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/api\/v1\/jobs\/createTask$/, 'must use the documented create path');
    assert.deepEqual(
      calls[0].body,
      { model: 'wan/3-0-video', input: { prompt: 'a red maple leaf' } },
      'createTask body is {model, input} — input is a NESTED object, not a flat prompt'
    );
    for (const poll of calls.slice(1)) {
      assert.match(poll.url, /\/api\/v1\/jobs\/recordInfo\?taskId=task-1$/, 'must poll the documented recordInfo path');
    }
    assert.ok(
      !calls.some((c) => c.url.includes('/api/v1/generations')),
      'the undocumented /api/v1/generations path must never be hit'
    );
  } finally {
    restore();
  }
});

test('runKieJob rejects a createTask whose HTTP is 200 but body code is 402 (credits) without polling', async () => {
  const { calls, restore } = stubFetch(() => ({ status: 200, json: { code: 402, msg: 'Insufficient credits' } }));
  try {
    await assert.rejects(() => runKieJob('kie-fake-key', 'wan/3-0-video', { prompt: 'x' }, { sleep: NEVER_ASLEEP }), /code 402/);
    assert.equal(calls.length, 1, 'a rejected create is not a job — never poll for a taskId that was not issued');
  } finally {
    restore();
  }
});

test('runKieJob surfaces failMsg when the job reaches the terminal fail state', async () => {
  const { restore } = stubFetch((_call, index) => {
    if (index === 0) {
      return { json: { code: 200, msg: 'success', data: { taskId: 'task-2' } } };
    }
    return {
      json: {
        code: 200,
        msg: 'success',
        data: { taskId: 'task-2', state: 'fail', successFlag: 3, failCode: 'E100', failMsg: 'prompt rejected' },
      },
    };
  });
  try {
    await assert.rejects(
      () => runKieJob('kie-fake-key', 'wan/3-0-video', { prompt: 'x' }, { sleep: NEVER_ASLEEP }),
      /prompt rejected/,
      'the terminal fail state must throw with the vendor failMsg, never resolve'
    );
  } finally {
    restore();
  }
});

test('runKieJob gives up at the deadline instead of polling forever', async () => {
  const { restore } = stubFetch((_call, index) => {
    if (index === 0) {
      return { json: { code: 200, msg: 'success', data: { taskId: 'task-3' } } };
    }
    return { json: { code: 200, msg: 'success', data: { taskId: 'task-3', state: 'queuing', successFlag: 0 } } };
  });
  try {
    await assert.rejects(
      () =>
        runKieJob('kie-fake-key', 'wan/3-0-video', { prompt: 'x' }, {
          pollIntervalMs: 0,
          pollTimeoutMs: 1,
          sleep: async () => new Promise((r) => setTimeout(r, 5)),
        }),
      /did not reach a terminal state/
    );
  } finally {
    restore();
  }
});

// ── defect 1, via the Studio entry point ─────────────────────────────────────

test('callKie submits to the official path and polls to a terminal state', async () => {
  const savedKey = process.env.KIE_API_KEY;
  const savedInterval = process.env.KIE_POLL_INTERVAL_MS;
  const savedTimeout = process.env.KIE_POLL_TIMEOUT_MS;
  process.env.KIE_API_KEY = 'kie-fake-key';
  process.env.KIE_POLL_INTERVAL_MS = '1';
  process.env.KIE_POLL_TIMEOUT_MS = '10000';

  const { calls, restore } = stubFetch((_call, index) => {
    if (index === 0) {
      return { json: { code: 200, msg: 'success', data: { taskId: 'task-9' } } };
    }
    if (index === 1) {
      return { json: { code: 200, msg: 'success', data: { taskId: 'task-9', state: 'waiting', successFlag: 0 } } };
    }
    return {
      json: {
        code: 200,
        msg: 'success',
        data: {
          taskId: 'task-9',
          state: 'success',
          successFlag: 1,
          response: { resultUrls: ['https://cdn.kie.example/studio.png'] },
        },
      },
    };
  });

  try {
    // Dynamic so the C8 DB isolation import above is evaluated first.
    const { callKie } = await import('../../src/lib/studio/generators');
    const result = await callKie(
      {
        id: 'job-1',
        kind: 'image',
        status: 'running',
        prompt: 'a single red maple leaf on wet slate',
        model_id: 'kie/gpt-image-2-text-to-image',
        provider: 'kie',
        result_path: null,
        result_url: null,
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        duration_ms: null,
        metadata: {},
      },
      { aspect_ratio: '1:1' }
    );

    assert.equal(result.url, 'https://cdn.kie.example/studio.png');
    assert.equal(result.metadata?.kie_task_id, 'task-9');

    assert.match(calls[0].url, /\/api\/v1\/jobs\/createTask$/, 'callKie must use the documented createTask path');
    assert.deepEqual(
      calls[0].body,
      { model: 'gpt-image-2-text-to-image', input: { prompt: 'a single red maple leaf on wet slate', aspect_ratio: '1:1' } },
      'provider prefix stripped; input is the nested object the API documents'
    );
    assert.ok(
      calls.slice(1).every((c) => /\/api\/v1\/jobs\/recordInfo\?taskId=task-9$/.test(c.url)),
      'callKie must poll recordInfo — the pre-fix code never polled at all'
    );
    assert.ok(calls.length >= 3, 'at least one non-terminal poll before success');
    assert.ok(
      !calls.some((c) => c.url.includes('/api/v1/generations')),
      'the undocumented /api/v1/generations path must never be hit'
    );
    // HTTP status alone is insufficient: a 200 create with a non-200 body
    // code must fail here too.
    const codeFail = stubFetch(() => ({ status: 200, json: { code: 401, msg: 'Unauthorized' } }));
    try {
      await assert.rejects(
        () =>
          callKie(
            {
              id: 'job-2',
              kind: 'image',
              status: 'running',
              prompt: 'x',
              model_id: 'kie/gpt-image-2-text-to-image',
              provider: 'kie',
              result_path: null,
              result_url: null,
              error: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              duration_ms: null,
              metadata: {},
            },
            {}
          ),
        /code 401/,
        'callKie must read body.code, never the HTTP status alone'
      );
    } finally {
      codeFail.restore();
    }
  } finally {
    restore();
    if (savedKey === undefined) delete process.env.KIE_API_KEY;
    else process.env.KIE_API_KEY = savedKey;
    if (savedInterval === undefined) delete process.env.KIE_POLL_INTERVAL_MS;
    else process.env.KIE_POLL_INTERVAL_MS = savedInterval;
    if (savedTimeout === undefined) delete process.env.KIE_POLL_TIMEOUT_MS;
    else process.env.KIE_POLL_TIMEOUT_MS = savedTimeout;
  }
});

// ── defect 2: no memory-seeded KIE model ids ─────────────────────────────────

test('provider-discovery seeds no KIE model ids from memory — only skill 66/67 canonical ids', () => {
  const kie = PROVIDER_DISCOVERY.find((p) => p.slug === 'kie');
  assert.ok(kie, 'the KIE discovery entry must still exist');
  const ids = kie!.models.map((m) => m.model_id);
  assert.ok(ids.length > 0, 'KIE must still seed image + video rows for a fresh box');

  // The five names that were typed from memory before this unit.
  const MEMORY_SEEDS = [
    'kie/nano-banana',
    'kie/gpt-image',
    'kie/flux-1.1-pro',
    'kie/veo-3',
    'kie/runway-gen3',
  ];
  for (const bad of MEMORY_SEEDS) {
    assert.ok(!ids.includes(bad), `${bad} is a memory-seeded KIE model id and must not remain`);
  }

  // Every seeded id must be a canonical_model_id published by the KIE skills
  // in openclaw-onboarding, and each must declare the createTask endpoint
  // that callKie actually submits to.
  const SKILL_66_IMAGE = new Set([
    'gpt-image-2-text-to-image',
    'gpt-image-2-image-to-image',
    'gpt-image-2-5-sunburst-text-to-image',
    'gpt-image-2-5-sunburst-image-to-image',
    'nano-banana-2',
    'nano-banana-2-lite',
    'nano-banana-pro',
    'google/nano-banana',
  ]);
  const SKILL_67_VIDEO = new Set([
    'wan/3-0-video',
    'wan/3-0-video-prime',
    'kling-3.0/video',
    'kling-3.0-omni/text-to-video',
    'kling/v2-5-turbo-text-to-video-pro',
    'bytedance/seedance-2-5',
  ]);
  let fromImageSkill = 0;
  let fromVideoSkill = 0;
  for (const id of ids) {
    const bare = id.replace(/^kie\//, '');
    if (SKILL_66_IMAGE.has(bare)) fromImageSkill += 1;
    else if (SKILL_67_VIDEO.has(bare)) fromVideoSkill += 1;
    else {
      assert.fail(
        `${id} is not a canonical_model_id from skill 66-kie-image or 67-kie-video — memory-seeded ids are forbidden`
      );
    }
  }
  assert.ok(fromImageSkill > 0, 'at least one skill-66 image id must be seeded');
  assert.ok(fromVideoSkill > 0, 'at least one skill-67 video id must be seeded (existing tab-coverage tests depend on it)');
  for (const m of kie!.models) {
    assert.equal(m.generates, true, `${m.model_id} declares generates:true`);
  }
});

// ── defect 4: dead generate() / getJob() deleted after a caller search ───────

test('kie.ts no longer exports the dead generate()/getJob(), and no source references the undocumented paths', () => {
  assert.equal('generate' in kieModule, false, 'generate() had zero callers and posts to an undocumented path');
  assert.equal('getJob' in kieModule, false, 'getJob() had zero callers and reads an undocumented path');
  assert.equal(typeof kieModule.runKieJob, 'function', 'the official create+poll runner replaces both');

  const kieSrc = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/model-providers/kie.ts'), 'utf8');
  assert.ok(!/export async function generate\b/.test(kieSrc), 'generate() must be gone from kie.ts');
  assert.ok(!/export async function getJob\b/.test(kieSrc), 'getJob() must be gone from kie.ts');
  assert.ok(
    !kieSrc.includes("'/jobs/${encodeURIComponent") && !kieSrc.includes('`${BASE_URL}/jobs/${'),
    'the undocumented /api/v1/jobs/{id} poll path must be gone'
  );
  assert.ok(
    kieSrc.includes('/jobs/createTask') && kieSrc.includes('/jobs/recordInfo'),
    'kie.ts must carry the documented createTask + recordInfo pair'
  );

  const generatorsSrc = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/studio/generators.ts'), 'utf8');
  const live = generatorsSrc
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
  assert.ok(
    !live.some((line) => line.includes('api.kie.ai/api/v1/generations')),
    'generators.ts must not submit to the undocumented /api/v1/generations path'
  );
});

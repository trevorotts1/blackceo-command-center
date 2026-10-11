/**
 * CC-KIE-1 — the REAL Studio paid entry fails CLOSED.
 *
 * JOINT PLAN section 5, row "CC-KIE-1 follow-up" (wave K), verbatim scope:
 *   'Real Studio paid entry fails closed, capabilities false, no submit/poll;
 *    catalog repair #517 delivered'.
 *
 * The paid entry is the Studio generation path: `POST
 * /api/operator/studio/generate` -> `createJob()` (src/lib/studio/generators.ts)
 * -> `runJob()` -> `callKie()` -> `runKieJob()`, which submits
 * `POST /api/v1/jobs/createTask` (the SPEND) and polls
 * `GET /api/v1/jobs/recordInfo?taskId=` to a terminal state.
 *
 * Before this unit there was NO capability gate: the route returned 202 and a
 * queued job for ANY request, and the capability flag the page advertised to
 * the UI was implicit (non-empty model list) rather than an explicit `false`.
 *
 * THE FIX (this file proves all four acceptance points):
 *   (a) capabilities false — `studioGenerationCapabilities()` reports
 *       {image:false, video:false, audio:false} when no keyed provider with a
 *       wired generate path exists, and the UI reads exactly that flag;
 *   (b) no submit — zero POST to /jobs/createTask on the unauthorized path;
 *   (c) no poll   — zero GET to /jobs/recordInfo on the unauthorized path;
 *   (d) a real non-zero exit / explicit refusal — `createJob()` throws the
 *       typed `StudioGenerationRefusedError` and the ROUTE answers HTTP 409
 *       { error: 'generation_unavailable', capabilities } (never a 202).
 *
 * A CONTROL proves the gate does not over-block: with a keyed, wired provider
 * (KIE_API_KEY + an offline KIE seed) the same capability is true and a submit
 * IS issued.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * No network: every HTTP call is a stubbed `globalThis.fetch`. HOME is pointed
 * at a throwaway dir so the OpenClaw secret-store probes and `vaultRoot()` can
 * never read or write the operator's real files.
 *
 * '_isolated-db' MUST stay the first import (C8 guard): provider-discovery and
 * generators transitively reach `@/lib/db`, whose DB_PATH is frozen at eval.
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// Sandbox HOME BEFORE any generators/route import: `candidateEnvFiles()`,
// `openclawConfigPath()` and `vaultRoot()` all resolve through os.homedir().
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kie1-home-'));
process.env.HOME = SANDBOX_HOME;

type GeneratorsModule = typeof import('../../src/lib/studio/generators');
type RouteModule = typeof import('../../src/app/api/operator/studio/generate/route');
type RegistryModule = typeof import('../../src/lib/model-registry');
type DbModule = typeof import('../../src/lib/db');
type DiscoveryModule = typeof import('../../src/lib/studio/provider-discovery');

let generators: GeneratorsModule;
let route: RouteModule;
let registry: RegistryModule;
let db: DbModule;
let discovery: DiscoveryModule;

/** Every env var that could make a Studio media capability "available". */
const MEDIA_ENV = [
  'KIE_API_KEY',
  'KIEAI_API_KEY',
  'KIE_AI_API_KEY',
  'OPENAI_API_KEY',
  'FAL_KEY',
  'FAL_API_KEY',
  'FAL_AI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_AI_STUDIO_API_KEY',
  'ELEVENLABS_API_KEY',
  'FISH_AUDIO_API_KEY',
  'REPLICATE_API_TOKEN',
  'REPLICATE_API_KEY',
  'LUMA_API_KEY',
  'LUMAAI_API_KEY',
  'STABILITY_API_KEY',
  'STABILITY_AI_API_KEY',
  'RUNWAY_API_KEY',
  'RUNWAYML_API_SECRET',
] as const;

// OPENCLAW_PROJECT_DIR would let candidateEnvFiles() read a real host .env.
const CLAMPED_ENV = ['OPENCLAW_PROJECT_DIR', ...MEDIA_ENV] as const;

/** Run `fn` with a clamped provider env containing only `vars`, then restore. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of CLAMPED_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    await fn();
  } finally {
    for (const k of CLAMPED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}
interface StubbedFetch {
  calls: RecordedCall[];
  restore: () => void;
}

/** Replace `globalThis.fetch` with a recorder (mirrors kie-official-api.test.ts). */
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

test.before(async () => {
  // Import every heavy module BEFORE `getDb()` runs migrations. Opening the DB
  // is the last thing in `before` on purpose: a large allocation burst right
  // after it can let GC collect a migration `Statement` through a weak
  // callback, which aborts better-sqlite3 12.x on Node 24.
  db = await import('../../src/lib/db');
  generators = await import('../../src/lib/studio/generators');
  route = await import('../../src/app/api/operator/studio/generate/route');
  registry = await import('../../src/lib/model-registry');
  discovery = await import('../../src/lib/studio/provider-discovery');
  db.getDb();
});

test.after(() => {
  try {
    db.closeDb();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── (a) capabilities false + (d) typed refusal, zero network ─────────────────

test('CC-KIE-1: unauthorized paid entry — capability false, createJob refuses, NO submit and NO poll', async () => {
  await withEnv({}, async () => {
    // (a) the capability flag the UI reads is FALSE for every kind.
    const caps = generators.studioGenerationCapabilities();
    assert.deepEqual(
      caps,
      { image: false, video: false, audio: false },
      'with no keyed wired provider the capability must report false, never present it as available'
    );

    const rec = stubFetch(() => ({ json: { code: 200, msg: 'success', data: { taskId: 'never' } } }));
    try {
      // (d) explicit typed refusal — never a queued job.
      await assert.rejects(
        () => generators.createJob({ kind: 'image', prompt: 'a single red maple leaf' }),
        (err: unknown) => {
          assert.ok(
            err instanceof generators.StudioGenerationRefusedError,
            'the unpaid entry must throw StudioGenerationRefusedError, not resolve to a job'
          );
          const refusal = err as { kind?: string; message: string };
          assert.equal(refusal.kind, 'image');
          assert.equal(refusal.message.includes('unavailable'), true);
          return true;
        }
      );
      // (b) no submit, (c) no poll — the refusal happens before any HTTP call.
      assert.equal(rec.calls.length, 0, 'a refused paid entry issues zero HTTP calls (no createTask, no recordInfo)');
    } finally {
      rec.restore();
    }
  });
});

// ── (d) the ROUTE answers a real non-zero exit, zero network ─────────────────

test('CC-KIE-1: POST /api/operator/studio/generate on the unauthorized path refuses HTTP 409 with capabilities false', async () => {
  await withEnv({}, async () => {
    const rec = stubFetch(() => ({ json: { code: 200, msg: 'success', data: { taskId: 'never' } } }));
    try {
      const res = await route.POST(
        new NextRequest('http://localhost/api/operator/studio/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'image', prompt: 'a single red maple leaf' }),
        })
      );

      assert.equal(res.status, 409, 'must be an explicit refusal (409), never the 202 job-acceptance');
      const body = (await res.json()) as { error: string; capabilities: Record<string, boolean> };
      assert.equal(body.error, 'generation_unavailable');
      assert.deepEqual(body.capabilities, { image: false, video: false, audio: false });
      assert.equal(rec.calls.length, 0, 'the route refusal must submit nothing and poll nothing');
    } finally {
      rec.restore();
    }
  });
});

// ── CONTROL: a keyed wired provider is still available; submit IS issued ─────

test('CC-KIE-1 control: with a keyed wired provider (KIE) the capability is true and a submit IS issued', async () => {
  await withEnv({ KIE_API_KEY: 'kie-fake-key' }, async () => {
    // Deterministic offline seed of the KIE rows (mirrors studio-registry-seed).
    registry.bulkUpsertModels(discovery.discoverRegistryRows({ hydrate: false }));

    assert.equal(
      generators.studioGenerationCapabilities().image,
      true,
      'a keyed provider with a wired generate path must report the image capability as available'
    );

    const rec = stubFetch((_call, index) =>
      index === 0
        ? { json: { code: 200, msg: 'success', data: { taskId: 'task-a' } } }
        : {
            json: {
              code: 200,
              msg: 'success',
              data: {
                taskId: 'task-a',
                state: 'success',
                successFlag: 1,
                response: { resultUrls: ['https://cdn.kie.example/out.png'] },
              },
            },
          }
    );
    try {
      const job = await generators.createJob({
        kind: 'image',
        prompt: 'a single red maple leaf',
        model_id: 'kie/gpt-image-2-text-to-image',
      });
      // `runJob` is fire-and-forget and mutates the SAME cached object, so the
      // status is racy — assert the identity the gate resolved instead.
      assert.equal(typeof job.id, 'string', 'the authorized path still creates a job');
      assert.equal(job.kind, 'image');
      assert.equal(job.model_id, 'kie/gpt-image-2-text-to-image');

      // `runJob` is fire-and-forget — wait (bounded) for the submit to land.
      const deadline = Date.now() + 3_000;
      while (
        Date.now() < deadline &&
        !rec.calls.some((c) => c.url.includes('/jobs/createTask'))
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }

      assert.ok(
        rec.calls.some((c) => c.method === 'POST' && c.url.includes('/jobs/createTask')),
        'the authorized paid entry must still issue the createTask submit'
      );
      assert.ok(
        rec.calls.some((c) => c.url.includes('/jobs/recordInfo')),
        'the authorized paid entry must still poll recordInfo to a terminal state'
      );
    } finally {
      rec.restore();
    }
  });
});

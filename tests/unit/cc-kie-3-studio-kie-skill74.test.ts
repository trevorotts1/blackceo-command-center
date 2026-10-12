/**
 * CC-KIE-3 — Studio KIE is wired to skill 74 (`kie_live_adapter.py run`).
 *
 * JOINT PLAN line 1069: "Wire Command Center's Studio to skill 74
 * (`kie_live_adapter.py run`)". CC-KIE-1 had switched the DIRECT KIE HTTP path
 * OFF; CC-KIE-3 turns Studio KIE back on THROUGH the skill 74 adapter, and it
 * fails CLOSED whenever either of the two conditions is missing.
 *
 * This file proves, with ZERO live calls and ZERO spend:
 *   (a) AVAILABILITY — a KIE row makes a Studio kind available ONLY when the
 *       skill 74 adapter is on disk AND the KIE key is present;
 *       `studioGenerationCapabilities()` is false otherwise.
 *   (b) SPAWN SHAPE — the child is `python3 <adapter> run ...` with an ARGV
 *       ARRAY (no shell): the prompt never reaches argv (it travels in the
 *       --request file), no argv element carries the key, and the key arrives
 *       by ENVIRONMENT only.
 *   (c) RESULT PARSING — a `success` result with a saved file maps to
 *       `{ url: <saved path>, metadata.skip_download: true }` (the adapter
 *       already wrote the bytes into the vault).
 *   (d) NEVER FAILS OPEN — a non-zero exit, a `fail` state, a `skipped`
 *       (shadow) state or unparseable output all become the SAME typed
 *       refusal (StudioGenerationRefusedError) — never a produced asset.
 *
 * The child process is a STUB adapter (a tiny Python script that prints one
 * canned JSON object). It is installed under the sandbox HOME's real skill-74
 * root, so the PRODUCTION resolver (`findKieLiveAdapterPath`) and the
 * PRODUCTION spawn (`execFile`) are both exercised — only the adapter's body
 * is canned. No network, no KIE API, no credits.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
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

// Sandbox HOME BEFORE any generators import: `candidateEnvFiles()`,
// `openclawConfigPath()` and `vaultRoot()` all resolve through os.homedir(),
// and the skill-74 resolver reads the same roots.
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kie3-home-'));
process.env.HOME = SANDBOX_HOME;
delete process.env.OPENCLAW_PROJECT_DIR;

/** The stub adapter: prints one canned JSON object, records what it received. */
const STUB_ADAPTER = `import json, os, sys

argv = sys.argv[1:]
req = {}
save_dir = None
try:
    req = json.load(open(argv[argv.index("--request") + 1]))
except Exception:
    pass
try:
    save_dir = argv[argv.index("--save-dir") + 1]
except Exception:
    pass

trace_path = os.environ.get("CC_KIE3_STUB_TRACE")
if trace_path:
    with open(trace_path, "w") as f:
        json.dump({"argv": argv, "has_key": bool(os.environ.get("KIE_API_KEY")), "request": req}, f)

mode = os.environ.get("CC_KIE3_STUB_MODE", "success")
if mode == "fail":
    print(json.dumps({"state": "fail", "error": {"code": "upstream", "msg": "upstream refused the job"}, "saved_paths": [], "result_urls": []}))
    sys.exit(1)
if mode == "skipped":
    print(json.dumps({"state": "skipped", "fallback_used": True, "saved_paths": [], "result_urls": [], "warnings": ["shadow: dispatch via existing static path"]}))
    sys.exit(0)
if mode == "garbage":
    print("this is not json")
    sys.exit(0)

os.makedirs(save_dir, exist_ok=True)
out = os.path.join(save_dir, "stub-output.png")
open(out, "wb").write(b"\\x89PNG\\r\\n\\x1a\\nstub")
print(json.dumps({"state": "success", "task_id": "task-123", "model_id": req.get("model"),
                  "saved_paths": [out], "result_urls": ["https://example.invalid/x.png"],
                  "credits_consumed": 7, "warnings": [], "fallback_used": False, "error": None}))
sys.exit(0)
`;

const HOME_ROOTS = ['.openclaw', '.claude', 'clawd'];
const ADAPTER_DIR = '74-kie-live-adapter';
const ADAPTER_REL = path.join('scripts', 'kie_live_adapter.py');

/** Every env var that could seed a Studio provider row via discovery. */
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

/** Install (or remove) the stub adapter under every sandbox skill root. */
function installStubAdapter(): string[] {
  const written: string[] = [];
  for (const root of HOME_ROOTS) {
    const dir = path.join(SANDBOX_HOME, root, 'skills', ADAPTER_DIR, 'scripts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'kie_live_adapter.py');
    fs.writeFileSync(file, STUB_ADAPTER, 'utf8');
    written.push(file);
  }
  return written;
}

function removeStubAdapter(): void {
  for (const root of HOME_ROOTS) {
    fs.rmSync(path.join(SANDBOX_HOME, root, 'skills', ADAPTER_DIR), { recursive: true, force: true });
  }
}

type GeneratorsModule = typeof import('../../src/lib/studio/generators');
type RegistryModule = typeof import('../../src/lib/model-registry');
type DbModule = typeof import('../../src/lib/db');
type DiscoveryModule = typeof import('../../src/lib/studio/provider-discovery');

let generators: GeneratorsModule;
let registry: RegistryModule;
let db: DbModule;
let discovery: DiscoveryModule;

const KIE_KEY = 'kie-fake-key-not-a-secret';
let traceFile: string;

type FakeJob = Parameters<GeneratorsModule['callKie']>[0];
function fakeJob(modelId: string, prompt: string): FakeJob {
  return {
    id: 'job-1',
    kind: 'image',
    status: 'running',
    prompt,
    model_id: modelId,
    provider: 'kie',
    result_path: null,
    result_url: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    duration_ms: null,
    metadata: {},
  } as unknown as FakeJob;
}

test.before(async () => {
  // Import every heavy module BEFORE `getDb()` runs migrations (same ordering
  // discipline as cc-kie-1: a large allocation burst right after the DB opens
  // can abort better-sqlite3 12.x on Node 24).
  db = await import('../../src/lib/db');
  generators = await import('../../src/lib/studio/generators');
  registry = await import('../../src/lib/model-registry');
  discovery = await import('../../src/lib/studio/provider-discovery');
  db.getDb();

  // discovery emits rows ONLY for providers whose key env is present, so clamp
  // the ambient media env and seed with just the KIE key: the registry then
  // holds deterministic KIE rows (image + video) and nothing else.
  const saved: Record<string, string | undefined> = {};
  for (const k of MEDIA_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.KIE_API_KEY = KIE_KEY;
  registry.bulkUpsertModels(discovery.discoverRegistryRows({ hydrate: false }));
  for (const k of MEDIA_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }

  traceFile = path.join(SANDBOX_HOME, 'stub-trace.json');
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

// ── (a) availability: adapter on disk AND key present ────────────────────────

test('CC-KIE-3: a KIE row is available ONLY when the skill 74 adapter exists AND the KIE key is present', async () => {
  delete process.env.KIE_API_KEY;
  removeStubAdapter();
  assert.deepEqual(
    generators.studioGenerationCapabilities(),
    { image: false, video: false, audio: false },
    'no adapter + no key: nothing is available'
  );

  installStubAdapter();
  assert.deepEqual(
    generators.studioGenerationCapabilities(),
    { image: false, video: false, audio: false },
    'adapter present but no key: still nothing available (fail closed)'
  );

  process.env.KIE_API_KEY = KIE_KEY;
  const caps = generators.studioGenerationCapabilities();
  assert.equal(caps.image, true, 'adapter + key: KIE image becomes available');
  assert.equal(caps.video, true, 'adapter + key: KIE video becomes available');
  assert.equal(caps.audio, false, 'the offline KIE seed has no audio row, so audio stays false');
});

// ── (b)+(c) spawn shape, environment-only key, result parsing ────────────────

test('CC-KIE-3: callKie spawns python3 <adapter> run with an argv array (no shell), key by environment only, and parses the JSON result', async () => {
  installStubAdapter();
  process.env.KIE_API_KEY = KIE_KEY;
  process.env.CC_KIE3_STUB_MODE = 'success';
  process.env.CC_KIE3_STUB_TRACE = traceFile;

  // A prompt with shell metacharacters: if the spawn ever used a shell it would
  // be interpreted. It instead travels inside the --request JSON file only.
  const prompt = 'a red maple leaf $(touch /tmp/cc-kie3-pwned) `id` ; rm -rf /';
  const out = await generators.callKie(fakeJob('kie/gpt-image-2-text-to-image', prompt), {});

  const trace = JSON.parse(fs.readFileSync(traceFile, 'utf8')) as {
    argv: string[];
    has_key: boolean;
    request: { model?: string; input?: { prompt?: string } };
  };

  // argv shape: the FIRST arg is `run`; flags are separate array elements.
  assert.equal(trace.argv[0], 'run', 'the subcommand must be `run`');
  assert.ok(trace.argv.includes('--request'), 'argv must carry --request');
  assert.ok(trace.argv.includes('--save-dir'), 'argv must carry --save-dir');
  assert.equal(trace.argv[trace.argv.indexOf('--mode') + 1], 'active', 'the paid run must be dispatched active');
  assert.ok(trace.argv.includes('--json'), 'argv must carry --json');

  // NO SHELL: the prompt is not an argv element — it lives in the request file.
  assert.ok(
    !trace.argv.some((a) => a.includes('cc-kie3-pwned') || a.includes('a red maple leaf')),
    'the prompt must never appear on argv (no shell interpretation, no injection)'
  );
  assert.equal(
    fs.existsSync('/tmp/cc-kie3-pwned'),
    false,
    'no shell was used: the command-substitution marker never executed'
  );

  // KEY BY ENVIRONMENT ONLY.
  assert.equal(trace.has_key, true, 'the adapter must receive KIE_API_KEY in its environment');
  assert.ok(
    !trace.argv.some((a) => a.includes(KIE_KEY)),
    'the key must NEVER appear on argv'
  );

  // The request file carries model + input.
  assert.equal(trace.request.model, 'gpt-image-2-text-to-image', 'the `kie/` prefix is stripped for the adapter');
  assert.equal(trace.request.input?.prompt, prompt, 'the prompt travels verbatim in the request file');

  // (c) parse mapping — the adapter already saved the file; skip the download.
  assert.ok(out.url.startsWith(SANDBOX_HOME), 'the mapped url is the adapter-saved file in the vault');
  assert.equal(out.metadata?.skip_download, true, 'a saved file must skip runJob()\'s download step');
  assert.equal(out.metadata?.kie_task_id, 'task-123');
  assert.equal(out.metadata?.kie_state, 'success');
  assert.equal(out.metadata?.kie_credits_consumed, 7);
  assert.equal(out.metadata?.kie_adapter, true);
  assert.ok(fs.existsSync(out.url), 'the produced file exists on disk');
});

test('CC-KIE-3: with adapter + key a KIE request is ACCEPTED (not refused) and resolves to the KIE model', async () => {
  installStubAdapter();
  process.env.KIE_API_KEY = KIE_KEY;
  process.env.CC_KIE3_STUB_MODE = 'success';

  const job = await generators.createJob({
    kind: 'image',
    prompt: 'a single red maple leaf',
    model_id: 'kie/gpt-image-2-text-to-image',
  });
  assert.equal(job.kind, 'image');
  assert.equal(job.provider, 'kie', 'the resolved provider must be KIE');
  assert.equal(job.model_id, 'kie/gpt-image-2-text-to-image');
  assert.ok(['queued', 'running', 'succeeded'].includes(job.status), 'the paid entry must be accepted, not refused');
});

// ── (d) NEVER fails open ──────────────────────────────────────────────────────

async function assertRefused(mode: string, expectedFragment: string): Promise<void> {
  installStubAdapter();
  process.env.KIE_API_KEY = KIE_KEY;
  process.env.CC_KIE3_STUB_MODE = mode;
  await assert.rejects(
    () => generators.callKie(fakeJob('kie/gpt-image-2-text-to-image', 'a single red maple leaf'), {}),
    (err: unknown) => {
      assert.ok(
        err instanceof generators.StudioGenerationRefusedError,
        `stub mode "${mode}" must become the typed refusal, not a produced asset`
      );
      assert.equal(
        (err as Error).message.includes(expectedFragment),
        true,
        `refusal message must name the cause (${expectedFragment}); got: ${(err as Error).message}`
      );
      return true;
    }
  );
}

test('CC-KIE-3: a non-zero adapter exit (state fail) is a typed refusal, never a produced asset', async () => {
  await assertRefused('fail', 'upstream refused the job');
});

test('CC-KIE-3: a skipped adapter run (shadow) is a typed refusal — Studio KIE never fails open', async () => {
  await assertRefused('skipped', 'skipped');
});

test('CC-KIE-3: unparseable adapter output is a typed refusal', async () => {
  await assertRefused('garbage', 'KIE Studio generation failed');
});

test('CC-KIE-3: an explicit KIE request with NO key refuses before spawning anything', async () => {
  installStubAdapter();
  delete process.env.KIE_API_KEY;
  const refused = await generators
    .createJob({ kind: 'image', prompt: 'a single red maple leaf', model_id: 'kie/gpt-image-2-text-to-image' })
    .then(() => null)
    .catch((e: unknown) => e);
  assert.ok(
    refused instanceof generators.StudioGenerationRefusedError,
    'a KIE request without a key must refuse, never queue a job'
  );
  assert.equal(
    (refused as Error).message.includes('no KIE API key is set'),
    true,
    'the refusal must name the missing key'
  );
});

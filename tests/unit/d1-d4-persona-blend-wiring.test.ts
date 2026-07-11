/**
 * CC-PERSONA cluster — D1, D2, D3, D4 (ZHC-ENGINE-CC-KANBAN-PERSONA-MASTER-SPEC).
 *
 * Proves persona-blend DUALITY actually runs in prod, end to end:
 *
 *   D1 — `--blend` was never passed (duality dead in prod). Fixed:
 *        buildSelectorArgv appends --blend; selectPersonaForTask falls back
 *        through progressively fewer flags on an unknown-argument rejection
 *        (never fails selection on a stale box); createTaskCore's TS mirror
 *        of persona_blend.is_content_task routes content tasks to
 *        resolvePersonaAndPin({blend:true}) INSTEAD OF --combined.
 *
 *   D2 — the Python matcher emits `resolved_audience.candidates` as OBJECTS
 *        ({label, audience_persona_id, matched_tags, why?} — persona_blend.py
 *        `_candidate()`), but the CC parser kept only `typeof c === "string"`
 *        entries, so candidates was ALWAYS []. Fixed: normalizeResolvedAudience
 *        extracts `.label` from an object candidate (bare strings still work,
 *        back-compat).
 *
 *   D3 — confirmTaskAudience had ZERO callers outside its own unit tests, so
 *        every gated content task unconditionally 30-min timed out. Fixed:
 *        POST/GET /api/tasks/[id]/audience + rescoreAudienceBlend (tasks.ts)
 *        + a minimal Kanban confirm panel (TaskModal.tsx).
 *
 *   D4 — the matcher emits `confidence` as the STRING enum 'high'|'medium'|
 *        'none' (persona_blend.py resolve_audience), but the parser only
 *        accepted `typeof a.confidence === "number"`, coercing every real
 *        result to 0 — the "single high-confidence ICP → CONFIRM prompt"
 *        branch (buildAudiencePrompt, AUDIENCE_HIGH_CONFIDENCE=0.75) was
 *        unreachable. Fixed: high→0.9, medium→0.6, none→0 (numeric passthrough
 *        kept for fixtures / a future numeric-emitting matcher).
 *
 * D1/D2/D4's "real spawn" coverage below does NOT depend on the actual
 * installed OpenClaw skill script (which may not exist / may differ per box
 * or in CI) — it points OPENCLAW_ROOT at a throwaway stub `persona-selector-v2.py`
 * that behaves like the real --blend contract (candidate OBJECTS + string
 * confidence, captured verbatim from a live `persona_blend.py resolve_audience()`
 * run — see the ledger evidence / the comments on each stub below). This
 * exercises the REAL execFile + argv-assembly + JSON-parse path (never
 * PERSONA_FIXTURE_JSON, which short-circuits before argv is even built), so a
 * passing bundle assertion is real proof `--blend` actually reached the argv.
 *
 * Node built-in test runner under tsx (`npm run test:unit`). Isolated temp DB;
 * DATABASE_PATH is set BEFORE `@/lib/db` is imported (established convention).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-d1d4-blend-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.DISABLE_QC_AUTO_SCORER = 'true';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
// Default OFF for the whole suite; individual "real spawn" tests point this at
// a throwaway stub root and restore it afterward.
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type SelectorModule = typeof import('../../src/lib/persona-selector');
let buildSelectorArgv: SelectorModule['buildSelectorArgv'];
let selectPersonaForTask: SelectorModule['selectPersonaForTask'];
let parsePersonaBundle: SelectorModule['parsePersonaBundle'];

type TasksModule = typeof import('../../src/lib/tasks');
let isContentTask: TasksModule['isContentTask'];
let resolvePersonaAndPin: TasksModule['resolvePersonaAndPin'];
let createTaskCore: TasksModule['createTaskCore'];
let rescoreAudienceBlend: TasksModule['rescoreAudienceBlend'];
let confirmTaskAudience: TasksModule['confirmTaskAudience'];
let evaluateAudienceConfirmGate: TasksModule['evaluateAudienceConfirmGate'];

type PersonaSelectorLib = typeof import('../../src/lib/persona-selector');
let persistPersonaBundle: PersonaSelectorLib['persistPersonaBundle'];

type AudienceRouteModule = typeof import('../../src/app/api/tasks/[id]/audience/route');
let audienceGET: AudienceRouteModule['GET'];
let audiencePOST: AudienceRouteModule['POST'];

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}`;

test.before(async () => {
  const db = await import('../../src/lib/db');
  ({ run, queryOne, queryAll, closeDb } = db);
  db.getDb(); // full migration chain incl. 090

  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, industry, config) VALUES (?, ?, ?, ?, ?)`,
    ['default', 'Test Company', 'test-company', '', '{}'],
  );

  const sel = await import('../../src/lib/persona-selector');
  ({ buildSelectorArgv, selectPersonaForTask, parsePersonaBundle, persistPersonaBundle } = sel);

  const tasks = await import('../../src/lib/tasks');
  ({
    isContentTask, resolvePersonaAndPin, createTaskCore, rescoreAudienceBlend,
    confirmTaskAudience, evaluateAudienceConfirmGate,
  } = tasks);

  const audienceRoute = await import('../../src/app/api/tasks/[id]/audience/route');
  ({ GET: audienceGET, POST: audiencePOST } = audienceRoute);
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

function insertWorkspace(id: string, slug: string, name: string): void {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, slug, 'Test dept', 900 + counter],
  );
}

function insertTask(id: string, opts: { title?: string; audienceLabel?: string | null } = {}): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, department, audience_label, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', NULL, NULL, 'marketing', ?, ?, ?)`,
    [id, opts.title ?? `Blend task ${id}`, opts.audienceLabel ?? null, now, now],
  );
}

function bundle(overrides: Partial<import('../../src/lib/types').PersonaBundle> = {}): import('../../src/lib/types').PersonaBundle {
  return {
    topic: 'SaaS pricing page',
    confirm_required: true,
    resolved_audience: {
      source: 'onboarding_icp',
      candidates: ['Founders', 'RevOps leads'],
      confidence: 0.4,
      label: null,
      id: null,
    },
    voice: {
      audience_persona: { id: 'audience-voice-persona', why: 'writes for founders' },
      topic_persona: { id: 'ogilvy-on-advertising', why: 'pricing craft' },
      collapsed: false,
      topic_as_task_guidance: true,
    },
    blend_directive: 'Write in the audience voice; carry the topic persona expertise.',
    task_personas: [
      { seq: 1, part: 'headline', persona_id: 'ogilvy-on-advertising', why: 'headline craft' },
    ],
    catalog_version: '1.3',
    ...overrides,
  };
}

/** Writes a throwaway persona-selector-v2.py stub and returns its OPENCLAW_ROOT. */
function makeStubOpenClawRoot(scriptBody: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-stub-openclaw-'));
  const scriptsDir = path.join(root, 'skills', '23-ai-workforce-blueprint', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, 'persona-selector-v2.py'), scriptBody, { mode: 0o755 });
  return root;
}

/** Poll until `fn()` returns a truthy value or the timeout elapses. */
async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000, intervalMs = 50): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// D1 — buildSelectorArgv: --blend forwarding (pure, no spawn)
// ═══════════════════════════════════════════════════════════════════════════

test('[D1] buildSelectorArgv: no --blend when blend is omitted/false (back-compat, unchanged base argv)', () => {
  const argv1 = buildSelectorArgv('/x/selector.py', 'do a thing', 'marketing', 'task-1');
  assert.ok(!argv1.includes('--blend'), 'no --blend by default');
  const argv2 = buildSelectorArgv('/x/selector.py', 'do a thing', 'marketing', 'task-1', null, false);
  assert.ok(!argv2.includes('--blend'), 'no --blend when explicitly false');
});

test('[D1] buildSelectorArgv: blend=true appends --blend', () => {
  const argv = buildSelectorArgv('/x/selector.py', 'draft an email', 'marketing', 'task-2', null, true);
  assert.ok(argv.includes('--blend'), '--blend must be present');
  assert.ok(argv.includes('--task') && argv.includes('--department'), 'base flags still present');
});

test('[D1] buildSelectorArgv: sopContext + blend=true both forward independently', () => {
  const argv = buildSelectorArgv('/x/selector.py', 'draft an email', 'marketing', 'task-3', {
    slug: 'cold-email', name: 'Cold Email', hints: ['bly-copywriters-handbook'],
  }, true);
  assert.ok(argv.includes('--sop-slug') && argv.includes('--sop-name') && argv.includes('--sop-hints'), 'sop flags present');
  assert.ok(argv.includes('--blend'), '--blend present alongside sop flags');
});

// ═══════════════════════════════════════════════════════════════════════════
// D1 — selectPersonaForTask: REAL spawn against a stub script (no PERSONA_
// FIXTURE_JSON short-circuit) proves --blend actually reaches argv, and that
// a stale-box unknown-argument rejection falls back instead of failing
// selection outright (D1 fix steps 2 + 6).
// ═══════════════════════════════════════════════════════════════════════════

// Emits the real --blend SUPERSET shape (candidate OBJECTS + string
// confidence, mirroring a live persona_blend.py resolve_audience() run) ONLY
// when --blend is actually present in argv; legacy single-persona shape
// otherwise. A non-null `bundle` on the result is therefore direct proof the
// flag reached the child process, not a JS-level assumption.
const BLEND_STUB = `#!/usr/bin/env python3
import sys, json

def main():
    argv = sys.argv[1:]
    if "--blend" in argv:
        print(json.dumps({
            "persona_id": "walker-launch",
            "persona_name": "Walker Launch",
            "score": 3.0,
            "interaction_mode": "leadership",
            "confirm_required": True,
            "resolved_audience": {
                "source": "asked",
                "candidates": [
                    {"label": "busy solo real estate agents", "audience_persona_id": "realtor-voice",
                     "matched_tags": ["real estate agents"], "why": "Audience voice match"},
                    {"label": "first-time home buyers", "audience_persona_id": None, "matched_tags": []},
                ],
                "confidence": "medium",
                "label": "busy solo real estate agents",
                "ask": "What audience are we dealing with?",
            },
            "voice": {
                "audience_persona": None,
                "topic_persona": {"id": "walker-launch", "why": "topic match"},
                "collapsed": False,
                "topic_as_task_guidance": True,
            },
            "blend_directive": "Audience not yet confirmed \\u2014 draft in a neutral house voice.",
            "task_personas": [
                {"seq": 1, "part": "the job", "persona_id": "miller-marketing-made-simple", "why": "best fit"},
            ],
            "catalog_version": "1.3",
        }))
    else:
        print(json.dumps({
            "persona_id": "generic-leader",
            "persona_name": "Generic Leader",
            "score": 1.0,
            "interaction_mode": "leadership",
        }))
    return 0

sys.exit(main())
`;

test('[D1] selectPersonaForTask: real spawn WITH blend:true → non-null bundle; candidates/confidence proven (D2/D4 wiring)', async () => {
  const root = makeStubOpenClawRoot(BLEND_STUB);
  const prevRoot = process.env.OPENCLAW_ROOT;
  process.env.OPENCLAW_ROOT = root;
  try {
    const result = await selectPersonaForTask('t-real-blend', 'Draft 2 marketing emails', 'marketing', null, { blend: true });
    assert.ok(result, 'selection must succeed');
    assert.ok(result!.bundle, 'a non-null bundle proves --blend reached the real child-process argv');
    // D2 — object candidates parsed to LABEL STRINGS.
    assert.deepEqual(
      result!.bundle!.resolved_audience?.candidates,
      ['busy solo real estate agents', 'first-time home buyers'],
      'D2: candidate OBJECTS extracted to label strings, not filtered to []',
    );
    // D4 — string confidence "medium" mapped to 0.6.
    assert.equal(result!.bundle!.resolved_audience?.confidence, 0.6, 'D4: "medium" → 0.6');
  } finally {
    process.env.OPENCLAW_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[D1] selectPersonaForTask: real spawn WITHOUT blend → legacy shape, bundle stays null (no spurious --blend)', async () => {
  const root = makeStubOpenClawRoot(BLEND_STUB);
  const prevRoot = process.env.OPENCLAW_ROOT;
  process.env.OPENCLAW_ROOT = root;
  try {
    const result = await selectPersonaForTask('t-real-nonblend', 'restart the app server', 'marketing');
    assert.ok(result);
    assert.equal(result!.persona_id, 'generic-leader', 'legacy branch taken — --blend was NOT sent');
    assert.equal(result!.bundle, null, 'no bundle when --blend was not requested');
  } finally {
    process.env.OPENCLAW_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A box whose selector predates W7 --blend: argparse rejects it with an
// "unrecognized arguments" SystemExit. The fallback must retry WITHOUT
// --blend rather than fail the whole selection (D1 fix steps 2 + 6).
const REJECT_BLEND_STUB = `#!/usr/bin/env python3
import sys, json
argv = sys.argv[1:]
if "--blend" in argv:
    sys.stderr.write("persona-selector-v2.py: error: unrecognized arguments: --blend\\n")
    sys.exit(2)
print(json.dumps({"persona_id": "fallback-persona", "persona_name": "Fallback Persona", "score": 1.0, "interaction_mode": "leadership"}))
sys.exit(0)
`;

test('[D1] selectPersonaForTask: stale box rejects --blend (unrecognized argument) → falls back, NEVER fails selection', async () => {
  const root = makeStubOpenClawRoot(REJECT_BLEND_STUB);
  const prevRoot = process.env.OPENCLAW_ROOT;
  process.env.OPENCLAW_ROOT = root;
  try {
    const result = await selectPersonaForTask('t-stale-blend', 'draft a newsletter', 'marketing', null, { blend: true });
    assert.ok(result, 'selection must NOT fail on a stale box (D1 fix step 2/6)');
    assert.equal(result!.persona_id, 'fallback-persona', 'fell back to the plain (no --blend) tier');
    assert.equal(result!.bundle, null, 'the fallback tier is the legacy shape — no bundle, but never naked');
  } finally {
    process.env.OPENCLAW_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A box predating BOTH DEP-1 (--sop-*) and W7 (--blend): every enhanced tier
// is rejected; only the bare argv succeeds. Proves multi-tier fallback, not
// just a single-level retry.
const REJECT_SOP_AND_BLEND_STUB = `#!/usr/bin/env python3
import sys, json
argv = sys.argv[1:]
if "--blend" in argv or any(a.startswith("--sop-") for a in argv):
    sys.stderr.write("persona-selector-v2.py: error: unrecognized arguments\\n")
    sys.exit(2)
print(json.dumps({"persona_id": "bare-persona", "persona_name": "Bare Persona", "score": 1.0, "interaction_mode": "leadership"}))
sys.exit(0)
`;

test('[D1] selectPersonaForTask: box predates BOTH --sop-* and --blend → falls all the way back to bare argv', async () => {
  const root = makeStubOpenClawRoot(REJECT_SOP_AND_BLEND_STUB);
  const prevRoot = process.env.OPENCLAW_ROOT;
  process.env.OPENCLAW_ROOT = root;
  try {
    const result = await selectPersonaForTask('t-ancient-box', 'draft an ad', 'marketing',
      { slug: 'x', name: 'X', hints: [] }, { blend: true });
    assert.ok(result, 'selection must not fail even on a box predating both features');
    assert.equal(result!.persona_id, 'bare-persona');
  } finally {
    process.env.OPENCLAW_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// PERS-03 parity: a REAL crash (not an unrecognized-argument error) must NEVER
// be silently retried away as "predates this flag" — even though the bare
// tier would have succeeded here, the fallback must not mask a genuine bug.
const REAL_ERROR_STUB = `#!/usr/bin/env python3
import sys, json
argv = sys.argv[1:]
if "--blend" in argv:
    sys.stderr.write("Traceback (most recent call last):\\n  File \\"x.py\\", line 1, in <module>\\nValueError: boom\\n")
    sys.exit(1)
print(json.dumps({"persona_id": "would-have-worked", "persona_name": "Would Have Worked", "score": 1.0, "interaction_mode": "leadership"}))
sys.exit(0)
`;

test('[D1] selectPersonaForTask: a REAL crash on --blend is NOT swallowed as an unknown-arg retry (PERS-03 parity)', async () => {
  const root = makeStubOpenClawRoot(REAL_ERROR_STUB);
  const prevRoot = process.env.OPENCLAW_ROOT;
  process.env.OPENCLAW_ROOT = root;
  try {
    const result = await selectPersonaForTask('t-real-crash', 'draft a blog post', 'marketing', null, { blend: true });
    // The outer catch in selectPersonaForTask swallows to null — but critically
    // it must NOT have silently retried to the bare tier and returned
    // "would-have-worked": that would mask a real Python crash as benign.
    assert.equal(result, null, 'a genuine crash surfaces as a failed selection, never masked by the fallback');
  } finally {
    process.env.OPENCLAW_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// D1 — isContentTask: TS mirror of persona_blend.is_content_task (pure)
// ═══════════════════════════════════════════════════════════════════════════

test('[D1] isContentTask: true for genuine content signals (word + stem + phrase)', () => {
  assert.equal(isContentTask('Draft 2 marketing emails and 2 SMS for the fall launch'), true, 'draft/email');
  assert.equal(isContentTask('Write 3 Instagram posts for next week'), true, 'write/instagram/post (stemmed from "posts")');
  assert.equal(isContentTask('Create a landing page for the webinar'), true, 'phrase: landing page');
  assert.equal(isContentTask('Ghostwrite a guest post for the blog'), true, 'phrase: guest post');
  assert.equal(isContentTask('Record the podcast episode intro voiceover'), true, 'podcast/episode/voiceover');
});

test('[D1] isContentTask: false for ops/mechanical tasks, including incidental substrings (word-boundary, not raw substring)', () => {
  assert.equal(isContentTask('restart the web server'), false, 'mechanical, no content words');
  assert.equal(isContentTask('read the deployment logs'), false, '"read" must NOT match content word "ad"');
  assert.equal(isContentTask('run compost analytics on the download admin panel'), false, '"compost"/"download"/"admin" must NOT match "post"/"ad"');
  assert.equal(isContentTask(''), false, 'empty text');
});

// ═══════════════════════════════════════════════════════════════════════════
// D1 — createTaskCore: content-task routing (--blend INSTEAD OF --combined)
// end-to-end, real spawn. A non-null bundle on the CONTENT task and null on
// the non-content task is direct proof of the routing decision (the stub
// only emits bundle fields when --blend is truly in argv).
// ═══════════════════════════════════════════════════════════════════════════

test('[D1] createTaskCore: a CONTENT task routes to --blend and the bundle lands on the row', async () => {
  const root = makeStubOpenClawRoot(BLEND_STUB);
  const prevRoot = process.env.OPENCLAW_ROOT;
  process.env.OPENCLAW_ROOT = root;
  const wsId = `ws-d1-content-${Date.now()}`;
  insertWorkspace(wsId, 'marketing', 'Marketing Department');
  try {
    const result = await createTaskCore({
      title: 'Draft 2 marketing emails and 2 SMS for the fall launch',
      workspace_id: wsId,
      department: 'marketing',
      skipWindowDedup: true,
    });
    assert.ok(result, 'createTaskCore must return a result');
    const taskId = result!.task.id;

    const row = await waitFor(() =>
      queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id = ?', [taskId]),
    );
    const parsed = JSON.parse(row.bundle_json);
    assert.deepEqual(
      parsed.resolved_audience.candidates,
      ['busy solo real estate agents', 'first-time home buyers'],
      'the SAME real-spawn bundle landed via createTaskCore → resolvePersonaAndPin({blend:true}) → persistPersonaBundle',
    );

    const mirror = queryOne<{ blend_directive: string | null }>(
      'SELECT blend_directive FROM tasks WHERE id = ?', [taskId],
    );
    assert.ok(mirror?.blend_directive, 'blend_directive mirror column populated for the content task');
  } finally {
    process.env.OPENCLAW_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[D1] createTaskCore: a NON-content mechanical task is unaffected — no --blend, no bundle', async () => {
  const root = makeStubOpenClawRoot(BLEND_STUB);
  const prevRoot = process.env.OPENCLAW_ROOT;
  process.env.OPENCLAW_ROOT = root;
  const wsId = `ws-d1-noncontent-${Date.now()}`;
  insertWorkspace(wsId, 'operations', 'Operations Department');
  try {
    const result = await createTaskCore({
      title: 'restart the app server',
      workspace_id: wsId,
      department: 'operations',
      skipWindowDedup: true,
    });
    assert.ok(result);
    const taskId = result!.task.id;

    // Give the (fast, stub-backed) async persona pin time to land. A bare row
    // existence check would false-positive immediately (persona_id starts
    // NULL) — poll until persona_id is actually populated.
    const landed = await waitFor(() => {
      const row = queryOne<{ persona_id: string | null }>('SELECT persona_id FROM tasks WHERE id = ?', [taskId]);
      return row?.persona_id ? row : null;
    });
    assert.equal(landed.persona_id, 'generic-leader', 'legacy single-persona path taken for a non-content task');

    const bundleRow = queryOne<{ id: string }>('SELECT id FROM task_persona_bundle WHERE task_id = ?', [taskId]);
    assert.equal(bundleRow, undefined, 'no bundle row for a non-content task — --blend never sent');
  } finally {
    process.env.OPENCLAW_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// D2 — normalizeResolvedAudience / parsePersonaBundle: candidate OBJECTS →
// label strings (pure, no spawn). Shapes below mirror a LIVE
// persona_blend.py resolve_audience() run verbatim (source: persona_blend.py
// `_candidate()` — {label, audience_persona_id, matched_tags, why?}).
// ═══════════════════════════════════════════════════════════════════════════

test('[D2] parsePersonaBundle: candidate OBJECTS (the real matcher shape) map to label strings, not []', () => {
  const raw = {
    confirm_required: true,
    resolved_audience: {
      source: 'asked',
      candidates: [
        {
          label: 'busy solo real estate agents',
          audience_persona_id: 'realtor-voice',
          matched_tags: ['real estate agents'],
          why: "Audience voice for 'busy solo real estate agents': its audiences[] match on ['agents', 'estate', 'real'] (3 signal(s)); usable_as includes 'audience'.",
        },
        { label: 'first-time home buyers', audience_persona_id: null, matched_tags: [] },
      ],
      confidence: 'medium',
      label: 'busy solo real estate agents',
      ask: 'What audience are we dealing with? Known from onboarding: "busy solo real estate agents"; "first-time home buyers".',
    },
    voice: { audience_persona: null, topic_persona: { id: 'walker-launch' }, collapsed: false },
    blend_directive: 'draft',
  };
  const b = parsePersonaBundle(raw);
  assert.ok(b);
  assert.deepEqual(
    b!.resolved_audience!.candidates,
    ['busy solo real estate agents', 'first-time home buyers'],
    'BEFORE the fix this was always [] (typeof c === "string" filtered out every object)',
  );
});

test('[D2] parsePersonaBundle: bare-string candidates still work (back-compat / non-breaking)', () => {
  const raw = {
    confirm_required: true,
    resolved_audience: { source: 'onboarding_icp', candidates: ['Founders', 'RevOps leads'], confidence: 'high' },
    voice: { collapsed: false },
    blend_directive: 'draft',
  };
  const b = parsePersonaBundle(raw);
  assert.deepEqual(b!.resolved_audience!.candidates, ['Founders', 'RevOps leads']);
});

test('[D2] parsePersonaBundle: mixed string+object candidates both parse; a labelless object is dropped', () => {
  const raw = {
    confirm_required: true,
    resolved_audience: {
      source: 'asked',
      candidates: ['Plain String Audience', { label: 'Object Audience', audience_persona_id: null, matched_tags: [] }, { audience_persona_id: 'x', matched_tags: [] }, { label: '   ' }],
      confidence: 'none',
    },
    voice: { collapsed: false },
    blend_directive: 'draft',
  };
  const b = parsePersonaBundle(raw);
  assert.deepEqual(b!.resolved_audience!.candidates, ['Plain String Audience', 'Object Audience'], 'labelless / blank-label entries are dropped, not crashed on');
});

// ═══════════════════════════════════════════════════════════════════════════
// D4 — confidence string→number mapping (pure, no spawn)
// ═══════════════════════════════════════════════════════════════════════════

test('[D4] parsePersonaBundle: confidence "high"→0.9, "medium"→0.6, "none"→0', () => {
  const mk = (confidence: unknown) => parsePersonaBundle({
    confirm_required: true,
    resolved_audience: { source: 'asked', candidates: [], confidence },
    voice: { collapsed: false },
    blend_directive: 'draft',
  });
  assert.equal(mk('high')!.resolved_audience!.confidence, 0.9);
  assert.equal(mk('medium')!.resolved_audience!.confidence, 0.6);
  assert.equal(mk('none')!.resolved_audience!.confidence, 0);
});

test('[D4] parsePersonaBundle: numeric confidence passthrough is preserved (fixture / future-numeric-matcher shape)', () => {
  const b = parsePersonaBundle({
    confirm_required: true,
    resolved_audience: { source: 'asked', candidates: [], confidence: 0.42 },
    voice: { collapsed: false },
    blend_directive: 'draft',
  });
  assert.equal(b!.resolved_audience!.confidence, 0.42);
});

test('[D4] parsePersonaBundle: unrecognized confidence string (typo / future value) degrades to 0, never throws', () => {
  const b = parsePersonaBundle({
    confirm_required: true,
    resolved_audience: { source: 'asked', candidates: [], confidence: 'super-high' },
    voice: { collapsed: false },
    blend_directive: 'draft',
  });
  assert.equal(b!.resolved_audience!.confidence, 0);
});

test('[D4] AUDIENCE_HIGH_CONFIDENCE branch is reachable end to end: a live "high" bundle triggers the CONFIRM prompt, not the open ASK', async () => {
  const id = nextId('d4-gate');
  insertTask(id);
  persistPersonaBundle(id, bundle({
    confirm_required: true,
    resolved_audience: { source: 'onboarding_icp', candidates: ['Founders'], confidence: 0.9, label: 'Founders', id: null },
  }));
  const g = evaluateAudienceConfirmGate(id);
  assert.equal(g.hold, true);
  assert.ok(g.prompt && /Confirm the audience/.test(g.prompt), 'D4: 0.9 (mapped from "high") clears AUDIENCE_HIGH_CONFIDENCE=0.75 → CONFIRM prompt, not the open ask');
});

// ═══════════════════════════════════════════════════════════════════════════
// D3 — rescoreAudienceBlend (tasks.ts): confirm → re-run --blend with the
// confirmed audience → persist the re-scored bundle. Fixture-based (this
// function's OWN logic is under test, not the argv wiring — already proven
// above via real spawns).
// ═══════════════════════════════════════════════════════════════════════════

test('[D3] rescoreAudienceBlend: a bundle-carrying result is persisted + broadcast; rescored:true', async () => {
  const id = nextId('d3-rescore');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true })); // pre-confirm state

  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'realtor-voice',
    persona_name: 'Realtor Voice',
    score: 2.5,
    interaction_mode: 'leadership',
    confirm_required: false,
    resolved_audience: {
      source: 'operator_confirmed',
      candidates: [{ label: 'busy solo real estate agents', audience_persona_id: 'realtor-voice', matched_tags: ['real estate agents'] }],
      confidence: 'high',
      label: 'busy solo real estate agents',
    },
    voice: {
      audience_persona: { id: 'realtor-voice', why: 'confirmed audience voice' },
      topic_persona: { id: 'walker-launch', why: 'topic match' },
      collapsed: false,
      topic_as_task_guidance: true,
    },
    blend_directive: 'Write in the confirmed realtor-voice audience voice; carry Walker Launch topic expertise.',
    task_personas: [{ seq: 1, part: 'the job', persona_id: 'walker-launch' }],
    catalog_version: '1.3',
  });

  let out: { rescored: boolean; bundle: import('../../src/lib/types').PersonaBundle | null };
  try {
    out = await rescoreAudienceBlend(id, 'Draft the launch emails', 'marketing', 'busy solo real estate agents');
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }

  assert.equal(out.rescored, true);
  assert.ok(out.bundle);
  assert.deepEqual(out.bundle!.resolved_audience!.candidates, ['busy solo real estate agents']);
  assert.equal(out.bundle!.resolved_audience!.confidence, 0.9, 'D4 mapping also holds through the rescore path');

  const mirror = queryOne<{ voice_persona_id: string | null; blend_directive: string | null }>(
    'SELECT voice_persona_id, blend_directive FROM tasks WHERE id = ?', [id],
  );
  assert.equal(mirror?.voice_persona_id, 'realtor-voice', 'the re-scored voice actually landed on the row');
  assert.ok(mirror?.blend_directive?.includes('confirmed realtor-voice'));
});

test('[D3] rescoreAudienceBlend: a non-bundle result is non-fatal (rescored:false); the prior confirm mirror is untouched', async () => {
  const id = nextId('d3-rescore-noop');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true }));
  confirmTaskAudience(id, { audienceLabel: 'Founders' }); // simulate the confirm step already ran

  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({ persona_id: 'x', persona_name: 'X', score: 1, interaction_mode: 'leadership' });
  let out: { rescored: boolean; bundle: unknown };
  try {
    out = await rescoreAudienceBlend(id, 'Draft the launch emails', 'marketing', 'Founders');
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }
  assert.equal(out.rescored, false);
  assert.equal(out.bundle, null);

  const mirror = queryOne<{ audience_label: string | null; audience_source: string | null }>(
    'SELECT audience_label, audience_source FROM tasks WHERE id = ?', [id],
  );
  assert.equal(mirror?.audience_label, 'Founders', 'confirm mirror stands untouched — never-naked');
  assert.equal(mirror?.audience_source, 'operator_confirmed');
});

// ═══════════════════════════════════════════════════════════════════════════
// D3 — POST/GET /api/tasks/[id]/audience: the missing caller for
// confirmTaskAudience. Node-level route test (established pattern — see
// task-status-transition.test.ts): construct a real NextRequest, invoke the
// exported handler directly.
// ═══════════════════════════════════════════════════════════════════════════

function audienceRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/${id}/audience`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('[D3] GET /api/tasks/[id]/audience: unknown task → 404', async () => {
  const res = await audienceGET(new NextRequest('http://localhost/api/tasks/does-not-exist/audience'), {
    params: Promise.resolve({ id: 'does-not-exist' }),
  });
  assert.equal(res.status, 404);
});

test('[D3] GET /api/tasks/[id]/audience: no bundle → hold:false, state:no_bundle', async () => {
  const id = nextId('route-nobundle');
  insertTask(id);
  const res = await audienceGET(new NextRequest(`http://localhost/api/tasks/${id}/audience`), {
    params: Promise.resolve({ id }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.hold, false);
  assert.equal(body.state, 'no_bundle');
});

test('[D3] GET /api/tasks/[id]/audience: pending bundle → hold:true with candidates + prompt for the Kanban panel', async () => {
  const id = nextId('route-pending');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true }));
  const res = await audienceGET(new NextRequest(`http://localhost/api/tasks/${id}/audience`), {
    params: Promise.resolve({ id }),
  });
  const body = await res.json();
  assert.equal(body.hold, true);
  assert.equal(body.state, 'pending');
  assert.deepEqual(body.candidates, ['Founders', 'RevOps leads']);
  assert.ok(body.prompt);
});

test('[D3] POST /api/tasks/[id]/audience: missing audienceLabel → 400', async () => {
  const id = nextId('route-400');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true }));
  const res = await audiencePOST(audienceRequest(id, {}), { params: Promise.resolve({ id }) });
  assert.equal(res.status, 400);
});

test('[D3] POST /api/tasks/[id]/audience: task with no bundle → 409 (nothing to confirm)', async () => {
  const id = nextId('route-409');
  insertTask(id);
  const res = await audiencePOST(audienceRequest(id, { audienceLabel: 'Founders' }), { params: Promise.resolve({ id }) });
  assert.equal(res.status, 409);
});

test('[D3] POST /api/tasks/[id]/audience: unknown task → 404', async () => {
  const res = await audiencePOST(audienceRequest('nope', { audienceLabel: 'Founders' }), {
    params: Promise.resolve({ id: 'nope' }),
  });
  assert.equal(res.status, 404);
});

test('[D3] POST /api/tasks/[id]/audience: valid confirm on a pending task → 200, confirms + re-scores; GET afterward shows hold:false', async () => {
  const id = nextId('route-confirm');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true }));

  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'ogilvy-on-advertising',
    persona_name: 'Ogilvy',
    score: 2.0,
    interaction_mode: 'leadership',
    confirm_required: false,
    resolved_audience: { source: 'operator_confirmed', candidates: [{ label: 'Founders', audience_persona_id: null, matched_tags: [] }], confidence: 'high', label: 'Founders' },
    voice: { audience_persona: { id: 'ogilvy-on-advertising' }, topic_persona: { id: 'ogilvy-on-advertising' }, collapsed: true, collapsed_persona_id: 'ogilvy-on-advertising' },
    blend_directive: 'Write as Ogilvy for Founders.',
    task_personas: [],
  });

  let res;
  try {
    res = await audiencePOST(audienceRequest(id, { audienceLabel: 'Founders' }), { params: Promise.resolve({ id }) });
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.rescored, true);
  assert.equal(body.task.audience_label, 'Founders');
  assert.equal(body.task.audience_source, 'operator_confirmed');

  const after = await audienceGET(new NextRequest(`http://localhost/api/tasks/${id}/audience`), {
    params: Promise.resolve({ id }),
  });
  const afterBody = await after.json();
  assert.equal(afterBody.hold, false, 'the write is released the instant confirmTaskAudience lands');
  assert.equal(afterBody.state, 'confirmed');
});

test('[D3] POST /api/tasks/[id]/audience: never-naked — confirm applies even when the re-score fails', async () => {
  const id = nextId('route-rescore-fail');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true }));

  // No PERSONA_FIXTURE_JSON and OPENCLAW_ROOT stays /nonexistent — the
  // re-score spawn will fail to find the script and resolve to null.
  const res = await audiencePOST(audienceRequest(id, { audienceLabel: 'RevOps leads' }), { params: Promise.resolve({ id }) });

  assert.equal(res.status, 200, 'the confirm itself must NEVER fail because the re-score failed');
  const body = await res.json();
  assert.equal(body.rescored, false);
  assert.equal(body.task.audience_label, 'RevOps leads', 'the confirm mirror still landed');

  const gate = await audienceGET(new NextRequest(`http://localhost/api/tasks/${id}/audience`), { params: Promise.resolve({ id }) });
  const gateBody = await gate.json();
  assert.equal(gateBody.hold, false, 'the task is released regardless of the re-score outcome — never a NEW 30-min stall');
});

// ═══════════════════════════════════════════════════════════════════════════
// D3 — TaskModal.tsx / AudienceConfirmPanel.tsx wiring (source-level check,
// same convention as the PRD 1.6 "void (async ())" wiring test — this repo
// has no React Testing Library harness for TaskModal).
// ═══════════════════════════════════════════════════════════════════════════

test('[D3] TaskModal.tsx renders AudienceConfirmPanel, gated on task.blend_directive', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'TaskModal.tsx'), 'utf-8');
  assert.ok(src.includes("import { AudienceConfirmPanel } from './AudienceConfirmPanel'"), 'TaskModal must import the panel');
  assert.ok(src.includes('task.blend_directive'), 'must gate the mount on the cheap blend_directive presence check');
  assert.ok(src.includes('<AudienceConfirmPanel'), 'must actually render the panel');
});

test('[D3] AudienceConfirmPanel.tsx POSTs to /api/tasks/[id]/audience and GETs the gate status', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'AudienceConfirmPanel.tsx'), 'utf-8');
  assert.ok(src.includes('/audience`'), 'must call the audience route');
  assert.ok(/method:\s*['"]POST['"]/.test(src), 'must POST the confirm');
  assert.ok(src.includes('audienceLabel'), 'must send audienceLabel in the confirm body');
});

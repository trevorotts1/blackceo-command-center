/**
 * sop-research-provider-layer.test.ts
 *
 * OPERATOR DECISION: Tavily must not be REQUIRED anywhere.
 *
 * Both SOP authoring paths used to call `tavilySearch()` directly and document
 * it as a "Tier-1 mandate", so a box with no Tavily key could not author a SOP
 * at all. `src/lib/research/` already had a provider layer these two callers
 * never used. They now go through `researchForSop()`, preference
 * ollama → perplexity → tavily, overridable with `RESEARCH_PROVIDER_ORDER`.
 *
 * Proven here:
 *   (a) with only an Ollama Cloud key, the search runs through the ollama provider;
 *   (b) with NO provider at all, the SOP is still authored and carries the
 *       "no research available" line instead of sources;
 *   (c) a Tavily-only box still works, through the layer.
 *
 * No network: every provider call is fixture-backed, and the no-provider case
 * reaches no provider by construction.
 *
 *   node --import tsx --test tests/unit/sop-research-provider-layer.test.ts
 */

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

const FIXTURES = path.resolve(process.cwd(), 'scripts/fixtures');

// A workspace on disk so the authored SOP can be written and read back.
const TMP_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-research-ws-'));
fs.writeFileSync(path.join(TMP_WORKSPACE, 'SOUL.md'), '# Soul\nDirect, quality-first.');
fs.writeFileSync(path.join(TMP_WORKSPACE, 'USER.md'), '# User\nFounder.');
process.env.OPENCLAW_WORKSPACE_PATH = TMP_WORKSPACE;
process.env.SOP_AUTO_REPLACE_TELEGRAM_DISABLED = '1';
process.env.GEMINI_FIXTURE_JSON_PATH = path.join(FIXTURES, 'gemini-sop-authoring-sample.json');
process.env.QC_FIXTURE_JSON_PATH = path.join(FIXTURES, 'qc-pass-sample.json');

import { getDb, run, queryOne, autoSeedTrioAgents } from '../../src/lib/db';
import { researchForSop, researchProviderOrder, NO_RESEARCH_SOURCE_LINE } from '../../src/lib/research/sop-research';
import { authorSOPForTask } from '../../src/lib/sop-authoring';
import { groundDraftedSOP } from '../../src/lib/sop-auto-replace';

const PROVIDER_ENV = [
  'OLLAMA_FIXTURE_JSON_PATH', 'PERPLEXITY_FIXTURE_JSON_PATH', 'TAVILY_FIXTURE_JSON_PATH',
  'OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY', 'PERPLEXITY_API_KEY', 'PPLX_API_KEY',
  'TAVILY_API_KEY', 'OPENAI_API_KEY', 'X_AI_API_KEY', 'XAI_API_KEY',
  'RESEARCH_PROVIDER_ORDER', 'OPENCLAW_PROJECT_DIR', 'HOME', 'OPENCLAW_PLATFORM',
];

/**
 * Run `fn` with EXACTLY the given provider environment and nothing else.
 *
 * The OpenClaw secret stores are pointed at an empty scratch home, because a
 * developer box genuinely has these keys in `~/.openclaw/secrets/.env` and the
 * layer reads them — so without this, "only an Ollama key" would silently be
 * "an Ollama key and every other key this machine owns", and a live billed
 * call could escape.
 */
async function withProviders(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of PROVIDER_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-research-home-'));
  process.env.HOME = emptyHome;
  process.env.OPENCLAW_PLATFORM = 'mac-mini';
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    await fn();
  } finally {
    for (const k of PROVIDER_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
}

/** Seed a custom-department workspace + task the authoring loop can run on. */
function seedTask(label: string): { taskId: string; wsId: string; dept: string } {
  const dept = `widget-${label}-custom`;
  const wsId = `${dept}-${uuidv4()}`;
  const taskId = uuidv4();
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1200)', [wsId, `Widget ${label}`, dept]);
  autoSeedTrioAgents(getDb());
  run('INSERT INTO tasks (id, title, workspace_id, status) VALUES (?, ?, ?, ?)', [
    taskId, `Build a ${label} widget`, wsId, 'backlog',
  ]);
  return { taskId, wsId, dept };
}

// ── The preference order ───────────────────────────────────────────────────

test('the default order is ollama → perplexity → tavily, and RESEARCH_PROVIDER_ORDER overrides it', async () => {
  await withProviders({}, async () => {
    assert.deepEqual(researchProviderOrder(), ['ollama', 'perplexity', 'tavily']);
  });
  await withProviders({ RESEARCH_PROVIDER_ORDER: 'tavily, perplexity' }, async () => {
    assert.deepEqual(researchProviderOrder(), ['tavily', 'perplexity']);
  });
  // A blank override is not an order — fall back rather than resolve nothing.
  await withProviders({ RESEARCH_PROVIDER_ORDER: '  ' }, async () => {
    assert.deepEqual(researchProviderOrder(), ['ollama', 'perplexity', 'tavily']);
  });
});

// ── (a) Ollama Cloud only ──────────────────────────────────────────────────

test('(a) with only an Ollama Cloud provider, the search runs through ollama', async () => {
  await withProviders({ OLLAMA_FIXTURE_JSON_PATH: path.join(FIXTURES, 'ollama-research-sample.json') }, async () => {
    const result = await researchForSop('widget forging best practices 2026');
    assert.equal(result.provider, 'ollama');
    assert.ok(result.results.length > 0, 'ollama citations become research results');
    assert.match(result.results[0].url, /^https:\/\//);
    assert.ok((result.answer || '').length > 0, 'the answer carries the substance for synthesis');
  });
});

// ── (c) Tavily only, through the layer ─────────────────────────────────────

test('(c) a Tavily-only box still researches, through the layer', async () => {
  await withProviders({ TAVILY_FIXTURE_JSON_PATH: path.join(FIXTURES, 'tavily-sample.json') }, async () => {
    const result = await researchForSop('cold email best practices');
    assert.equal(result.provider, 'tavily');
    assert.ok(result.results.length > 0);
    assert.ok(result.results.some((r) => (r.snippet || '').length > 0), 'tavily extracts survive as snippets');
  });
});

test('tavily is reached even when it is last in the order and the others have nothing', async () => {
  await withProviders({
    RESEARCH_PROVIDER_ORDER: 'ollama,perplexity,tavily',
    TAVILY_FIXTURE_JSON_PATH: path.join(FIXTURES, 'tavily-sample.json'),
  }, async () => {
    assert.equal((await researchForSop('x')).provider, 'tavily');
  });
});

// ── (b) No provider at all ─────────────────────────────────────────────────

test('(b) with NO provider, the search reports none rather than throwing', async () => {
  await withProviders({}, async () => {
    const result = await researchForSop('anything at all');
    assert.equal(result.provider, null, 'no provider is a reported state, not an error');
    assert.deepEqual(result.results, []);
  });
});

test('(b) with NO provider, the SOP is still authored and says it has no research', async () => {
  const { taskId, wsId, dept } = seedTask('unresearched');
  let result: Awaited<ReturnType<typeof authorSOPForTask>> | undefined;
  await withProviders({}, async () => {
    result = await authorSOPForTask({
      originalTaskId: taskId,
      title: 'Build a unresearched widget',
      description: null,
      department: dept,
      agentRoleSlug: null,
      workspaceId: wsId,
    });
  });

  assert.equal(result!.status, 'authored', `a research-less box must still author; got ${result!.status} (${result!.reason ?? ''})`);

  const sop = queryOne<{ steps: string }>('SELECT steps FROM sops WHERE id = ?', [result!.sop_id!]);
  assert.ok(sop, 'a real sops row was written');

  // The honest line rides on the proposal's recorded sources and on the SOP file.
  const proposal = queryOne<{ research_sources: string | null }>(
    'SELECT research_sources FROM sop_proposals WHERE id = ?', [result!.proposal_id!],
  );
  assert.ok(proposal, 'a proposal row was written');
  assert.match(proposal!.research_sources || '', new RegExp(NO_RESEARCH_SOURCE_LINE));

  const onDisk = fs.readdirSync(TMP_WORKSPACE, { recursive: true }) as string[];
  const howTo = onDisk.find((f) => String(f).endsWith('how-to.md'));
  if (howTo) {
    const md = fs.readFileSync(path.join(TMP_WORKSPACE, String(howTo)), 'utf8');
    assert.match(md, /## Research Sources/);
    assert.match(md, new RegExp(NO_RESEARCH_SOURCE_LINE));
    assert.ok(!/\]\(\)/.test(md), 'the no-research line is plain text, never an empty link');
  }
});

// ── The grounding gate must not condemn a research-less box ────────────────

test('grounding blocks an EMPTY research result, but not an ABSENT research provider', () => {
  const drafted = {
    steps: [{ name: 'Do the thing', checklist: ['a', 'b'], success_criteria: 'done' }],
    success_criteria: 'done',
    confidence: 0.9,
  };
  // Provider answered with nothing: that IS a fault, still blocked.
  assert.equal(groundDraftedSOP(drafted, []).grounded, false);
  // No provider exists on this box: nothing to anchor against, so the two
  // corpus-dependent blocks are skipped and the draft can be filed.
  const noProvider = groundDraftedSOP(drafted, [], { researchUnavailable: true });
  assert.equal(noProvider.grounded, true);
  assert.match(noProvider.reason, /no research provider on this box/);
  // The confidence floor still bites — the escape is scoped, not a bypass.
  assert.equal(groundDraftedSOP({ ...drafted, confidence: 0.1 }, [], { researchUnavailable: true }).grounded, false);
  assert.equal(groundDraftedSOP({ ...drafted, steps: [] }, [], { researchUnavailable: true }).grounded, false);
});

// ── The callers no longer import Tavily directly ───────────────────────────

test('neither SOP caller imports @/lib/tavily any more', () => {
  for (const f of ['src/lib/sop-authoring.ts', 'src/lib/sop-auto-replace.ts']) {
    const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
    assert.ok(!src.includes("from '@/lib/tavily'"), `${f} must reach Tavily through the research layer`);
    assert.match(src, /from '@\/lib\/research\/sop-research'/);
  }
});

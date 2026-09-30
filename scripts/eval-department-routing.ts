/**
 * JEV-502 — measure Command Center's department pickers on a labeled fixture.
 *
 *   npx tsx scripts/eval-department-routing.ts --onboarding <openclaw-onboarding clone> [--record]
 *
 * Pickers (src/lib/routing/department-router.ts pickDepartment):
 *   jev      — the onboarding decision engine's lexical route (shared-utils/decision-engine.py
 *              --evaluate), called through CC's real live.ts bridge with CC's real catalog.
 *   semantic — CC's meaning-based router (embedding cosine vs each department), using whatever
 *              provider the env selects: SOP_EMBEDDING_PROVIDER=ollama (+ SOP_EMBEDDING_OLLAMA_URL)
 *              for local, or a Google/OpenAI key. No provider → reported as unavailable.
 *   keyword  — CC's keyword scorer.
 * The catalog is the standard floor seeded exactly as onboarding's seed-workspaces.py does
 * ("<Name> department workspace"), then read back through the real loadDepartments().
 *
 * Scoring per case: strict = pick is the labeled department or an acceptable alternate;
 * lenient = strict OR the pick is General Task (the safe catch-all). Any other department,
 * the CEO lane included, is WRONG.
 *
 * --record writes tests/unit/fixtures/jev502-department-routing-recording.json (the embedding
 * vectors and JEV picks this run saw), which the accuracy unit test replays offline.
 * Requires the ollama provider (the recording captures /api/embed traffic).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

export interface Case { m: string; d: string; alt: string[] }
export type PickerName = 'semantic' | 'jev' | 'keyword';

const ROOT = path.resolve(__dirname, '..');
export const FIXTURE_PATH = path.join(ROOT, 'scripts', 'eval-department-routing.fixture.json');
export const RECORDING_PATH = path.join(ROOT, 'tests', 'unit', 'fixtures', 'jev502-department-routing-recording.json');
export const EVAL_COMPANY = 'jev502-eval';

export function loadFixture(): { catalog: [string, string][]; cases: Case[] } {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

/** Mirror of onboarding 32-command-center-setup/scripts/seed-workspaces.py's INSERT. */
export function seedFloorWorkspaces(db: Database.Database, catalog: [string, string][]): void {
  db.prepare("INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, ?, ?)").run(EVAL_COMPANY, 'JEV-502 Eval', EVAL_COMPANY);
  const ins = db.prepare('INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [slug, name] of catalog) ins.run(slug, name, slug, `${name} department workspace`, '📁', EVAL_COMPANY);
}

export const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

/** One picker run standalone: its confident pick, else the department it leaned to when unsure. */
export interface Standalone { gated: string | null; lean: string | null; confidence: number }

/** v7.6.89 behaviour for comparison: any non-fallback decision-engine pick, then semantic (floor → General Task) on a keyed provider, else keyword (v7.6.89 skipped semantic on local Ollama). */
export function composeBefore(s: Record<PickerName, Standalone[]>, semanticAvailable: boolean): (string | null)[] {
  return s.jev.map((j, i) => j.lean ?? (semanticAvailable ? s.semantic[i].gated : s.keyword[i].lean));
}

export interface Score { n: number; strict: number; lenient: number; general: number; wrong: { m: string; want: string; got: string }[] }

export function score(cases: Case[], picks: (string | null)[]): Score {
  let strict = 0; let lenient = 0; let general = 0;
  const wrong: Score['wrong'] = [];
  cases.forEach((c, i) => {
    const got = picks[i] ?? 'general-task';
    const ok = got === c.d || c.alt.includes(got);
    if (got === 'general-task') general++;
    if (ok) strict++;
    if (ok || got === 'general-task') lenient++;
    else wrong.push({ m: c.m, want: c.d, got });
  });
  return { n: cases.length, strict: strict / cases.length, lenient: lenient / cases.length, general: general / cases.length, wrong };
}

// int8 per-vector quantization keeps the replay recording small; cosine error is ~1e-3.
export function quantize(v: number[]): { s: number; q: string } {
  const s = Math.max(...v.map(Math.abs)) || 1;
  return { s, q: Buffer.from(Int8Array.from(v.map((x) => Math.round((x / s) * 127)))).toString('base64') };
}
export function dequantize(e: { s: number; q: string }): number[] {
  return Array.from(new Int8Array(Buffer.from(e.q, 'base64'))).map((x) => (x / 127) * e.s);
}

async function main(): Promise<void> {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const onboarding = arg('--onboarding');
  const record = process.argv.includes('--record');
  const core = onboarding && path.join(path.resolve(onboarding), 'shared-utils', 'decision-engine.py');
  if (!core || !fs.existsSync(core)) {
    console.error('usage: npx tsx scripts/eval-department-routing.ts --onboarding <openclaw-onboarding clone> [--record]');
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev502-eval-'));
  Object.assign(process.env, {
    DATABASE_PATH: path.join(tmp, 'eval.db'), CC_TEST_FIXTURE_ROOT: tmp, OPENCLAW_ROOT: path.join(tmp, 'oc'),
    OC_CONFIG: path.join(tmp, 'oc'), DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
    OWNER_NOTIFY_TELEGRAM_DISABLED: '1', DECISION_ENGINE_CORE_PATH: core, DECISION_ENGINE_MODE: process.env.DECISION_ENGINE_MODE || 'auto',
  });

  // Capture embedding traffic for --record (ollama wire: POST /api/embed {input} → {embeddings}).
  const vectors: Record<string, { s: number; q: string }> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const res = await realFetch(url, init);
    if (String(url).endsWith('/api/embed') && res.ok) {
      const body = await res.clone().json() as { embeddings?: number[][] };
      const input = JSON.parse(String(init?.body)).input;
      if (typeof input === 'string' && body.embeddings?.[0]) vectors[sha1(input)] = quantize(body.embeddings[0]);
    }
    return res;
  }) as typeof fetch;

  const { getDb } = await import('../src/lib/db');
  const { loadDepartments } = await import('../src/lib/routing/departments.config');
  const { pickDepartment, DEPARTMENT_PICKER_ORDER } = await import('../src/lib/routing/department-router');
  const { canonicalDeptSlug } = await import('../src/lib/routing/canonical-slug');
  const { resolveEmbeddingProvider, isEmbeddingAvailable } = await import('../src/lib/sop-embeddings');

  const { catalog, cases } = loadFixture();
  seedFloorWorkspaces(getDb(), catalog);
  const departments = loadDepartments(EVAL_COMPANY);
  const provider = resolveEmbeddingProvider();

  const slugOf = (d?: { slug?: string; id: string } | null) => (d ? canonicalDeptSlug(d.slug || d.id) : null);
  const standalone: Record<PickerName, Standalone[]> = { semantic: [], jev: [], keyword: [] };
  const chosen: (string | null)[] = [];
  for (const c of cases) {
    for (const p of ['semantic', 'jev', 'keyword'] as PickerName[]) {
      const r = await pickDepartment({ title: c.m }, departments, { order: [p] });
      standalone[p].push({ gated: slugOf(r.department), lean: slugOf(r.department ?? r.candidate), confidence: r.confidence });
    }
    chosen.push(slugOf((await pickDepartment({ title: c.m }, departments)).department));
  }
  const semanticAvailable = standalone.semantic.some((x) => x.lean);
  const jevAvailable = standalone.jev.some((x) => x.lean);

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const line = (label: string, sc: Score) =>
    console.log(`${label.padEnd(48)} acceptable-or-GT ${pct(sc.lenient).padStart(6)}  strict ${pct(sc.strict).padStart(6)}  general-task ${pct(sc.general).padStart(6)}  wrong ${sc.wrong.length}`);
  console.log(`fixture ${cases.length} cases · catalog ${departments.length} departments · embeddings ${provider.name}${provider.model ? ` (${provider.model})` : ''}${semanticAvailable ? '' : ' UNAVAILABLE'} · decision engine ${jevAvailable ? 'on' : 'OFF/UNAVAILABLE'} · MIN_ROUTING_CONFIDENCE ${process.env.MIN_ROUTING_CONFIDENCE ?? 'provider default'}`);
  line('before: v7.6.89 order', score(cases, composeBefore(standalone, semanticAvailable && provider.name !== 'ollama')));
  for (const p of ['jev', 'semantic', 'keyword'] as PickerName[]) {
    if (!standalone[p].some((x) => x.lean)) { console.log(`${p} alone: UNAVAILABLE in this environment`); continue; }
    line(`${p} alone, ungated`, score(cases, standalone[p].map((x) => x.lean)));
    line(`${p} alone, gated (unsure → General Task)`, score(cases, standalone[p].map((x) => x.gated)));
  }
  const chosenScore = score(cases, chosen);
  line(`CHOSEN ${DEPARTMENT_PICKER_ORDER.join(' → ')} → general-task`, chosenScore);
  if (process.argv.includes('--verbose')) {
    for (const w of chosenScore.wrong) console.log(`  want ${w.want.padEnd(28)} got ${w.got.padEnd(28)} ${w.m}`);
  }
  const dump = arg('--dump');
  if (dump) fs.writeFileSync(dump, JSON.stringify(cases.map((c, i) => ({ ...c, standalone: Object.fromEntries((['semantic', 'jev', 'keyword'] as PickerName[]).map((p) => [p, standalone[p][i]])), chosen: chosen[i] }))));

  if (record) {
    if (provider.name !== 'ollama' || !semanticAvailable) throw new Error('--record needs SOP_EMBEDDING_PROVIDER=ollama with a reachable endpoint');
    // Raw engine route per message: department null = the engine reported fallback=true.
    const jev: Record<string, { department: string | null; confidence: number }> = {};
    cases.forEach((c, i) => { jev[c.m] = { department: standalone.jev[i].lean, confidence: standalone.jev[i].confidence }; });
    fs.mkdirSync(path.dirname(RECORDING_PATH), { recursive: true });
    fs.writeFileSync(RECORDING_PATH, JSON.stringify({
      _doc: 'Written by scripts/eval-department-routing.ts --record. Replayed by tests/unit/jev502-department-picker-accuracy.test.ts. Re-record when the fixture, the floor catalog or department embed text changes.',
      model: provider.model, dims: provider.dims, jev, vectors,
    }) + '\n');
    console.log(`recorded ${Object.keys(vectors).length} vectors + ${cases.length} JEV picks → ${path.relative(ROOT, RECORDING_PATH)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (require.main === module) {
  main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
}

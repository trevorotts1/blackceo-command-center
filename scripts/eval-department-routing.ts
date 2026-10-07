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

/**
 * Replay key of a model-pick request: the TASK line only. int8-quantized vectors can reorder near-tied
 * candidate departments, so the offline replay answers by task rather than by the exact candidate list
 * (a reply naming a department the replay did not offer simply does not match, i.e. General Task).
 */
export function chatTaskKey(body: string): string {
  const user = (JSON.parse(body).messages as { role: string; content: string }[]).find((m) => m.role === 'user')?.content ?? '';
  return sha1(user.split('\n')[0]);
}

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

/**
 * Trevor's three numbers (2026-10-07): (a) correct department on department-labeled cases,
 * (b) General-labeled cases sent to General (or an acceptable alternate), (c) wrong, split by
 * type. `wrongDept` is the strict old "wrong" (a task in a department it does not belong to).
 */
export interface Score3 {
  deptN: number; generalN: number;
  a: number; b: number;
  deptToWrongDept: number; deptToGeneral: number; generalToDept: number;
  total: number; wrongDept: number; generalPct: number;
}
export function score3(cases: Case[], picks: (string | null)[]): Score3 {
  let deptN = 0; let generalN = 0; let a = 0; let b = 0; let d2w = 0; let d2g = 0; let g2d = 0; let gt = 0;
  cases.forEach((c, i) => {
    const got = picks[i] ?? 'general-task';
    const ok = got === c.d || c.alt.includes(got);
    if (got === 'general-task') gt++;
    if (c.d === 'general-task') {
      generalN++;
      if (ok) b++; else g2d++;
    } else {
      deptN++;
      if (ok) a++; else if (got === 'general-task') d2g++; else d2w++;
    }
  });
  return { deptN, generalN, a: a / deptN, b: b / generalN, deptToWrongDept: d2w, deptToGeneral: d2g, generalToDept: g2d, total: d2w + d2g + g2d, wrongDept: d2w + g2d, generalPct: gt / cases.length };
}

export interface SopRecord { id: string; name: string; department: string | null; task_keywords: string | null; s: number; q: string }

/** Seed SOP rows + their vectors (int8-quantized records or live rows) into an isolated DB. */
export function seedSops(db: Database.Database, sops: { id: string; name: string; slug?: string; department: string | null; task_keywords: string | null; vec: Float32Array }[], model: string, dims: number): void {
  const ins = db.prepare("INSERT OR IGNORE INTO sops (id, name, slug, department, task_keywords, steps) VALUES (?, ?, ?, ?, ?, '[]')");
  const emb = db.prepare("INSERT OR REPLACE INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare('DELETE FROM sops').run(); // the isolated DB's auto-seeded starter SOPs would collide on slug
    for (const r of sops) {
      ins.run(r.id, r.name, r.slug ?? `eval-${r.id}`, r.department, r.task_keywords);
      emb.run(r.id, Buffer.from(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength), model, dims);
    }
  })();
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
  const chats: Record<string, string> = {};
  const realFetch = globalThis.fetch;
  const cacheFile = process.env.EVAL_CHAT_CACHE;
  const chatCache: Record<string, string> = cacheFile && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  // Paid-Gemini embeddings (Ollama-down measurement) are cached by request body so a sweep never re-pays for a query.
  const embedFile = process.env.EVAL_EMBED_CACHE;
  const embedCache: Record<string, unknown> = embedFile && fs.existsSync(embedFile) ? JSON.parse(fs.readFileSync(embedFile, 'utf8')) : {};
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (embedFile && String(url).includes(':embedContent')) {
      const k = sha1(String(init?.body));
      if (embedCache[k]) return new Response(JSON.stringify(embedCache[k]), { status: 200 });
      const r = await realFetch(url, init);
      if (r.ok) { embedCache[k] = await r.clone().json(); fs.writeFileSync(embedFile, JSON.stringify(embedCache)); }
      return r;
    }
    if (String(url).endsWith('/v1/chat/completions') && chatCache[sha1(String(init?.body))] !== undefined) {
      const content = chatCache[sha1(String(init?.body))];
      chats[chatTaskKey(String(init?.body))] = content;
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }
    const res = await realFetch(url, init);
    if (String(url).endsWith('/api/embed') && res.ok) {
      const body = await res.clone().json() as { embeddings?: number[][] };
      const input = JSON.parse(String(init?.body)).input;
      if (typeof input === 'string' && body.embeddings?.[0]) vectors[sha1(input)] = quantize(body.embeddings[0]);
    }
    if (String(url).endsWith('/v1/chat/completions') && res.ok) {
      const reply = await res.clone().json() as { choices?: { message?: { content?: string } }[] };
      chats[chatTaskKey(String(init?.body))] = reply.choices?.[0]?.message?.content ?? '';
      if (cacheFile) { chatCache[sha1(String(init?.body))] = chats[chatTaskKey(String(init?.body))]; fs.writeFileSync(cacheFile, JSON.stringify(chatCache)); }
    }
    return res;
  }) as typeof fetch;

  const { getDb } = await import('../src/lib/db');
  const { loadDepartments } = await import('../src/lib/routing/departments.config');
  const { pickDepartment, DEPARTMENT_PICKER_ORDER } = await import('../src/lib/routing/department-router');
  const { canonicalDeptSlug } = await import('../src/lib/routing/canonical-slug');
  const { resolveEmbeddingProvider, isEmbeddingAvailable, cosineSimilarity, localEmbedText } = await import('../src/lib/sop-embeddings');

  const { catalog, cases } = loadFixture();
  seedFloorWorkspaces(getDb(), catalog);
  const departments = loadDepartments(EVAL_COMPANY);
  const provider = resolveEmbeddingProvider();

  let steps: { label: string; score: Score3; picks: (string | null)[] }[] = [];
  const sopRecords: Record<string, SopRecord> = {};
  let all: { id: string; name: string; slug: string; department: string | null; task_keywords: string | null; embedding: Buffer; vec: Float32Array }[] = [];
  const sopsDb = arg('--sops');
  if (sopsDb) {
    const BetterSqlite = (await import('better-sqlite3')).default;
    const live = new BetterSqlite(sopsDb, { readonly: true });
    const live_rows = live.prepare(`SELECT s.id, s.name, s.slug, s.department, s.task_keywords, e.embedding FROM sop_embeddings e JOIN sops s ON s.id = e.sop_id
      WHERE s.deleted_at IS NULL AND e.embedding IS NOT NULL AND e.embedding_model = ? AND e.embedding_dims = ?`).all(provider.model, provider.dims) as
      { id: string; name: string; slug: string; department: string | null; task_keywords: string | null; embedding: Buffer }[];
    live.close();
    all = live_rows.map((r) => ({ ...r, vec: new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)) }));
    seedSops(getDb(), all, provider.model, provider.dims);
    const geminiAsset = arg('--gemini-asset'); const sopManifest = arg('--sop-manifest');
    if (geminiAsset && sopManifest) {
      // Ollama-down measurement: the shipped Gemini SOP set goes into the SEPARATE fallback table.
      const { provisionGeminiFallback } = await import('./provision-gemini-fallback-sop-set');
      const r = provisionGeminiFallback(getDb(), JSON.parse(fs.readFileSync(sopManifest, 'utf8')), fs.readFileSync(geminiAsset));
      console.log(`Gemini fallback SOP set: ${r.byId} by id + ${r.bySlug} by slug`);
    }
    console.log(`SOP index: ${all.length} live SOPs seeded from ${path.basename(sopsDb)} (${provider.model} @${provider.dims})`);

  }
  process.env.JEV_SOP_PROFILES = sopsDb ? '1' : '0';

  const slugOf = (d?: { slug?: string; id: string } | null) => (d ? canonicalDeptSlug(d.slug || d.id) : null);
  const standalone: Record<PickerName, Standalone[]> = { semantic: [], jev: [], keyword: [] };
  const chosen: (string | null)[] = [];
  for (const c of cases) {
    for (const p of ['semantic', 'jev', 'keyword'] as PickerName[]) {
      const r = await pickDepartment({ title: c.m }, departments, { order: [p], tail: [] });
      standalone[p].push({ gated: slugOf(r.department), lean: slugOf(r.department ?? r.candidate), confidence: r.confidence });
    }
    chosen.push(slugOf((await pickDepartment({ title: c.m }, departments, { tail: [] })).department));
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

  // ── Routing-accuracy steps (needs the box's SOP index: --sops <mission-control.db>) ──────────────
  if (sopsDb) {
    const modelName = arg('--model');
    const chatUrl = (process.env.EVAL_CHAT_URL || process.env.SOP_EMBEDDING_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '') + '/v1/chat/completions';
    const { authorizedTiebreak } = await import('../src/lib/routing/tiebreak-adapter');
    const seam = modelName
      ? { model: modelName, permissionOverride: true, tiebreak: (req: Parameters<typeof authorizedTiebreak>[0]) => authorizedTiebreak({ ...req, apiKey: 'local', endpoint: chatUrl }) }
      : { model: null as string | null, permissionOverride: false };
    const run = async (tail: ('sop' | 'model')[], useSeam: boolean, profiles = false) => {
      process.env.JEV_SOP_PROFILES = profiles ? '1' : '0';
      const picks: (string | null)[] = [];
      for (const c of cases) picks.push(slugOf((await pickDepartment({ title: c.m }, departments, { tail, ...(useSeam ? { tiebreakSeam: seam } : {}) })).department));
      return picks;
    };
    const record3 = async (label: string, tail: ('sop' | 'model')[], useSeam: boolean, profiles = false) => {
      const picks = await run(tail, useSeam, profiles);
      const sc = score3(cases, picks);
      steps.push({ label, score: sc, picks });
    };
    const sweep = arg('--sweep');
    if (sweep) {
      const { SOP_VOTE, SOP_VOTE_GEMINI } = await import('../src/lib/routing/sop-vote');
      for (const spec of sweep.split(';')) {
        const [k, m, ms, tailS] = spec.split(',');
        Object.assign(SOP_VOTE, { k: Number(k), margin: Number(m), minSim: Number(ms) });
        Object.assign(SOP_VOTE_GEMINI, { k: Number(k), margin: Number(m), minSim: Number(ms) });
        const tail = (tailS || 'sop+model').split('+').filter(Boolean) as ('sop' | 'model')[];
        await record3(`sweep K=${k} margin=${m} minSim=${ms} ${tail.join('+') || 'none'}`, tail, tail.includes('model'), true);
      }
    } else {
    await record3('step 0  JEV -> General (before)', [], false);
    await record3('step 1  + nearest-SOP vote', ['sop'], false);
    if (modelName) await record3(`step 2  + model pick (${modelName})`, ['sop', 'model'], true);
    if (!process.env.EVAL_SKIP_STEP3) {
    await record3('step 3a JEV profiles + SOP vote (no model)', ['sop'], false, true);
    if (modelName) await record3('step 3b JEV profiles + SOP vote + model', ['sop', 'model'], true, true);
    }
    }
    const pc = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6);
    const ref = score3(cases, cases.map((c) => c.d));
    console.log(`\ndept-labeled ${ref.deptN} · General-labeled ${ref.generalN}`);
    console.log('step                                   (a) dept correct  (b) General ok  wrong: dept->otherdept  dept->General  General->dept  total   old wrong(dept)  General%');
    for (const st of steps) {
      const x = st.score;
      console.log(`${st.label.padEnd(38)} ${pc(x.a).padStart(10)}      ${pc(x.b).padStart(8)}          ${String(x.deptToWrongDept).padStart(8)}      ${String(x.deptToGeneral).padStart(10)}    ${String(x.generalToDept).padStart(10)}  ${String(x.total).padStart(6)}  ${String(x.wrongDept).padStart(10)}      ${pc(x.generalPct)}`);
    }
    if (process.argv.includes('--verbose')) {
      const last = steps[steps.length - 1];
      cases.forEach((c, i) => { const got = last.picks[i] ?? 'general-task'; if (!(got === c.d || c.alt.includes(got))) console.log(`  want ${c.d.padEnd(26)} got ${got.padEnd(26)} ${c.m}`); });
    }
    if (record) {
      // Replay recording: only the SOPs that can matter (top-25 per case), so the offline test votes identically.
      const keep = new Set<string>();
      for (const c of cases) {
        const q = vectors[sha1(localEmbedText(c.m, 'query'))];
        if (!q) continue;
        const qv = dequantize(q);
        all.map((r) => ({ id: r.id, sim: cosineSimilarity(qv, r.vec) })).sort((x, y) => y.sim - x.sim).slice(0, 25).forEach((h) => keep.add(h.id));
      }
      for (const r of all) if (keep.has(r.id)) sopRecords[r.id] = { id: r.id, name: r.name, department: r.department, task_keywords: r.task_keywords, ...quantize(Array.from(r.vec)) };
    }
  }

  if (record) {
    if (provider.name !== 'ollama' || !semanticAvailable) throw new Error('--record needs SOP_EMBEDDING_PROVIDER=ollama with a reachable endpoint');
    // Raw engine route per message: department null = the engine reported fallback=true.
    const jev: Record<string, { department: string | null; confidence: number }> = {};
    cases.forEach((c, i) => { jev[c.m] = { department: standalone.jev[i].lean, confidence: standalone.jev[i].confidence }; });
    fs.mkdirSync(path.dirname(RECORDING_PATH), { recursive: true });
    fs.writeFileSync(RECORDING_PATH, JSON.stringify({
      _doc: 'Written by scripts/eval-department-routing.ts --record. Replayed by tests/unit/jev502-department-picker-accuracy.test.ts. Re-record when the fixture, the floor catalog or department embed text changes.',
      model: provider.model, dims: provider.dims, jev, vectors, sops: sopRecords, chats,
    }) + '\n');
    console.log(`recorded ${Object.keys(vectors).length} vectors + ${cases.length} JEV picks → ${path.relative(ROOT, RECORDING_PATH)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (require.main === module) {
  main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
}

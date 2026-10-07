/**
 * Unit tests — SOP_EMBEDDING_PROVIDER=ollama (free local embeddings, explicit per-box opt-in).
 *
 * Proves:
 *   1. ollama resolves ONLY when opted in (never auto-detected; Google stays the default).
 *   2. It needs no key: semantic SOP search is available, but getEmbeddingApiKey() stays
 *      null so department routing / skill matching keep their keyword path.
 *   3. fetchEmbedding posts to <url>/api/embed and refuses a wrong-dim vector.
 *   4. rankSOPsBySemantic ranks ONLY rows on the local model+dims (Gemini rows skipped).
 *   5. getSOPEmbeddingHealth: local rows at 768 are healthy; Gemini-only is not.
 *   6. embedding_health.py (the /api/health probe) accepts --sop-active-provider ollama and
 *      reports both stores ok when both are on the local model.
 *   7. backfill-sop-embeddings.ts in ollama mode: --force is not refused by the shipped-asset
 *      guard, and a real run stamps sop_embeddings_local_provider and writes 768-dim rows.
 *
 * Every test here fails on the pre-ollama code (no 'ollama' provider / probe choice / marker).
 *
 * Run: node --import tsx --test tests/unit/sop-embeddings-ollama-local.test.ts
 */

// C8 — DB isolation first (see tests/unit/c8-db-isolation-guard.test.ts).
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-emb-ollama-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'mission-control.test.db');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ENV_KEYS = [
  'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_API_KEY',
  'SOP_EMBEDDING_PROVIDER', 'SOP_EMBEDDING_OLLAMA_URL', 'SOP_EMBEDDING_MODEL', 'SOP_EMBEDDING_DIMS',
];

async function withEnv(vars: Record<string, string>, fn: () => unknown): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const OLLAMA = { SOP_EMBEDDING_PROVIDER: 'ollama' };

function unit(dims: number, hot: number): number[] {
  const v = new Array(dims).fill(0);
  v[hot] = 1;
  return v;
}

async function insertSop(id: string, model: string, dims: number, vec: number[]): Promise<void> {
  const { run } = await import('../../src/lib/db');
  const { float32ToBuffer } = await import('../../src/lib/sop-embeddings');
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, description, version, department, task_keywords, steps, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 1, 'test-dept', 'test', ?, ?, ?)`,
    [id, `SOP ${id}`, `slug-${id}`, JSON.stringify([{ name: 'step1' }]), now, now]
  );
  run(
    `INSERT OR REPLACE INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, float32ToBuffer(new Float32Array(vec)), model, dims, now]
  );
}

test('ollama resolves only when opted in; defaults nomic-embed-text @768 on 127.0.0.1:11434', async () => {
  const { resolveEmbeddingProvider } = await import('../../src/lib/sop-embeddings');
  await withEnv(OLLAMA, () => {
    const p = resolveEmbeddingProvider();
    assert.equal(p.name, 'ollama');
    assert.equal(p.model, 'nomic-embed-text');
    assert.equal(p.dims, 768);
    assert.equal(p.baseUrl, 'http://127.0.0.1:11434');
    assert.equal(p.apiKey, null);
  });
  await withEnv({
    ...OLLAMA, SOP_EMBEDDING_OLLAMA_URL: 'http://10.0.0.5:11434/', SOP_EMBEDDING_MODEL: 'mxbai-embed-large',
    SOP_EMBEDDING_DIMS: '1024',
  }, () => {
    const p = resolveEmbeddingProvider();
    assert.deepEqual([p.baseUrl, p.model, p.dims], ['http://10.0.0.5:11434', 'mxbai-embed-large', 1024]);
  });
  // Never auto-detected: no override → Google when a Google key exists, else none.
  await withEnv({ GOOGLE_API_KEY: 'AIza-test-key-long-enough-1234567890' }, () => {
    assert.equal(resolveEmbeddingProvider().name, 'google');
  });
  await withEnv({}, () => assert.equal(resolveEmbeddingProvider().name, 'none'));
});

test('ollama needs no key: SOP semantic search on, routing key stays null', async () => {
  const { isEmbeddingAvailable, getEmbeddingApiKey } = await import('../../src/lib/sop-embeddings');
  await withEnv(OLLAMA, () => {
    assert.equal(isEmbeddingAvailable(), true);
    assert.equal(getEmbeddingApiKey(), null);
  });
});

test('fetchEmbedding posts to <url>/api/embed and refuses a wrong-dim vector', async () => {
  const { fetchEmbedding } = await import('../../src/lib/sop-embeddings');
  const origFetch = global.fetch;
  const calls: { url: string; body: { model: string; input: string } }[] = [];
  let dims = 768;
  global.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ embeddings: [unit(dims, 0)] }), { status: 200 });
  }) as typeof fetch;
  try {
    await withEnv(OLLAMA, async () => {
      const v = await fetchEmbedding('hello');
      assert.equal(v.length, 768);
      assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/embed');
      assert.deepEqual(calls[0].body, { model: 'nomic-embed-text', input: 'hello' });
      dims = 3072;
      await assert.rejects(fetchEmbedding('hello'), /3072-dim vector, expected 768/);
    });
  } finally {
    global.fetch = origFetch;
  }
});

test('rankSOPsBySemantic in ollama mode ranks only local-model rows', async () => {
  const { rankSOPsBySemantic } = await import('../../src/lib/sop-embeddings');
  const t = Date.now();
  await insertSop(`ol-near-${t}`, 'nomic-embed-text', 768, unit(768, 0));
  await insertSop(`ol-far-${t}`, 'nomic-embed-text', 768, unit(768, 1));
  await insertSop(`ol-gem-${t}`, 'gemini-embedding-2', 3072, unit(3072, 0));
  const origFetch = global.fetch;
  global.fetch = (async () =>
    new Response(JSON.stringify({ embeddings: [unit(768, 0)] }), { status: 200 })) as typeof fetch;
  try {
    await withEnv(OLLAMA, async () => {
      const hits = await rankSOPsBySemantic('query');
      const ids = hits.map((h) => h.sopId);
      assert.equal(ids[0], `ol-near-${t}`);
      assert.ok(ids.includes(`ol-far-${t}`));
      assert.ok(!ids.includes(`ol-gem-${t}`), 'Gemini rows must never be compared in ollama mode');
    });
  } finally {
    global.fetch = origFetch;
  }
});

test('getSOPEmbeddingHealth: local 768 rows are healthy in ollama mode', async () => {
  const { getSOPEmbeddingHealth } = await import('../../src/lib/sop-embeddings');
  await withEnv(OLLAMA, () => {
    const h = getSOPEmbeddingHealth();
    assert.equal(h.provider, 'ollama');
    assert.equal(h.activeDims, 768);
    assert.equal(h.semanticReady, true);
    assert.equal(h.degraded, false);
  });
});

test('embedding_health.py accepts --sop-active-provider ollama; both stores local → ok', () => {
  const persona = path.join(TMP_DIR, 'persona.sqlite');
  const sop = path.join(TMP_DIR, 'sop-probe.db');
  const p = new Database(persona);
  p.exec('CREATE TABLE embeddings (id TEXT PRIMARY KEY, vector BLOB, provider TEXT, model TEXT, dim INTEGER)');
  p.prepare("INSERT INTO embeddings VALUES ('a', x'00', 'ollama', 'nomic-embed-text', 768)").run();
  p.close();
  const s = new Database(sop);
  s.exec('CREATE TABLE sop_embeddings (sop_id TEXT PRIMARY KEY, embedding BLOB, embedding_model TEXT, embedding_dims INTEGER)');
  s.prepare("INSERT INTO sop_embeddings VALUES ('s', x'00', 'nomic-embed-text', 768)").run();
  s.close();
  const run = (extra: string[]) => spawnSync('python3', [
    path.join(REPO_ROOT, 'shared-utils', 'embedding_health.py'), '--format', 'json',
    '--sop-db', sop, '--persona-db', persona, '--sop-active-provider', 'ollama', ...extra,
  ], { encoding: 'utf-8' });
  const r = run(['--sop-active-model', 'nomic-embed-text', '--sop-active-dims', '768']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.status, 'ok', r.stdout);
  assert.equal(report.sop_index.semantic_ready, true);
  assert.equal(report.persona_index.semantic_ready, true);
  // Wrong dims for the local model is not healthy.
  const bad = JSON.parse(run(['--sop-active-dims', '1024']).stdout);
  assert.equal(bad.status, 'degraded');
});

// ── backfill script (child process; a stub Ollama answers on a random port) ──

function initSchema(dbPath: string): void {
  const setupFile = path.join(path.dirname(dbPath), 'setup.mjs');
  fs.writeFileSync(
    setupFile,
    `import('${path.join(REPO_ROOT, 'src', 'lib', 'db', 'index.ts')}').then(m => { m.getDb(); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });\n`
  );
  const r = spawnSync('npx', ['tsx', setupFile], {
    cwd: REPO_ROOT, env: { ...process.env, DATABASE_PATH: dbPath }, encoding: 'utf-8', timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`fixture DB migration failed: ${r.stderr}`);
}

function runBackfill(dbPath: string, env: Record<string, string>, args: string[]):
  Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', path.join(REPO_ROOT, 'scripts', 'backfill-sop-embeddings.ts'), ...args], {
      cwd: REPO_ROOT, env: { ...process.env, DATABASE_PATH: dbPath, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('backfill in ollama mode: not refused by the shipped marker; stamps the local marker; writes 768 rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-ollama-'));
  const dbPath = path.join(dir, 'mission-control.db');
  initSchema(dbPath);
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE sop_embeddings_shipped_asset (id INTEGER PRIMARY KEY CHECK (id = 1), release_tag TEXT NOT NULL,
             sop_count INTEGER NOT NULL, sha256 TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare("INSERT INTO sop_embeddings_shipped_asset (id, release_tag, sop_count, sha256) VALUES (1, 'sop-embeddings-v1.0.0', 2, 'x')").run();
  const now = new Date().toISOString();
  for (const id of ['bf-a', 'bf-b']) {
    db.prepare(`INSERT INTO sops (id, name, slug, version, department, task_keywords, steps, created_at, updated_at)
                VALUES (?, ?, ?, 1, 'test-dept', 'test', '[]', ?, ?)`).run(id, `SOP ${id}`, `slug-${id}`, now, now);
  }
  db.close();

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ embeddings: [unit(768, 3)] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const env = { SOP_EMBEDDING_PROVIDER: 'ollama', SOP_EMBEDDING_OLLAMA_URL: url, GOOGLE_API_KEY: '', GEMINI_API_KEY: '' };
    const r = await runBackfill(dbPath, env, ['--force', '--batch-delay-ms=0']);
    assert.doesNotMatch(r.stderr, /REFUSED/);
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    const check = new Database(dbPath, { readonly: true });
    const marker = check.prepare('SELECT provider, model, dims FROM sop_embeddings_local_provider WHERE id = 1').get();
    assert.deepEqual(marker, { provider: 'ollama', model: 'nomic-embed-text', dims: 768 });
    const rows = check.prepare(
      "SELECT COUNT(*) AS n FROM sop_embeddings WHERE sop_id IN ('bf-a','bf-b') AND embedding_model = 'nomic-embed-text' AND embedding_dims = 768 AND length(embedding) = 3072"
    ).get() as { n: number };
    check.close();
    assert.equal(rows.n, 2);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backfill --dry-run deletes nothing: other-model rows survive, no marker, no embed call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-dryrun-'));
  const dbPath = path.join(dir, 'mission-control.db');
  initSchema(dbPath);
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  for (const id of ['dr-a', 'dr-b']) {
    db.prepare(`INSERT INTO sops (id, name, slug, version, department, task_keywords, steps, created_at, updated_at)
                VALUES (?, ?, ?, 1, 'test-dept', 'test', '[]', ?, ?)`).run(id, `SOP ${id}`, `slug-${id}`, now, now);
    db.prepare(`INSERT INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
                VALUES (?, ?, 'gemini-embedding-2', 3072, ?)`).run(id, Buffer.alloc(3072 * 4), now);
  }
  const count = (d: Database.Database) => (d.prepare('SELECT COUNT(*) AS n FROM sop_embeddings').get() as { n: number }).n;
  const before = count(db);
  db.close();

  let embedCalls = 0;
  const server = http.createServer((req, res) => { embedCalls++; req.resume(); res.statusCode = 500; res.end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const env = { SOP_EMBEDDING_PROVIDER: 'ollama', SOP_EMBEDDING_OLLAMA_URL: url, GOOGLE_API_KEY: '', GEMINI_API_KEY: '' };
    const r = await runBackfill(dbPath, env, ['--dry-run']);
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    const check = new Database(dbPath, { readonly: true });
    assert.equal(before, 2);
    assert.equal(count(check), before, 'dry run must leave the row count unchanged');
    const marker = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sop_embeddings_local_provider'").get();
    check.close();
    assert.equal(marker, undefined, 'dry run must not stamp the local marker');
    assert.equal(embedCalls, 0, 'dry run must not call the embed endpoint');
    assert.match(r.stdout, /DRY RUN — would delete 2 non-active-model rows/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

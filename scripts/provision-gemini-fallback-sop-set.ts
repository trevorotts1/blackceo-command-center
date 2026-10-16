/**
 * Fill `sop_embeddings_gemini_fallback` on a LOCAL-embedding box from the shipped Gemini SOP asset
 * (sop-embeddings release; shared-utils/sop-embed-once/SOP-EMBEDDINGS-MANIFEST.json in the onboarding
 * repo). When local Ollama is down, the department router's SOP vote embeds the task with the box's own
 * Gemini key and votes against THIS set. It is a separate table so local mode never overwrites its own
 * 768-dim vectors and the two vector spaces are never compared.
 *
 *   tsx scripts/provision-gemini-fallback-sop-set.ts --manifest <SOP-EMBEDDINGS-MANIFEST.json> [--asset <sop-embeddings.sqlite.gz>] [--db <mission-control.db>]
 *
 * Without --asset the manifest's asset_url is downloaded. sha256 is a hard gate. Rows are keyed to this
 * box's sops.id by the same two passes as onboarding's provision_sop_embeddings.py (exact id, then
 * "sop_" + slug.replace("-", "_")[:60]). Idempotent; zero embedding API calls.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

export interface ShippedManifest { sha256: string; model: string; dims: number; release_tag: string; asset_url?: string }

/** Import the gzipped shipped asset into `db`'s sop_embeddings_gemini_fallback, mapped onto this box's sops.id. */
export function provisionGeminiFallback(db: Database.Database, manifest: ShippedManifest, gz: Buffer): { byId: number; bySlug: number } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-fallback-'));
  try {
    const sha = crypto.createHash('sha256').update(gz).digest('hex');
    if (sha !== manifest.sha256) throw new Error(`sha256 mismatch (expected ${manifest.sha256}, got ${sha}); not importing`);
    const shippedPath = path.join(tmp, 'shipped.sqlite');
    fs.writeFileSync(shippedPath, zlib.gunzipSync(gz));
    db.exec(`CREATE TABLE IF NOT EXISTS sop_embeddings_gemini_fallback (
      sop_id TEXT PRIMARY KEY REFERENCES sops(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL, embedding_model TEXT NOT NULL, embedding_dims INTEGER NOT NULL,
      embedded_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    db.exec(`ATTACH DATABASE '${shippedPath.replace(/'/g, "''")}' AS shipped`);
    try {
      const bad = db.prepare('SELECT COUNT(*) AS n FROM shipped.sop_embeddings WHERE embedding_model != ? OR embedding_dims != ?').get(manifest.model, manifest.dims) as { n: number };
      if (bad.n) throw new Error(`${bad.n} shipped row(s) do not match ${manifest.model}/${manifest.dims}; refusing (never mix vector spaces)`);
      const cols = '(sop_id, embedding, embedding_model, embedding_dims, embedded_at)';
      const byId = db.prepare(`INSERT OR REPLACE INTO sop_embeddings_gemini_fallback ${cols}
        SELECT e.sop_id, e.embedding, e.embedding_model, e.embedding_dims, e.embedded_at FROM shipped.sop_embeddings e
        WHERE e.sop_id IN (SELECT id FROM main.sops)`).run().changes;
      const bySlug = db.prepare(`INSERT OR REPLACE INTO sop_embeddings_gemini_fallback ${cols}
        SELECT s.id, e.embedding, e.embedding_model, e.embedding_dims, e.embedded_at FROM main.sops s
        JOIN shipped.sop_embeddings e ON e.sop_id = 'sop_' || substr(replace(s.slug, '-', '_'), 1, 60)
        WHERE s.slug IS NOT NULL AND s.slug != '' AND s.id NOT IN (SELECT sop_id FROM shipped.sop_embeddings)`).run().changes;
      return { byId, bySlug };
    } finally {
      db.exec('DETACH DATABASE shipped');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const manifestPath = arg('--manifest');
  if (!manifestPath) throw new Error('--manifest <SOP-EMBEDDINGS-MANIFEST.json> is required');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ShippedManifest;
  const dbPath = arg('--db') || process.env.DATABASE_PATH || path.join(os.homedir(), 'data', 'mission-control.db');
  const assetPath = arg('--asset');
  let gz: Buffer;
  if (assetPath) gz = fs.readFileSync(assetPath);
  else {
    const res = await fetch(String(manifest.asset_url));
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    gz = Buffer.from(await res.arrayBuffer());
  }
  const db = new Database(dbPath);
  try {
    const { byId, bySlug } = provisionGeminiFallback(db, manifest, gz);
    console.log(`gemini fallback SOP set: ${byId} by id + ${bySlug} by slug (release ${manifest.release_tag}, ${manifest.model} @${manifest.dims}); zero API calls`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(String(err instanceof Error ? err.message : err)); process.exit(1); });
}

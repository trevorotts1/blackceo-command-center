/**
 * Correction learning (Trevor 2026-10-07): when a person moves a task to another department in the Command
 * Center, the task text and its FINAL department are kept, and those records act as nearest-neighbour examples in
 * the SOP vote (sop-vote.ts: each correction is one more neighbour, weighted CORRECTION_WEIGHT) and in the model pick
 * (the corrected text is listed first among that department's examples).
 *
 * Storage: `routing_department_corrections` (the older `routing_corrections` table records owner lane overrides by task id, a different thing), created on first use (CREATE IF NOT EXISTS, so no migration number to collide
 * with other branches). The embedding is stored per (model, dims) in the same space as the SOP index and is
 * filled lazily when the provider was down at record time. Texts are stored as given by the user's task; they
 * never leave the box (they are only embedded by the box's own provider).
 */
import crypto from 'node:crypto';
import { queryAll, queryOne, run } from '@/lib/db';
import { bufferToFloat32, float32ToBuffer, fetchEmbeddingsFor, localEmbedText, type EmbeddingProvider } from '@/lib/sop-embeddings';
import { canonicalDeptSlug } from './canonical-slug';

/**
 * A correction is a person's explicit decision, so it counts for more than one SOP neighbour, but only when at
 * least CORRECTION_QUORUM corrections for the same department are near the task: ONE correction (which may be a
 * mistake) counts as a single ordinary neighbour (weight 1) and cannot outvote two or more agreeing SOPs.
 */
export const CORRECTION_WEIGHT = 2;
export const CORRECTION_QUORUM = 2;
/** Retention: newest N corrections per department, and nothing older than this many days. Pruned on insert. */
export const CORRECTIONS_KEEP_PER_DEPT = 200;
export const CORRECTIONS_MAX_AGE_DAYS = 365;
/** A correction only counts as a neighbour when it is this similar to the new task (an unrelated one must not outvote SOPs). */
export const CORRECTION_MIN_SIM = 0.7;
const MAX_TEXT = 1000;

let _ready = false;
function ensureTable(): void {
  if (_ready) return;
  run(`CREATE TABLE IF NOT EXISTS routing_department_corrections (
    id TEXT PRIMARY KEY,
    text_hash TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    department TEXT NOT NULL,
    embedding BLOB,
    embedding_model TEXT,
    embedding_dims INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  _ready = true;
}

/** Test seam. */
export function __resetCorrections(): void { _ready = false; }

export const correctionText = (title?: string | null, description?: string | null): string =>
  [title, description].filter(Boolean).join(' — ').trim().slice(0, MAX_TEXT);

/** Bounded table: drop this department's corrections beyond the newest N, and any older than the age limit. */
function pruneCorrections(dept: string): void {
  run(
    `DELETE FROM routing_department_corrections WHERE department = ? AND id NOT IN
       (SELECT id FROM routing_department_corrections WHERE department = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?)`,
    [dept, dept, CORRECTIONS_KEEP_PER_DEPT],
  );
  run(`DELETE FROM routing_department_corrections WHERE updated_at < datetime('now', ?)`, [`-${CORRECTIONS_MAX_AGE_DAYS} days`]);
}

/** Keep (task text → final department). The same text corrected again replaces its earlier department. Never throws. */
export function recordCorrection(text: string, department: string | null | undefined): boolean {
  try {
    const t = text.trim().slice(0, MAX_TEXT);
    const dept = canonicalDeptSlug(department);
    if (!t || !dept || dept === 'default') return false;
    ensureTable();
    const hash = crypto.createHash('sha1').update(t.toLowerCase()).digest('hex');
    run(
      `INSERT INTO routing_department_corrections (id, text_hash, text, department) VALUES (?, ?, ?, ?)
       ON CONFLICT(text_hash) DO UPDATE SET department = excluded.department, embedding = NULL, embedding_model = NULL, embedding_dims = NULL, updated_at = datetime('now')`,
      [crypto.randomUUID(), hash, t, dept],
    );
    pruneCorrections(dept);
    return true;
  } catch (err) {
    console.warn(`[DepartmentRouter] correction not recorded: ${(err as Error).message}`);
    return false;
  }
}

export interface Correction { slug: string; text: string; vec: Float32Array }

/** Corrections embedded in `provider`'s space (embedding any that are not yet, best effort). Empty when none or on error. */
export async function loadCorrections(provider: EmbeddingProvider): Promise<Correction[]> {
  try {
    ensureTable();
    const missing = queryAll<{ id: string; text: string }>(
      `SELECT id, text FROM routing_department_corrections WHERE embedding IS NULL OR embedding_model IS NOT ? OR embedding_dims IS NOT ? LIMIT 50`,
      [provider.model, provider.dims],
    );
    if (missing.length > 0) {
      const res = await fetchEmbeddingsFor(provider, missing.map((m) => localEmbedText(m.text, 'query', provider)));
      missing.forEach((m, i) => {
        if (res[i]?.embedding) run('UPDATE routing_department_corrections SET embedding = ?, embedding_model = ?, embedding_dims = ? WHERE id = ?', [float32ToBuffer(Float32Array.from(res[i].embedding)), provider.model, provider.dims, m.id]);
      });
    }
    const rows = queryAll<{ department: string; text: string; embedding: Buffer }>(
      'SELECT department, text, embedding FROM routing_department_corrections WHERE embedding IS NOT NULL AND embedding_model = ? AND embedding_dims = ?',
      [provider.model, provider.dims],
    );
    const out: Correction[] = [];
    for (const r of rows) { const v = bufferToFloat32(r.embedding); if (v) out.push({ slug: canonicalDeptSlug(r.department), text: r.text, vec: v }); }
    return out;
  } catch {
    return [];
  }
}

/**
 * The CC's reassignment path: PATCH /api/tasks/[id] with a new `assigned_agent_id`. `human` must be true only
 * for a genuine person: the route passes it when the request carries a verified tenant session (not the shared
 * MC_API_TOKEN bearer that agents and scripts use, `subject === 'operator:api'`) and no `updated_by_agent_id`.
 * When the new agent belongs to a different department than the task's current one, that is a correction of
 * the routing: (task text -> the new agent's department). The route calls this only AFTER the UPDATE commits.
 * Never throws.
 */
export function noteReassignment(
  task: { title?: string | null; description?: string | null; department?: string | null; workspace_id?: string | null },
  newAgentId: string | null | undefined,
  human: boolean,
): boolean {
  try {
    if (!newAgentId || !human) return false;
    const to = queryOne<{ slug: string | null }>(
      'SELECT w.slug AS slug FROM agents a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = ?', [newAgentId],
    )?.slug;
    const from = task.department || (task.workspace_id ? queryOne<{ slug: string | null }>('SELECT slug FROM workspaces WHERE id = ?', [task.workspace_id])?.slug : null);
    if (!to || canonicalDeptSlug(to) === canonicalDeptSlug(from)) return false;
    return recordCorrection(correctionText(task.title, task.description), to);
  } catch {
    return false;
  }
}

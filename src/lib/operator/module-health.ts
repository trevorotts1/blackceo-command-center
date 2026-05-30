/**
 * Per-module vault-write health (Operator Console, Feature 2).
 *
 * The Operator persisting sub-modules (Goals, Journal, Notebook, Studio,
 * Research) write a SQLite row (the source of truth) and, for most of them, a
 * best-effort markdown/JSON mirror into the operator vault. Until now the
 * mirror-write result was fire-and-forget and discarded, so nothing recorded
 * whether the disk write actually reached the vault.
 *
 * This module closes that gap with two halves:
 *
 *   1. `recordVaultWrite()` / `recordVaultWriteError()` — called by the Goals
 *      and Journal route handlers right after they mirror, persisting the last
 *      attempt's outcome to `<vault>/<module>/.health.json`. No DB migration is
 *      needed; this mirrors the existing Studio `<vault>/studio/.jobs/<id>.json`
 *      persistence pattern (see `src/lib/studio/generators.ts`).
 *
 *   2. `getModuleHealth()` — read-only. For each module it reports DB
 *      reachability and the best available vault-write evidence, deriving a
 *      six-state status from the same vocabulary the System Status Panel uses
 *      (`live | working | busy | degraded | offline | unknown`). It NEVER
 *      throws and NEVER fabricates: when it cannot determine vault state it
 *      reports `unknown`, not green.
 *
 * Honesty contract (Feature 2 spec):
 *   - green  (`live`)    : a vault write is confirmed present on disk.
 *   - amber  (`busy`)    : the DB row exists but the vault mirror cannot be
 *                          confirmed (mirror-unknown) — saved, not verified.
 *   - red    (`offline`) : the last recorded write attempt errored, or the DB
 *                          itself is unreachable.
 *   - grey   (`unknown`) : nothing determinable yet (no writes, no evidence).
 *
 * Notebook is DB-only by design (no vault markdown mirror — remote NotebookLM
 * state lives in `remote_id`), so its vault dimension is reported as
 * `not_applicable` and a healthy DB shows green on the DB dimension alone.
 */

import fs from 'fs/promises';
import path from 'path';
import { vaultRoot } from '@/lib/platform';
import { queryOne } from '@/lib/db';

export type ModuleId = 'goals' | 'journal' | 'notebook' | 'studio' | 'research';

export type ModuleStatus =
  | 'live'
  | 'working'
  | 'busy'
  | 'degraded'
  | 'offline'
  | 'unknown';

export interface VaultHealth {
  /** Whether vault-write evidence could be confirmed on disk. */
  ok: boolean | null;
  /** Last write path we know about (recorded or discovered). Null if none. */
  lastWritePath: string | null;
  /** ISO timestamp of the last known write. Null if none. */
  lastWriteAt: string | null;
  /** True for modules that intentionally have no vault mirror (Notebook). */
  notApplicable?: boolean;
  /** Last recorded error string, when the last write attempt failed. */
  error?: string | null;
  /** How the vault evidence was obtained, for honest UI copy / debugging. */
  source: 'recorded' | 'discovered' | 'none' | 'not_applicable' | 'error';
}

export interface ModuleHealth {
  module: ModuleId;
  label: string;
  status: ModuleStatus;
  /** Human-readable, screen-reader-friendly one-liner (never color-only). */
  message: string;
  db: { ok: boolean | null; rowCount: number | null; error?: string | null };
  vault: VaultHealth;
  checkedAt: string;
}

const LABELS: Record<ModuleId, string> = {
  goals: 'Goals',
  journal: 'Journal',
  notebook: 'Notebook',
  studio: 'Studio',
  research: 'Research',
};

/** Modules whose mirror outcome we record via recordVaultWrite(). */
const HEALTH_FILE_MODULES: ModuleId[] = ['goals', 'journal'];

interface HealthRecord {
  ok: boolean;
  lastWritePath: string | null;
  lastWriteAt: string;
  error?: string | null;
}

function healthFilePath(module: ModuleId): string {
  // Mirrors Studio's `<vault>/studio/.jobs/<id>.json` convention: a dotfile
  // sidecar under the module's own vault subdirectory.
  return path.join(vaultRoot(), module, '.health.json');
}

/**
 * Record the outcome of a successful (or attempted) vault mirror write.
 * Best-effort: a failure to persist the health record is logged and swallowed
 * so it can never break the API call that produced the real write.
 *
 * @param module        the persisting module
 * @param writtenPaths  the path (or list of paths) the mirror wrote, or null/[]
 *                      when the mirror produced nothing (treated as an error
 *                      signal so the dot does not show false-green).
 */
export async function recordVaultWrite(
  module: ModuleId,
  writtenPaths: string | string[] | null
): Promise<void> {
  const list = Array.isArray(writtenPaths)
    ? writtenPaths
    : writtenPaths
      ? [writtenPaths]
      : [];
  const ok = list.length > 0;
  const record: HealthRecord = {
    ok,
    lastWritePath: list[0] ?? null,
    lastWriteAt: new Date().toISOString(),
    error: ok ? null : 'mirror produced no file',
  };
  await persistHealthRecord(module, record);
}

/** Record that the last vault mirror attempt threw. Best-effort. */
export async function recordVaultWriteError(
  module: ModuleId,
  error: unknown
): Promise<void> {
  const record: HealthRecord = {
    ok: false,
    lastWritePath: null,
    lastWriteAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error ?? 'unknown'),
  };
  await persistHealthRecord(module, record);
}

async function persistHealthRecord(module: ModuleId, record: HealthRecord): Promise<void> {
  try {
    const file = healthFilePath(module);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
  } catch (err) {
    console.error(`[module-health] failed to persist ${module} health record:`, err);
  }
}

async function readHealthRecord(module: ModuleId): Promise<HealthRecord | null> {
  try {
    const file = healthFilePath(module);
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as HealthRecord;
    if (parsed && typeof parsed.lastWriteAt === 'string') return parsed;
    return null;
  } catch {
    // No record yet (ENOENT) or corrupt — treat as "no recorded evidence".
    return null;
  }
}

/**
 * Find the most recently modified file under `dir` (recursively), used for
 * modules whose mirror is not recorded (Studio jobs, Research markdown).
 * Returns the newest file path + its mtime, or null if the tree is empty/absent.
 * Bounded traversal (depth + entry caps) so a huge vault never stalls the probe.
 */
async function newestFileUnder(
  dir: string,
  opts: { match?: (name: string) => boolean; maxDepth?: number } = {}
): Promise<{ path: string; mtimeMs: number } | null> {
  const maxDepth = opts.maxDepth ?? 6;
  let best: { path: string; mtimeMs: number } | null = null;
  let scanned = 0;
  const SCAN_CAP = 5000;

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth || scanned > SCAN_CAP) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned > SCAN_CAP) return;
      scanned += 1;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (opts.match && !opts.match(entry.name)) continue;
      try {
        const st = await fs.stat(full);
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { path: full, mtimeMs: st.mtimeMs };
        }
      } catch {
        // Skip unreadable entries.
      }
    }
  }

  await walk(dir, 0);
  return best;
}

/**
 * Resolve the vault dimension for one module without throwing.
 * Prefers a recorded health record (Goals/Journal); falls back to discovering
 * the newest file on disk (Studio/Research); reports not_applicable (Notebook)
 * or unknown when nothing is determinable.
 */
async function resolveVaultHealth(module: ModuleId): Promise<VaultHealth> {
  // Recorded modules: the route handler wrote a .health.json sidecar.
  if (HEALTH_FILE_MODULES.includes(module)) {
    const rec = await readHealthRecord(module);
    if (rec) {
      if (rec.ok) {
        return {
          ok: true,
          lastWritePath: rec.lastWritePath,
          lastWriteAt: rec.lastWriteAt,
          source: 'recorded',
        };
      }
      return {
        ok: false,
        lastWritePath: rec.lastWritePath,
        lastWriteAt: rec.lastWriteAt,
        error: rec.error ?? 'last mirror write failed',
        source: 'error',
      };
    }
    // No record yet — fall through to a best-effort disk discovery so an
    // existing vault (e.g. pre-feature data) still shows evidence.
  }

  let root: string;
  try {
    root = vaultRoot();
  } catch {
    return { ok: null, lastWritePath: null, lastWriteAt: null, source: 'none' };
  }

  if (module === 'notebook') {
    return {
      ok: null,
      lastWritePath: null,
      lastWriteAt: null,
      notApplicable: true,
      source: 'not_applicable',
    };
  }

  const dirForModule: Record<Exclude<ModuleId, 'notebook'>, { dir: string; match?: (n: string) => boolean }> = {
    goals: { dir: path.join(root, 'goals'), match: (n) => n.endsWith('.md') },
    journal: { dir: path.join(root, 'journal'), match: (n) => n.endsWith('.md') },
    studio: { dir: path.join(root, 'studio', '.jobs'), match: (n) => n.endsWith('.json') },
    research: { dir: path.join(root, 'research'), match: (n) => n.endsWith('.md') },
  };

  // Goals also writes a top-level goals.md alongside the per-category dir.
  if (module === 'goals') {
    const topLevel = path.join(root, 'goals.md');
    try {
      const st = await fs.stat(topLevel);
      const inDir = await newestFileUnder(dirForModule.goals.dir, { match: dirForModule.goals.match });
      const newest =
        inDir && inDir.mtimeMs > st.mtimeMs ? inDir : { path: topLevel, mtimeMs: st.mtimeMs };
      return {
        ok: true,
        lastWritePath: newest.path,
        lastWriteAt: new Date(newest.mtimeMs).toISOString(),
        source: 'discovered',
      };
    } catch {
      // top-level goals.md absent — fall through to dir scan below.
    }
  }

  const spec = dirForModule[module as Exclude<ModuleId, 'notebook'>];
  const newest = await newestFileUnder(spec.dir, { match: spec.match });
  if (newest) {
    return {
      ok: true,
      lastWritePath: newest.path,
      lastWriteAt: new Date(newest.mtimeMs).toISOString(),
      source: 'discovered',
    };
  }

  // Nothing on disk and no record — honestly unknown (NOT green).
  return { ok: null, lastWritePath: null, lastWriteAt: null, source: 'none' };
}

/** Count rows for a module's canonical table without throwing. */
function resolveDbHealth(module: ModuleId): {
  ok: boolean | null;
  rowCount: number | null;
  error?: string | null;
} {
  const table: Record<ModuleId, string> = {
    goals: 'operator_goals',
    journal: 'operator_journal_entries',
    notebook: 'notebooks',
    studio: '', // Studio is file-backed (no SQL table by design — see generators.ts).
    research: 'research_searches',
  };
  const t = table[module];
  if (!t) {
    // No SQL table for this module — DB dimension is not the source of truth.
    return { ok: null, rowCount: null };
  }
  try {
    const row = queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`);
    return { ok: true, rowCount: row?.c ?? 0 };
  } catch (err) {
    return {
      ok: false,
      rowCount: null,
      error: err instanceof Error ? err.message : 'db unreachable',
    };
  }
}

/** Derive the six-state status + honest message from the two dimensions. */
function deriveStatus(
  module: ModuleId,
  db: { ok: boolean | null },
  vault: VaultHealth
): { status: ModuleStatus; message: string } {
  // DB unreachable is the worst case for any DB-backed module.
  if (db.ok === false) {
    return { status: 'offline', message: 'Database error — saves may not be persisting.' };
  }

  if (vault.notApplicable) {
    // Notebook: DB is the source of truth, no vault mirror expected.
    if (db.ok) {
      return { status: 'live', message: 'Saved to the database (no vault mirror for this module).' };
    }
    return { status: 'unknown', message: 'No activity recorded yet.' };
  }

  if (vault.source === 'error' || vault.ok === false) {
    return {
      status: 'offline',
      message: `Saved to the database, but the last vault write failed${vault.error ? `: ${vault.error}` : '.'}`,
    };
  }

  if (vault.ok === true) {
    return { status: 'live', message: 'Last write reached the vault.' };
  }

  // vault.ok === null — cannot confirm the vault write.
  if (db.ok) {
    return {
      status: 'busy',
      message: 'Saved to the database — vault mirror not confirmed yet.',
    };
  }

  return { status: 'unknown', message: 'No writes recorded yet.' };
}

/** Compute health for a single module. Never throws. */
export async function getModuleHealth(module: ModuleId): Promise<ModuleHealth> {
  const checkedAt = new Date().toISOString();
  let db: { ok: boolean | null; rowCount: number | null; error?: string | null };
  let vault: VaultHealth;
  try {
    db = resolveDbHealth(module);
  } catch (err) {
    db = { ok: false, rowCount: null, error: err instanceof Error ? err.message : 'db error' };
  }
  try {
    vault = await resolveVaultHealth(module);
  } catch (err) {
    vault = {
      ok: false,
      lastWritePath: null,
      lastWriteAt: null,
      error: err instanceof Error ? err.message : 'vault probe error',
      source: 'error',
    };
  }
  const { status, message } = deriveStatus(module, db, vault);
  return { module, label: LABELS[module], status, message, db, vault, checkedAt };
}

/**
 * Run a vault-mirror promise and record its outcome to the module's health
 * sidecar, without ever rejecting. This is the replacement for the previous
 * `void writeVaultMirror()` / `void writeJournalMirror(entry)` fire-and-forget
 * calls in the Goals/Journal route handlers — same non-blocking-from-the-route
 * intent, but the success signal (the written path(s)) is no longer discarded.
 *
 * Callers fire-and-forget this with `void trackVaultMirror(...)`; the recording
 * happens after the mirror resolves. Errors are captured as a red health state
 * rather than propagating.
 *
 * @param module the persisting module (goals | journal)
 * @param mirror the in-flight mirror write; resolves to the written path(s),
 *               null, or [] (null/[] are treated as "no file written").
 */
export async function trackVaultMirror(
  module: ModuleId,
  mirror: Promise<string | string[] | null>
): Promise<void> {
  try {
    const result = await mirror;
    await recordVaultWrite(module, result);
  } catch (err) {
    await recordVaultWriteError(module, err);
  }
}

/** Compute health for every persisting module in parallel. Never throws. */
export async function getAllModuleHealth(): Promise<ModuleHealth[]> {
  const modules: ModuleId[] = ['goals', 'journal', 'notebook', 'studio', 'research'];
  return Promise.all(modules.map((m) => getModuleHealth(m)));
}

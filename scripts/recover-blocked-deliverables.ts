#!/usr/bin/env tsx
/**
 * scripts/recover-blocked-deliverables.ts
 *
 * ONE-TIME recovery sweep for the ~93-136 `blocked` cards left by the
 * "carded-but-trapped" write-back 401 defect (dept agents finished work but their
 * POST /deliverables + PATCH status 401'd on a missing/wrong MC_API_TOKEN, so the
 * cards were swept to blocked/backlog). This does NOT blanket-redeliver — the
 * blocked pile is mostly noise (onboarding scaffolds, test/probe cards, a seed
 * burst, re-queue duplicates); only a minority carry real on-disk output.
 * It CLASSIFIES every blocked card, then proposes a per-card action.
 *
 * ── SAFE BY DEFAULT ─────────────────────────────────────────────────────────
 *   • DRY-RUN is the default and the only mode unless BOTH --apply AND --yes are
 *     passed. Dry-run opens the DB READ-ONLY and writes ZERO rows; it emits a
 *     per-card ledger (JSON) + a human summary for operator review.
 *   • APPLY performs every mutation through the Command Center HTTP API with
 *     `Authorization: Bearer $MC_API_TOKEN` (it deliberately DOGFOODS the Area-1
 *     write-back-auth fix and avoids raw-SQLite/WAL hazards against the live app).
 *     Apply aborts loudly if MC_API_TOKEN is unset. Run APPLY only AFTER the
 *     Area-1 CC code is live on the box.
 *
 * ── CLASSIFICATION (priority order) ─────────────────────────────────────────
 *   Welcome to %                                   → ONBOARDING  (admin-close)
 *   test / routing / probe / e2e  OR  dept in
 *     {smoke-test-dept, no-script-dept}            → TEST        (admin-close)
 *   sample / demo                                  → DEMO        (admin-close)
 *   'General Task' burst 2026-06-16T01:21–01:23    → SEED        (admin-close)
 *   [RE-QUEUED]/URGENT:/ESCALATE: sharing a root
 *     subject (keep newest, close the rest)        → DUPLICATE   (admin-close)
 *   everything else                                → REAL
 *       REAL + on-disk/registered evidence         → recover to `review`
 *       REAL + no evidence                         → return to orchestrator
 *
 * Usage:
 *   npx tsx scripts/recover-blocked-deliverables.ts                # dry-run (default)
 *   npx tsx scripts/recover-blocked-deliverables.ts --db <path> --out <file.json>
 *   npx tsx scripts/recover-blocked-deliverables.ts --apply --yes  # MUTATES (operator-timed)
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Types ────────────────────────────────────────────────────────────────────

export type BlockedClass = 'ONBOARDING' | 'TEST' | 'DEMO' | 'SEED' | 'DUPLICATE' | 'REAL';
export type SweepAction = 'administrative-close' | 'recover-to-review' | 'return-to-orchestrator';

export interface BlockedRow {
  id: string;
  title: string;
  status: string;
  department: string | null;
  workspace_id: string | null;
  created_at: string;
  block_audience: string | null;
  blocked_on_human: string | null;
}

export interface LedgerEntry {
  id: string;
  title: string;
  dept: string;
  class: BlockedClass;
  action: SweepAction;
  evidence: { registeredWithExistingPath: boolean; artifactDir: string | null };
  created_at: string;
  block_audience: string | null;
  blocked_on_human: string | null;
}

// ── Pure, testable classification ────────────────────────────────────────────

const RE_QUEUE_PREFIX = /^\s*(\[RE-?QUEUED\]|URGENT:|ESCALATE:)\s*/i;
const SEED_FROM = '2026-06-16T01:21:00';
const SEED_TO = '2026-06-16T01:23:59';

/** The subject a re-queue title shares with its siblings (prefix + noise stripped). */
export function rootSubject(title: string): string {
  let t = title || '';
  // Strip one or more stacked re-queue prefixes.
  while (RE_QUEUE_PREFIX.test(t)) t = t.replace(RE_QUEUE_PREFIX, '');
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function hasRequeuePrefix(title: string): boolean {
  return RE_QUEUE_PREFIX.test(title || '');
}

/** Base classification of a single card (DUPLICATE resolved separately in a group pass). */
export function classifyBlocked(row: BlockedRow): BlockedClass {
  const t = (row.title || '').trim();
  const dept = (row.department || row.workspace_id || '').toLowerCase();
  if (/^welcome to /i.test(t)) return 'ONBOARDING';
  if (/\b(test|routing|probe|e2e)\b/i.test(t) || dept === 'smoke-test-dept' || dept === 'no-script-dept') return 'TEST';
  if (/\b(sample|demo)\b/i.test(t)) return 'DEMO';
  if (/^general task$/i.test(t) && row.created_at >= SEED_FROM && row.created_at <= SEED_TO) return 'SEED';
  return 'REAL';
}

/**
 * Resolve DUPLICATE across the whole set: cards whose title carries a re-queue
 * prefix and share a root subject are the SAME work re-queued; keep the newest
 * (by created_at), mark the older siblings DUPLICATE. Only downgrades a card that
 * base-classified REAL (an onboarding/test/etc. card keeps its stronger class).
 */
export function resolveClasses(rows: BlockedRow[]): Map<string, BlockedClass> {
  const base = new Map<string, BlockedClass>();
  for (const r of rows) base.set(r.id, classifyBlocked(r));

  const groups = new Map<string, BlockedRow[]>();
  for (const r of rows) {
    if (!hasRequeuePrefix(r.title)) continue;
    const key = rootSubject(r.title);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  for (const [, siblings] of groups) {
    if (siblings.length < 2) continue; // a lone re-queue is not a duplicate of anything
    const sorted = [...siblings].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first
    for (let i = 1; i < sorted.length; i++) {
      if (base.get(sorted[i].id) === 'REAL') base.set(sorted[i].id, 'DUPLICATE');
    }
  }
  return base;
}

export function mapAction(klass: BlockedClass, hasEvidence: boolean): SweepAction {
  if (klass === 'REAL') return hasEvidence ? 'recover-to-review' : 'return-to-orchestrator';
  return 'administrative-close';
}

// ── Filesystem evidence (mirrors src/lib/jobs/finished-work-recovery.ts) ─────

export function taskProjectSlug(title: string): string {
  return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function dirHasOutput(dir: string, depth = 2): boolean {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        try { if (fs.statSync(full).size > 0) return true; } catch { /* ignore */ }
      } else if (e.isDirectory() && depth > 0) {
        if (dirHasOutput(full, depth - 1)) return true;
      }
    }
  } catch { /* unreadable — no output */ }
  return false;
}

// ── CLI plumbing ─────────────────────────────────────────────────────────────

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function expandTilde(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function findDb(argv: string[]): string {
  const candidates = [
    argVal(argv, '--db'),
    process.env.DATABASE_PATH,
    process.env.CC_DB_PATH,
    path.join(process.cwd(), 'mission-control.db'),
    path.join(os.homedir(), 'projects', 'command-center', 'mission-control.db'),
    path.join(os.homedir(), 'command-center', 'data', 'mission-control.db'),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Cannot find Command Center DB. Tried:\n${candidates.join('\n')}\nPass --db <path> or set DATABASE_PATH.`);
}

interface SweepReport {
  generatedAt: string;
  dbPath: string;
  mode: 'dry-run' | 'apply';
  totalBlocked: number;
  byClass: Record<string, number>;
  byAction: Record<string, number>;
  ledger: LedgerEntry[];
}

/** Build the read-only ledger (no writes). Exported for tests + apply reuse. */
export function buildLedger(db: Database.Database, projectsBase: string): LedgerEntry[] {
  const rows = db.prepare(
    `SELECT id, title, status, department, workspace_id, created_at, block_audience, blocked_on_human
       FROM tasks WHERE status = 'blocked' AND (archived_at IS NULL OR archived_at = '')`,
  ).all() as BlockedRow[];

  const classes = resolveClasses(rows);
  const ledger: LedgerEntry[] = [];
  for (const r of rows) {
    const klass = classes.get(r.id) ?? 'REAL';

    // Evidence: a registered deliverable whose path still exists, OR a non-empty
    // artifact / manual-dispatch project dir on disk.
    let registeredWithExistingPath = false;
    try {
      const dels = db.prepare('SELECT path FROM task_deliverables WHERE task_id = ?').all(r.id) as { path: string | null }[];
      registeredWithExistingPath = dels.some((d) => d.path && fs.existsSync(expandTilde(d.path)));
    } catch { /* table absent — no registered evidence */ }

    let artifactDir: string | null = null;
    for (const dir of [path.join(projectsBase, 'artifacts', r.id), path.join(projectsBase, taskProjectSlug(r.title))]) {
      if (dirHasOutput(dir)) { artifactDir = dir; break; }
    }

    const hasEvidence = registeredWithExistingPath || artifactDir !== null;
    ledger.push({
      id: r.id,
      title: r.title,
      dept: r.department || r.workspace_id || '',
      class: klass,
      action: mapAction(klass, hasEvidence),
      evidence: { registeredWithExistingPath, artifactDir },
      created_at: r.created_at,
      block_audience: r.block_audience,
      blocked_on_human: r.blocked_on_human,
    });
  }
  return ledger;
}

function tally(ledger: LedgerEntry[]): { byClass: Record<string, number>; byAction: Record<string, number> } {
  const byClass: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  for (const e of ledger) {
    byClass[e.class] = (byClass[e.class] ?? 0) + 1;
    byAction[e.action] = (byAction[e.action] ?? 0) + 1;
  }
  return { byClass, byAction };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const confirmed = argv.includes('--yes');
  const mode: 'dry-run' | 'apply' = apply && confirmed ? 'apply' : 'dry-run';

  const dbPath = findDb(argv);
  const projectsBase = expandTilde(process.env.PROJECTS_PATH || '~/Documents/Shared/projects');
  const outPath = argVal(argv, '--out') || path.join('/tmp/recovery-sweep', `${new Date().toISOString().slice(0, 10)}.json`);

  console.log(`[recover-blocked] DB: ${dbPath}`);
  console.log(`[recover-blocked] projects base: ${projectsBase}`);
  console.log(`[recover-blocked] mode: ${mode.toUpperCase()}${mode === 'dry-run' ? ' (read-only — no writes)' : ' (MUTATING via HTTP API)'}`);
  if (apply && !confirmed) {
    console.warn('[recover-blocked] --apply requires --yes to actually mutate; running DRY-RUN instead.');
  }

  const db = new Database(dbPath, { readonly: mode === 'dry-run', fileMustExist: true });
  const ledger = buildLedger(db, projectsBase);
  const { byClass, byAction } = tally(ledger);

  const report: SweepReport = {
    generatedAt: new Date().toISOString(),
    dbPath,
    mode,
    totalBlocked: ledger.length,
    byClass,
    byAction,
    ledger,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`\n[recover-blocked] ${ledger.length} blocked cards classified. Ledger → ${outPath}`);
  console.log('  by class:  ' + Object.entries(byClass).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('  by action: ' + Object.entries(byAction).map(([k, v]) => `${k}=${v}`).join('  '));

  if (mode === 'dry-run') {
    db.close();
    console.log('\n[recover-blocked] DRY-RUN complete — nothing was changed. Review the ledger, then re-run with --apply --yes AFTER the Area-1 write-back-auth fix is live on this box.');
    return;
  }

  // ── APPLY (guarded) ────────────────────────────────────────────────────────
  const token = (process.env.MC_API_TOKEN || '').trim();
  if (!token) {
    db.close();
    throw new Error('APPLY aborted: MC_API_TOKEN is unset. The sweep writes through the CC HTTP API with Authorization: Bearer $MC_API_TOKEN (Area-1 dogfood). Provision MC_API_TOKEN and re-run.');
  }
  const mcUrl = process.env.MISSION_CONTROL_URL || 'http://localhost:4000';
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  db.close(); // all further mutation goes through the API, not this handle.

  let applied = 0;
  for (const e of ledger) {
    try {
      if (e.action === 'administrative-close') {
        await fetch(`${mcUrl}/api/tasks/${e.id}/activities`, {
          method: 'POST', headers: authHeaders,
          body: JSON.stringify({ activity_type: 'completed', message: `administrative-close: ${e.class} (recovery sweep)` }),
        });
        await fetch(`${mcUrl}/api/tasks/${e.id}`, {
          method: 'PATCH', headers: authHeaders, body: JSON.stringify({ status: 'done' }),
        });
      } else if (e.action === 'recover-to-review') {
        if (e.evidence.artifactDir) {
          await fetch(`${mcUrl}/api/tasks/${e.id}/deliverables`, {
            method: 'POST', headers: authHeaders,
            body: JSON.stringify({ deliverable_type: 'file', title: 'Recovered output', path: e.evidence.artifactDir }),
          });
        }
        await fetch(`${mcUrl}/api/tasks/${e.id}/activities`, {
          method: 'POST', headers: authHeaders,
          body: JSON.stringify({ activity_type: 'completed', message: 'recovered-by-sweep: finished work found; advanced to review' }),
        });
        await fetch(`${mcUrl}/api/tasks/${e.id}`, {
          method: 'PATCH', headers: authHeaders, body: JSON.stringify({ status: 'review' }),
        });
      } else {
        await fetch(`${mcUrl}/api/tasks/${e.id}/return-to-orchestrator`, {
          method: 'POST', headers: authHeaders,
          body: JSON.stringify({ reason: 'recovery-sweep: REAL card with no on-disk evidence — re-route for triage' }),
        });
      }
      applied++;
    } catch (err) {
      console.error(`[recover-blocked] apply failed for ${e.id} (${e.action}):`, (err as Error).message);
    }
  }
  console.log(`\n[recover-blocked] APPLY complete — ${applied}/${ledger.length} cards actioned via the CC API.`);
}

// Run as a CLI only when invoked directly (importable by tests otherwise).
import { pathToFileURL } from 'url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[recover-blocked] FATAL:', (err as Error).message);
    process.exit(1);
  });
}

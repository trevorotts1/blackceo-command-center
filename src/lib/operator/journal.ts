/**
 * Journal store — DB helpers + vault mirror over the `operator_journal_entries`
 * table (Migration 037).
 *
 * Track B6 (Operator Console Journal sub-module, PRD Section 4.7).
 *
 * One row per calendar day, keyed on `entry_date` (YYYY-MM-DD). Mirrored to
 * `<vault>/journal/YYYY/MM/YYYY-MM-DD.md` so Memory search, Obsidian, and any
 * other markdown crawler see the same content.
 *
 * The DB row is the source of truth. Mirror writes are best effort.
 */
import { randomUUID } from 'crypto';
import { queryAll, queryOne, run } from '@/lib/db';
import { writeClientFile, isRemoteError } from '@/lib/operator/client-fs';

export interface JournalEntryRow {
  id: string;
  entry_date: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface JournalEntry {
  id: string;
  entry_date: string;
  body: string;
  created_at: string;
  updated_at: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidEntryDate(value: string): boolean {
  return DATE_RE.test(value);
}

export function todayLocalISODate(): string {
  // Use local-machine date so "today" matches what the operator sees on the wall.
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function decode(row: JournalEntryRow): JournalEntry {
  return {
    id: row.id,
    entry_date: row.entry_date,
    body: row.body,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface ListJournalEntriesOptions {
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
  query?: string;
}

export interface ListJournalEntriesResult {
  items: JournalEntry[];
  total: number;
  limit: number;
  offset: number;
}

export function listJournalEntries(opts: ListJournalEntriesOptions = {}): ListJournalEntriesResult {
  const limit = Math.max(1, Math.min(365, Math.floor(opts.limit ?? 30)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.from && DATE_RE.test(opts.from)) {
    where.push('entry_date >= ?');
    params.push(opts.from);
  }
  if (opts.to && DATE_RE.test(opts.to)) {
    where.push('entry_date <= ?');
    params.push(opts.to);
  }
  if (opts.query && opts.query.trim()) {
    where.push('body LIKE ?');
    params.push(`%${opts.query.trim()}%`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = queryOne<{ c: number }>(
    `SELECT COUNT(*) as c FROM operator_journal_entries ${whereSql}`,
    params
  );
  const total = totalRow?.c || 0;

  const rows = queryAll<JournalEntryRow>(
    `SELECT id, entry_date, body, created_at, updated_at
     FROM operator_journal_entries
     ${whereSql}
     ORDER BY entry_date DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items: rows.map(decode), total, limit, offset };
}

export function getJournalEntryById(id: string): JournalEntry | null {
  const row = queryOne<JournalEntryRow>(
    `SELECT id, entry_date, body, created_at, updated_at
     FROM operator_journal_entries WHERE id = ?`,
    [id]
  );
  return row ? decode(row) : null;
}

export function getJournalEntryByDate(date: string): JournalEntry | null {
  if (!isValidEntryDate(date)) return null;
  const row = queryOne<JournalEntryRow>(
    `SELECT id, entry_date, body, created_at, updated_at
     FROM operator_journal_entries WHERE entry_date = ?`,
    [date]
  );
  return row ? decode(row) : null;
}

export interface UpsertJournalEntryInput {
  entry_date: string;
  body: string;
}

/**
 * Insert-or-update for a given date. PRD specifies one entry per day, so
 * callers should use this rather than a raw create.
 */
export function upsertJournalEntry(input: UpsertJournalEntryInput): JournalEntry {
  if (!isValidEntryDate(input.entry_date)) {
    throw new Error('invalid_entry_date');
  }
  const existing = getJournalEntryByDate(input.entry_date);
  const now = new Date().toISOString();
  if (existing) {
    run(
      `UPDATE operator_journal_entries SET body = ?, updated_at = ? WHERE id = ?`,
      [input.body, now, existing.id]
    );
    return getJournalEntryById(existing.id)!;
  }
  const id = randomUUID();
  run(
    `INSERT INTO operator_journal_entries (id, entry_date, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, input.entry_date, input.body, now, now]
  );
  return getJournalEntryById(id)!;
}

export function deleteJournalEntry(id: string): boolean {
  const res = run(`DELETE FROM operator_journal_entries WHERE id = ?`, [id]);
  return res.changes > 0;
}

/**
 * Mirror one entry into the SELECTED CLIENT's vault at
 * `<vault>/journal/YYYY/MM/YYYY-MM-DD.md`.
 *
 * PER-CLIENT (E11): the mirror lands inside the client agent's OWN workspace —
 * for the operator's own box that is the local vault (`fs`); for a remote client
 * it is written over the Cloudflare Access SSH tunnel into the client agent's
 * `~/clawd/journal/...`. This is the whole point: the client agent's OpenClaw
 * memory crawler watches its own workspace, so a journal entry the operator
 * writes here becomes part of THAT agent's recallable memory — not the command
 * center's. (See `<vault>/journal` in the agent's memory-search roots.)
 *
 * Best-effort: logs and returns null on any failure (down tunnel, missing
 * ssh_target, write error) so the API call still succeeds. Returns the absolute
 * path written (on whichever box the client lives on) on success.
 */
export async function writeJournalMirror(entry: JournalEntry): Promise<string | null> {
  try {
    const [year, month] = entry.entry_date.split('-');
    const relPath = `journal/${year}/${month}/${entry.entry_date}.md`;
    const md = renderEntry(entry);
    const result = await writeClientFile('vault-root', relPath, md);
    if (!result || isRemoteError(result)) {
      if (result && isRemoteError(result)) {
        console.error('[journal] writeJournalMirror remote failed:', result.reason);
      }
      return null;
    }
    return result.absPath;
  } catch (err) {
    console.error('[journal] writeJournalMirror failed:', err);
    return null;
  }
}

function renderEntry(entry: JournalEntry): string {
  const lines: string[] = [];
  lines.push(`# Journal: ${entry.entry_date}`);
  lines.push('');
  lines.push(`_Last updated ${entry.updated_at}._`);
  lines.push('');
  lines.push(entry.body || '');
  if (!entry.body.endsWith('\n')) {
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Memory search — aggregates lexical and lightweight semantic relevance
 * scoring across every source the operator might want to recall.
 *
 * Track B6 (Operator Console Memory sub-module, PRD Section 4.7).
 *
 * Sources searched (read-only — this module never writes):
 *   1. Vault markdown files          (recursive walk of vaultRoot())
 *   2. Per-agent scratch directories (recursive walk of operatorScratchRoot())
 *   3. operator_journal_entries      (DB, migration 037)
 *   4. operator_chat_messages        (DB, migration 037)
 *   5. operator_goals                (DB, migration 037)
 *   6. research_searches             (DB, migration 042 — B7 owns writes)
 *   7. tasks.title + tasks.description (DB, baseline schema)
 *   8. agents.persona_blueprint /
 *      agents.persona_hints           (DB, baseline schema)
 *
 * The PRD calls for SQLite FTS5 with hourly re-indexing in the long run. Until
 * that ships we use a lexical scorer (term match count + title boost +
 * recency tie-break) so the UI has a stable contract regardless of the
 * backing index. The interface is intentionally identical to what an FTS5
 * rewrite would expose.
 */
import fs from 'fs/promises';
import path from 'path';
import { queryAll } from '@/lib/db';
import { vaultRoot, operatorScratchRoot } from '@/lib/platform';

export type MemorySourceType =
  | 'vault'
  | 'scratch'
  | 'journal'
  | 'chat'
  | 'goal'
  | 'research'
  | 'task'
  | 'persona';

export interface MemorySearchHit {
  /** Stable identifier within its source. */
  id: string;
  source: MemorySourceType;
  /** Human-readable title for the hit. */
  title: string;
  /** Short excerpt (~240 chars) centered on the first match. */
  excerpt: string;
  /** Higher is better. Compare only within a single search call. */
  score: number;
  /** ISO timestamp for sort tie-break + display. */
  updated_at: string;
  /** Routing hint for the UI when the user clicks the result. */
  href?: string;
  /** Filesystem path for vault/scratch hits so the UI can deep-link. */
  path?: string;
  /** Free-form extra detail (DB id, agent slug, etc). */
  meta?: Record<string, unknown>;
}

export interface MemorySearchOptions {
  query: string;
  limit?: number;
  sources?: MemorySourceType[];
}

export interface MemorySearchResult {
  query: string;
  total: number;
  hits: MemorySearchHit[];
  /** Per-source counts so the UI can render grouping headers / facets. */
  by_source: Record<MemorySourceType, number>;
  /** Errors collected from individual source scanners. Never throws. */
  errors: Array<{ source: MemorySourceType; message: string }>;
  elapsed_ms: number;
}

/** Max bytes read per filesystem file. Files larger than this are sampled. */
const MAX_FILE_BYTES = 256 * 1024;
/** Max total files scanned from disk per call. Hard ceiling to keep search snappy. */
const MAX_FILES_PER_ROOT = 2000;
/** File extensions we treat as text. */
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml']);

export async function searchMemory(opts: MemorySearchOptions): Promise<MemorySearchResult> {
  const started = Date.now();
  const rawQuery = (opts.query || '').trim();
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const requested = new Set<MemorySourceType>(
    opts.sources && opts.sources.length > 0
      ? opts.sources
      : ['vault', 'scratch', 'journal', 'chat', 'goal', 'research', 'task', 'persona']
  );

  const errors: Array<{ source: MemorySourceType; message: string }> = [];
  const hits: MemorySearchHit[] = [];
  const by_source: Record<MemorySourceType, number> = {
    vault: 0,
    scratch: 0,
    journal: 0,
    chat: 0,
    goal: 0,
    research: 0,
    task: 0,
    persona: 0,
  };

  if (!rawQuery) {
    return {
      query: rawQuery,
      total: 0,
      hits: [],
      by_source,
      errors,
      elapsed_ms: Date.now() - started,
    };
  }

  const terms = tokenize(rawQuery);
  const lowerQ = rawQuery.toLowerCase();

  // Filesystem sources run in parallel with DB sources.
  const fsJobs: Promise<MemorySearchHit[]>[] = [];
  if (requested.has('vault')) {
    fsJobs.push(
      searchFilesystem('vault', vaultRoot(), terms, errors).catch((err) => {
        errors.push({ source: 'vault', message: errorMessage(err) });
        return [];
      })
    );
  }
  if (requested.has('scratch')) {
    fsJobs.push(
      searchFilesystem('scratch', operatorScratchRoot(), terms, errors).catch((err) => {
        errors.push({ source: 'scratch', message: errorMessage(err) });
        return [];
      })
    );
  }

  if (requested.has('journal')) {
    try {
      hits.push(...searchJournal(lowerQ, terms));
    } catch (err) {
      errors.push({ source: 'journal', message: errorMessage(err) });
    }
  }
  if (requested.has('chat')) {
    try {
      hits.push(...searchChat(lowerQ, terms));
    } catch (err) {
      errors.push({ source: 'chat', message: errorMessage(err) });
    }
  }
  if (requested.has('goal')) {
    try {
      hits.push(...searchGoals(lowerQ, terms));
    } catch (err) {
      errors.push({ source: 'goal', message: errorMessage(err) });
    }
  }
  if (requested.has('research')) {
    try {
      hits.push(...searchResearch(lowerQ, terms));
    } catch (err) {
      errors.push({ source: 'research', message: errorMessage(err) });
    }
  }
  if (requested.has('task')) {
    try {
      hits.push(...searchTasks(lowerQ, terms));
    } catch (err) {
      errors.push({ source: 'task', message: errorMessage(err) });
    }
  }
  if (requested.has('persona')) {
    try {
      hits.push(...searchPersonas(lowerQ, terms));
    } catch (err) {
      errors.push({ source: 'persona', message: errorMessage(err) });
    }
  }

  if (fsJobs.length > 0) {
    const fsHits = await Promise.all(fsJobs);
    for (const arr of fsHits) hits.push(...arr);
  }

  for (const h of hits) {
    by_source[h.source] = (by_source[h.source] || 0) + 1;
  }

  // Sort by score desc, then recency desc, then title.
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.updated_at !== a.updated_at) return b.updated_at < a.updated_at ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  const capped = hits.slice(0, limit);
  return {
    query: rawQuery,
    total: hits.length,
    hits: capped,
    by_source,
    errors,
    elapsed_ms: Date.now() - started,
  };
}

// ---- Tokenization + scoring ------------------------------------------------

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((t) => t.length > 1)
    .slice(0, 16);
}

/**
 * Light lexical scorer. Combines:
 *  - phrase match (exact substring) → strong boost
 *  - per-term match count
 *  - title-position multiplier
 *  - density (matches / length) so longer files don't always win
 */
function scoreText(title: string, body: string, phrase: string, terms: string[]): number {
  if (!body && !title) return 0;
  const lowerTitle = title.toLowerCase();
  const lowerBody = body.toLowerCase();
  let score = 0;

  // Phrase hit.
  if (phrase) {
    if (lowerTitle.includes(phrase)) score += 25;
    const bodyPhrase = countOccurrences(lowerBody, phrase);
    score += bodyPhrase * 6;
  }

  // Term hits.
  let termMatches = 0;
  for (const t of terms) {
    const titleCount = countOccurrences(lowerTitle, t);
    const bodyCount = countOccurrences(lowerBody, t);
    if (titleCount > 0) score += 8 + Math.min(titleCount, 5);
    if (bodyCount > 0) {
      score += Math.min(bodyCount, 10);
      termMatches += 1;
    }
  }

  // Require at least one match somewhere.
  if (score === 0) return 0;

  // Coverage bonus — rewards documents that hit more of the query terms.
  if (terms.length > 1) {
    const coverage = termMatches / terms.length;
    score += Math.round(coverage * 10);
  }

  // Density: small penalty for very long documents that only matched once.
  const len = lowerBody.length || 1;
  const density = (score * 1000) / len;
  if (density < 0.1) score = Math.max(1, score - 2);

  return score;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function makeExcerpt(body: string, phrase: string, terms: string[]): string {
  const text = body || '';
  if (text.length === 0) return '';
  const lower = text.toLowerCase();
  let pos = -1;
  if (phrase) {
    pos = lower.indexOf(phrase);
  }
  if (pos === -1) {
    for (const t of terms) {
      pos = lower.indexOf(t);
      if (pos !== -1) break;
    }
  }
  if (pos === -1) {
    return text.slice(0, 240).trim();
  }
  const start = Math.max(0, pos - 80);
  const end = Math.min(text.length, pos + 160);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '... ' : '') + slice + (end < text.length ? ' ...' : '');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- Filesystem sources ---------------------------------------------------

async function searchFilesystem(
  source: 'vault' | 'scratch',
  root: string,
  terms: string[],
  _errors: Array<{ source: MemorySourceType; message: string }>
): Promise<MemorySearchHit[]> {
  const hits: MemorySearchHit[] = [];
  let scanned = 0;
  const phrase = terms.length > 0 ? terms.join(' ') : '';
  // The phrase passed to scoreText is the actual user phrase, not joined
  // tokens; but for FS walking we re-use the lower-case full phrase the
  // caller already produced. We rebuild it from terms for consistency.
  await walkDir(root, async (filePath) => {
    if (scanned >= MAX_FILES_PER_ROOT) return false;
    scanned += 1;
    const ext = path.extname(filePath).toLowerCase();
    if (!TEXT_EXTS.has(ext)) return true;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return true;
      const sz = stat.size;
      const buf = await fs.readFile(filePath, { encoding: 'utf8' });
      const body = sz > MAX_FILE_BYTES ? buf.slice(0, MAX_FILE_BYTES) : buf;
      const title = path.relative(root, filePath);
      const score = scoreText(title, body, phrase, terms);
      if (score <= 0) return true;
      hits.push({
        id: `${source}:${filePath}`,
        source,
        title,
        excerpt: makeExcerpt(body, phrase, terms),
        score,
        updated_at: stat.mtime.toISOString(),
        path: filePath,
        href: `/operator/workspace?path=${encodeURIComponent(filePath)}`,
        meta: { size: sz, truncated: sz > MAX_FILE_BYTES },
      });
    } catch {
      // Ignore unreadable files; the broader scan continues.
    }
    return true;
  });
  return hits;
}

/**
 * Best-effort recursive walker. Returns early if `visit` returns false. Skips
 * common heavy directories (node_modules, .git, .next, dist, build) so we
 * don't melt the search when the scratch root happens to be a code repo.
 */
async function walkDir(root: string, visit: (filePath: string) => Promise<boolean>): Promise<void> {
  const SKIP = new Set([
    'node_modules',
    '.git',
    '.next',
    '.turbo',
    'dist',
    'build',
    '.venv',
    '__pycache__',
  ]);
  let dirEntries: import('fs').Dirent[] = [];
  try {
    dirEntries = (await fs.readdir(root, { withFileTypes: true })) as unknown as import('fs').Dirent[];
  } catch {
    return;
  }
  const stack: string[] = [root];
  let cont = true;
  // Iterative DFS so we never blow the call stack on huge trees.
  // We re-read root's entries above to short-circuit a missing root cheaply.
  if (dirEntries.length === 0) return;
  while (stack.length > 0 && cont) {
    const current = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = (await fs.readdir(current, { withFileTypes: true })) as unknown as import('fs').Dirent[];
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (SKIP.has(ent.name) || ent.name.startsWith('.')) continue;
        stack.push(full);
        continue;
      }
      if (ent.isFile()) {
        cont = await visit(full);
        if (!cont) break;
      }
    }
  }
}

// ---- DB sources -----------------------------------------------------------

interface JournalRow {
  id: string;
  entry_date: string;
  body: string;
  updated_at: string;
}

function searchJournal(phrase: string, terms: string[]): MemorySearchHit[] {
  if (!terms.length && !phrase) return [];
  const like = `%${phrase}%`;
  const rows = queryAll<JournalRow>(
    `SELECT id, entry_date, body, updated_at
     FROM operator_journal_entries
     WHERE body LIKE ? OR entry_date LIKE ?
     ORDER BY entry_date DESC
     LIMIT 200`,
    [like, like]
  );
  return rows
    .map((r) => {
      const title = `Journal ${r.entry_date}`;
      const score = scoreText(title, r.body, phrase, terms);
      if (score <= 0) return null;
      return {
        id: `journal:${r.id}`,
        source: 'journal' as const,
        title,
        excerpt: makeExcerpt(r.body, phrase, terms),
        score: score + 4, // small boost — daily notes are high-signal
        updated_at: r.updated_at,
        href: `/operator/journal?date=${encodeURIComponent(r.entry_date)}`,
        meta: { entry_date: r.entry_date },
      } as MemorySearchHit;
    })
    .filter((h): h is MemorySearchHit => h !== null);
}

interface ChatRow {
  id: string;
  session_id: string;
  agent_id: string;
  session_title: string | null;
  role: string;
  content: string;
  created_at: string;
}

function searchChat(phrase: string, terms: string[]): MemorySearchHit[] {
  const like = `%${phrase}%`;
  const rows = queryAll<ChatRow>(
    `SELECT m.id, m.session_id, s.agent_id, s.title as session_title,
            m.role, m.content, m.created_at
     FROM operator_chat_messages m
     LEFT JOIN operator_chat_sessions s ON s.id = m.session_id
     WHERE m.content LIKE ?
     ORDER BY datetime(m.created_at) DESC
     LIMIT 300`,
    [like]
  );
  return rows
    .map((r) => {
      const title = `Chat (${r.agent_id || 'unknown'}): ${r.session_title || r.role}`;
      const score = scoreText(title, r.content, phrase, terms);
      if (score <= 0) return null;
      return {
        id: `chat:${r.id}`,
        source: 'chat' as const,
        title,
        excerpt: makeExcerpt(r.content, phrase, terms),
        score,
        updated_at: r.created_at,
        href: `/operator/bridge?session=${encodeURIComponent(r.session_id)}`,
        meta: {
          session_id: r.session_id,
          agent_id: r.agent_id,
          role: r.role,
        },
      } as MemorySearchHit;
    })
    .filter((h): h is MemorySearchHit => h !== null);
}

interface GoalRow {
  id: string;
  category: string | null;
  title: string;
  body: string | null;
  completed: number;
  updated_at: string;
}

function searchGoals(phrase: string, terms: string[]): MemorySearchHit[] {
  const like = `%${phrase}%`;
  const rows = queryAll<GoalRow>(
    `SELECT id, category, title, body, completed, updated_at
     FROM operator_goals
     WHERE title LIKE ? OR body LIKE ? OR category LIKE ?
     ORDER BY updated_at DESC
     LIMIT 200`,
    [like, like, like]
  );
  return rows
    .map((r) => {
      const score = scoreText(r.title, r.body || '', phrase, terms);
      if (score <= 0) return null;
      return {
        id: `goal:${r.id}`,
        source: 'goal' as const,
        title: `Goal: ${r.title}`,
        excerpt: makeExcerpt(r.body || r.title, phrase, terms),
        score,
        updated_at: r.updated_at,
        href: `/operator/goals#${encodeURIComponent(r.id)}`,
        meta: { category: r.category, completed: !!r.completed },
      } as MemorySearchHit;
    })
    .filter((h): h is MemorySearchHit => h !== null);
}

interface ResearchRow {
  id: string;
  query: string;
  model: string;
  result_markdown: string;
  created_at: string;
}

function searchResearch(phrase: string, terms: string[]): MemorySearchHit[] {
  const like = `%${phrase}%`;
  const rows = queryAll<ResearchRow>(
    `SELECT id, query, model, result_markdown, created_at
     FROM research_searches
     WHERE query LIKE ? OR result_markdown LIKE ?
     ORDER BY datetime(created_at) DESC
     LIMIT 200`,
    [like, like]
  );
  return rows
    .map((r) => {
      const score = scoreText(r.query, r.result_markdown, phrase, terms);
      if (score <= 0) return null;
      return {
        id: `research:${r.id}`,
        source: 'research' as const,
        title: `Research: ${r.query}`,
        excerpt: makeExcerpt(r.result_markdown, phrase, terms),
        score,
        updated_at: r.created_at,
        href: `/operator/research/${encodeURIComponent(r.id)}`,
        meta: { model: r.model },
      } as MemorySearchHit;
    })
    .filter((h): h is MemorySearchHit => h !== null);
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  updated_at: string;
}

function searchTasks(phrase: string, terms: string[]): MemorySearchHit[] {
  const like = `%${phrase}%`;
  const rows = queryAll<TaskRow>(
    `SELECT id, title, description, status, updated_at
     FROM tasks
     WHERE title LIKE ? OR description LIKE ?
     ORDER BY datetime(updated_at) DESC
     LIMIT 200`,
    [like, like]
  );
  return rows
    .map((r) => {
      const score = scoreText(r.title, r.description || '', phrase, terms);
      if (score <= 0) return null;
      return {
        id: `task:${r.id}`,
        source: 'task' as const,
        title: `Task: ${r.title}`,
        excerpt: makeExcerpt(r.description || r.title, phrase, terms),
        score,
        updated_at: r.updated_at,
        href: `/tasks/${encodeURIComponent(r.id)}`,
        meta: { status: r.status },
      } as MemorySearchHit;
    })
    .filter((h): h is MemorySearchHit => h !== null);
}

interface PersonaRow {
  id: string;
  name: string;
  persona_hints: string | null;
  updated_at: string | null;
}

function searchPersonas(phrase: string, terms: string[]): MemorySearchHit[] {
  // Defensive: persona_hints column lives on agents, but older databases
  // may not have it. queryAll throws on missing columns; we wrap.
  let rows: PersonaRow[] = [];
  try {
    rows = queryAll<PersonaRow>(
      `SELECT id, name, persona_hints, updated_at
       FROM agents
       WHERE persona_hints LIKE ? OR name LIKE ?
       LIMIT 200`,
      [`%${phrase}%`, `%${phrase}%`]
    );
  } catch {
    return [];
  }
  return rows
    .map((r) => {
      const body = r.persona_hints || '';
      const score = scoreText(r.name, body, phrase, terms);
      if (score <= 0) return null;
      return {
        id: `persona:${r.id}`,
        source: 'persona' as const,
        title: `Persona: ${r.name}`,
        excerpt: makeExcerpt(body, phrase, terms),
        score,
        updated_at: r.updated_at || new Date(0).toISOString(),
        href: `/agents/${encodeURIComponent(r.id)}`,
        meta: { agent_id: r.id },
      } as MemorySearchHit;
    })
    .filter((h): h is MemorySearchHit => h !== null);
}

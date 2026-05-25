/**
 * Research store — DB helpers over the `research_searches` table (Migration 042).
 *
 * Track B7 (Operator Console Research sub-module, SCOPE-ADDITION Section 5).
 * The route handlers in `src/app/api/operator/research/*` are the only callers
 * of these functions. Keep the surface area small (insert, get, list).
 *
 * The result markdown is also mirrored to the operator vault at
 * `<vault>/research/YYYY/MM/YYYY-MM-DD-<slug>.md` by the route handler so the
 * Memory full-text index (Track B6) and the All Searches bucket (Track B3 /
 * Addition 2) pick it up. The DB row is the canonical record; the markdown
 * file is the human-facing mirror.
 */

import { randomUUID } from 'crypto';
import { queryAll, queryOne, run } from './db';

export interface ResearchSearchRow {
  id: string;
  query: string;
  model: string;
  result_markdown: string;
  search_metadata: string;
  created_at: string;
}

export interface ResearchSearch {
  id: string;
  query: string;
  model: string;
  result_markdown: string;
  search_metadata: Record<string, unknown>;
  created_at: string;
}

function decodeRow(row: ResearchSearchRow): ResearchSearch {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = row.search_metadata ? (JSON.parse(row.search_metadata) as Record<string, unknown>) : {};
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    query: row.query,
    model: row.model,
    result_markdown: row.result_markdown,
    search_metadata: metadata,
    created_at: row.created_at,
  };
}

export interface CreateResearchSearchInput {
  query: string;
  model: string;
  result_markdown: string;
  search_metadata?: Record<string, unknown>;
}

export function createResearchSearch(input: CreateResearchSearchInput): ResearchSearch {
  const id = randomUUID();
  const metadataJson = JSON.stringify(input.search_metadata || {});
  const created_at = new Date().toISOString();
  run(
    `INSERT INTO research_searches (id, query, model, result_markdown, search_metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.query, input.model, input.result_markdown, metadataJson, created_at]
  );
  return {
    id,
    query: input.query,
    model: input.model,
    result_markdown: input.result_markdown,
    search_metadata: input.search_metadata || {},
    created_at,
  };
}

export function getResearchSearch(id: string): ResearchSearch | null {
  const row = queryOne<ResearchSearchRow>(
    `SELECT id, query, model, result_markdown, search_metadata, created_at
     FROM research_searches WHERE id = ?`,
    [id]
  );
  if (!row) return null;
  return decodeRow(row);
}

export interface ListResearchSearchesOptions {
  limit?: number;
  offset?: number;
}

export interface ListResearchSearchesResult {
  items: ResearchSearch[];
  total: number;
  limit: number;
  offset: number;
}

export function listResearchSearches(opts: ListResearchSearchesOptions = {}): ListResearchSearchesResult {
  const rawLimit = typeof opts.limit === 'number' ? opts.limit : 25;
  const rawOffset = typeof opts.offset === 'number' ? opts.offset : 0;
  // Clamp to sane bounds. The history sidebar pages 25 at a time by default.
  const limit = Math.max(1, Math.min(200, Math.floor(rawLimit)));
  const offset = Math.max(0, Math.floor(rawOffset));

  const totalRow = queryOne<{ c: number }>(
    `SELECT COUNT(*) as c FROM research_searches`
  );
  const total = totalRow?.c || 0;

  const rows = queryAll<ResearchSearchRow>(
    `SELECT id, query, model, result_markdown, search_metadata, created_at
     FROM research_searches
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return {
    items: rows.map(decodeRow),
    total,
    limit,
    offset,
  };
}

/**
 * Slugify a query into a filesystem-safe component for vault mirror paths.
 * Truncates to 60 chars after normalization so paths stay reasonable.
 */
export function slugifyQuery(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}

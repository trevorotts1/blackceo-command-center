/**
 * Notebook store - DB helpers over the `notebooks` and `notebook_sources`
 * tables (Migration 040).
 *
 * Track B5 (PRD Section 4.6). The route handlers in
 * `src/app/api/operator/notebook/*` are the only callers of these functions.
 * Keep the surface area small: list, get, create, update, delete + source
 * CRUD.
 *
 * The DB row is the canonical record. NotebookLM-side state (remote_id,
 * source.remote_id) is stored alongside so the adapter in
 * `notebooklm-client.ts` can round-trip without re-uploading.
 */

import { randomUUID } from 'crypto';
import { queryAll, queryOne, run, transaction } from '../db';

export type NotebookBackend = 'notebooklm' | 'gemini-local';

export type NotebookSourceType =
  | 'pdf'
  | 'text'
  | 'markdown'
  | 'url'
  | 'audio'
  | 'video';

export interface NotebookRow {
  id: string;
  title: string;
  description: string | null;
  backend: NotebookBackend;
  remote_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotebookSourceRow {
  id: string;
  notebook_id: string;
  source_type: NotebookSourceType;
  title: string | null;
  path: string | null;
  url: string | null;
  remote_id: string | null;
  byte_size: number | null;
  created_at: string;
}

export interface Notebook extends NotebookRow {
  source_count: number;
}

export interface NotebookWithSources extends NotebookRow {
  sources: NotebookSourceRow[];
}

export interface CreateNotebookInput {
  title: string;
  description?: string | null;
  backend?: NotebookBackend;
  remote_id?: string | null;
}

export interface UpdateNotebookInput {
  title?: string;
  description?: string | null;
  backend?: NotebookBackend;
  remote_id?: string | null;
}

export interface CreateNotebookSourceInput {
  notebook_id: string;
  source_type: NotebookSourceType;
  title?: string | null;
  path?: string | null;
  url?: string | null;
  remote_id?: string | null;
  byte_size?: number | null;
}

const VALID_BACKENDS: readonly NotebookBackend[] = ['notebooklm', 'gemini-local'];
const VALID_SOURCE_TYPES: readonly NotebookSourceType[] = [
  'pdf',
  'text',
  'markdown',
  'url',
  'audio',
  'video',
];

export function isNotebookBackend(value: unknown): value is NotebookBackend {
  return typeof value === 'string' && (VALID_BACKENDS as readonly string[]).includes(value);
}

export function isNotebookSourceType(value: unknown): value is NotebookSourceType {
  return (
    typeof value === 'string' && (VALID_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

export function listNotebooks(): Notebook[] {
  const rows = queryAll<NotebookRow & { source_count: number }>(
    `SELECT n.id, n.title, n.description, n.backend, n.remote_id,
            n.created_at, n.updated_at,
            COALESCE((SELECT COUNT(*) FROM notebook_sources s WHERE s.notebook_id = n.id), 0) AS source_count
       FROM notebooks n
       ORDER BY n.updated_at DESC`,
    []
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    backend: r.backend,
    remote_id: r.remote_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    source_count: Number(r.source_count) || 0,
  }));
}

export function getNotebook(id: string): NotebookWithSources | null {
  const row = queryOne<NotebookRow>(
    `SELECT id, title, description, backend, remote_id, created_at, updated_at
       FROM notebooks WHERE id = ?`,
    [id]
  );
  if (!row) return null;
  const sources = queryAll<NotebookSourceRow>(
    `SELECT id, notebook_id, source_type, title, path, url, remote_id, byte_size, created_at
       FROM notebook_sources WHERE notebook_id = ? ORDER BY created_at ASC`,
    [id]
  );
  return { ...row, sources };
}

export function createNotebook(input: CreateNotebookInput): NotebookWithSources {
  const id = randomUUID();
  const created_at = nowIso();
  const updated_at = created_at;
  const backend: NotebookBackend = input.backend && isNotebookBackend(input.backend)
    ? input.backend
    : 'notebooklm';

  run(
    `INSERT INTO notebooks (id, title, description, backend, remote_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.title, input.description ?? null, backend, input.remote_id ?? null, created_at, updated_at]
  );

  return {
    id,
    title: input.title,
    description: input.description ?? null,
    backend,
    remote_id: input.remote_id ?? null,
    created_at,
    updated_at,
    sources: [],
  };
}

export function updateNotebook(id: string, input: UpdateNotebookInput): NotebookWithSources | null {
  const existing = queryOne<NotebookRow>(
    `SELECT id, title, description, backend, remote_id, created_at, updated_at
       FROM notebooks WHERE id = ?`,
    [id]
  );
  if (!existing) return null;

  const next: NotebookRow = {
    id: existing.id,
    title: input.title !== undefined ? input.title : existing.title,
    description: input.description !== undefined ? input.description : existing.description,
    backend:
      input.backend !== undefined && isNotebookBackend(input.backend)
        ? input.backend
        : existing.backend,
    remote_id: input.remote_id !== undefined ? input.remote_id : existing.remote_id,
    created_at: existing.created_at,
    updated_at: nowIso(),
  };

  run(
    `UPDATE notebooks SET title = ?, description = ?, backend = ?, remote_id = ?, updated_at = ?
       WHERE id = ?`,
    [next.title, next.description, next.backend, next.remote_id, next.updated_at, id]
  );

  return getNotebook(id);
}

export function deleteNotebook(id: string): boolean {
  const res = run(`DELETE FROM notebooks WHERE id = ?`, [id]);
  return res.changes > 0;
}

export function addNotebookSource(input: CreateNotebookSourceInput): NotebookSourceRow | null {
  if (!isNotebookSourceType(input.source_type)) return null;
  const id = randomUUID();
  const created_at = nowIso();

  return transaction(() => {
    const notebook = queryOne<{ id: string }>(`SELECT id FROM notebooks WHERE id = ?`, [
      input.notebook_id,
    ]);
    if (!notebook) return null;

    run(
      `INSERT INTO notebook_sources (id, notebook_id, source_type, title, path, url, remote_id, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.notebook_id,
        input.source_type,
        input.title ?? null,
        input.path ?? null,
        input.url ?? null,
        input.remote_id ?? null,
        input.byte_size ?? null,
        created_at,
      ]
    );
    // Touch the notebook so it floats to the top of the list.
    run(`UPDATE notebooks SET updated_at = ? WHERE id = ?`, [nowIso(), input.notebook_id]);

    return {
      id,
      notebook_id: input.notebook_id,
      source_type: input.source_type,
      title: input.title ?? null,
      path: input.path ?? null,
      url: input.url ?? null,
      remote_id: input.remote_id ?? null,
      byte_size: input.byte_size ?? null,
      created_at,
    };
  });
}

export function removeNotebookSource(notebookId: string, sourceId: string): boolean {
  const res = run(
    `DELETE FROM notebook_sources WHERE id = ? AND notebook_id = ?`,
    [sourceId, notebookId]
  );
  if (res.changes > 0) {
    run(`UPDATE notebooks SET updated_at = ? WHERE id = ?`, [nowIso(), notebookId]);
    return true;
  }
  return false;
}

export function listNotebookSources(notebookId: string): NotebookSourceRow[] {
  return queryAll<NotebookSourceRow>(
    `SELECT id, notebook_id, source_type, title, path, url, remote_id, byte_size, created_at
       FROM notebook_sources WHERE notebook_id = ? ORDER BY created_at ASC`,
    [notebookId]
  );
}

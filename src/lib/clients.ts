/**
 * Client (tenant) resolver — the SINGLE-TENANT → PER-CLIENT foundation.
 *
 * Root cause this fixes: every OpenClaw / key / memory / analytics code path
 * used to read the Command Center's OWN host. There was no notion of a
 * "selected client". This module is the typed source of truth for:
 *
 *   - the registry of managed boxes (the operator's own box + remote clients),
 *   - which client is currently SELECTED (a cookie, defaulting to self),
 *   - the full connection record (gateway URL/token + CF-Access service token
 *     + filesystem roots) feature clusters need to talk to that box.
 *
 * Reads go through `getDb()` against the `clients` table (migration 048).
 *
 * SECURITY: `Client` carries secrets (gateway_token, cf_access_client_secret).
 * It is SERVER-ONLY. Never return it to the browser. Use `toPublicClient()`
 * (see below) when shaping an API response.
 */

import { cookies } from 'next/headers';
import { getDb } from '@/lib/db';

export const SELECTED_CLIENT_COOKIE = 'selectedClientId';

/** Full server-side connection record. Contains secrets — never send to UI. */
export interface Client {
  id: string;
  name: string;
  gateway_url: string;
  gateway_token: string | null;
  cf_access_client_id: string | null;
  cf_access_client_secret: string | null;
  workspace_root: string | null;
  ssh_target: string | null;
  interview_complete: boolean;
  is_self: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/** Browser-safe view of a client. Secrets are reduced to boolean presence. */
export interface PublicClient {
  id: string;
  name: string;
  gateway_url: string;
  workspace_root: string | null;
  ssh_target: string | null;
  interview_complete: boolean;
  is_self: boolean;
  /** True when a gateway token is configured (value itself is never sent). */
  has_gateway_token: boolean;
  /** True when a CF-Access service token pair is configured. */
  has_cf_access: boolean;
  created_at: string | null;
  updated_at: string | null;
}

interface ClientRow {
  id: string;
  name: string;
  gateway_url: string;
  gateway_token: string | null;
  cf_access_client_id: string | null;
  cf_access_client_secret: string | null;
  workspace_root: string | null;
  ssh_target: string | null;
  interview_complete: number;
  is_self: number;
  created_at: string | null;
  updated_at: string | null;
}

function rowToClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    gateway_url: row.gateway_url,
    gateway_token: row.gateway_token,
    cf_access_client_id: row.cf_access_client_id,
    cf_access_client_secret: row.cf_access_client_secret,
    workspace_root: row.workspace_root,
    ssh_target: row.ssh_target,
    interview_complete: row.interview_complete === 1,
    is_self: row.is_self === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SELECT_COLS =
  'id, name, gateway_url, gateway_token, cf_access_client_id, cf_access_client_secret, workspace_root, ssh_target, interview_complete, is_self, created_at, updated_at';

/** Strip secrets for a browser-safe response. */
export function toPublicClient(client: Client): PublicClient {
  return {
    id: client.id,
    name: client.name,
    gateway_url: client.gateway_url,
    workspace_root: client.workspace_root,
    ssh_target: client.ssh_target,
    interview_complete: client.interview_complete,
    is_self: client.is_self,
    has_gateway_token: !!client.gateway_token,
    has_cf_access: !!(client.cf_access_client_id && client.cf_access_client_secret),
    created_at: client.created_at,
    updated_at: client.updated_at,
  };
}

/** All clients, self first, then by name. */
export function listClients(): Client[] {
  const rows = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM clients ORDER BY is_self DESC, name ASC`)
    .all() as ClientRow[];
  return rows.map(rowToClient);
}

/** A single client by id, or null. */
export function getClient(id: string): Client | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM clients WHERE id = ?`)
    .get(id) as ClientRow | undefined;
  return row ? rowToClient(row) : null;
}

/** The operator's own (is_self=1) client, or null if it has not been seeded. */
export function getSelfClient(): Client | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM clients WHERE is_self = 1 LIMIT 1`)
    .get() as ClientRow | undefined;
  return row ? rowToClient(row) : null;
}

/**
 * The id of the currently selected client, read from the `selectedClientId`
 * cookie. Falls back to the self row's id when the cookie is missing or points
 * at a client that no longer exists. Never throws (in a non-request context the
 * cookie read fails gracefully and we fall back to self).
 */
export function getSelectedClientId(): string | null {
  let cookieId: string | undefined;
  try {
    cookieId = cookies().get(SELECTED_CLIENT_COOKIE)?.value;
  } catch {
    // Called outside a request scope (e.g. a cron job). Fall back to self.
    cookieId = undefined;
  }

  if (cookieId && getClient(cookieId)) {
    return cookieId;
  }
  return getSelfClient()?.id ?? null;
}

/**
 * The full connection record for the currently selected client. Falls back to
 * the self client. Returns null only when the clients table is empty (should
 * not happen after migration 048 seeds the self row).
 */
export function getClientContext(): Client | null {
  const id = getSelectedClientId();
  if (!id) return getSelfClient();
  return getClient(id) ?? getSelfClient();
}

export interface CreateClientInput {
  name: string;
  gateway_url?: string;
  gateway_token?: string | null;
  cf_access_client_id?: string | null;
  cf_access_client_secret?: string | null;
  workspace_root?: string | null;
  ssh_target?: string | null;
  interview_complete?: boolean;
}

/** Create a remote client (is_self is always 0 — self is seeded by migration). */
export function createClient(input: CreateClientInput): Client {
  const id = crypto.randomUUID();
  getDb()
    .prepare(`
      INSERT INTO clients
        (id, name, gateway_url, gateway_token, cf_access_client_id,
         cf_access_client_secret, workspace_root, ssh_target,
         interview_complete, is_self)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `)
    .run(
      id,
      input.name,
      input.gateway_url || 'ws://127.0.0.1:18789',
      input.gateway_token ?? null,
      input.cf_access_client_id ?? null,
      input.cf_access_client_secret ?? null,
      input.workspace_root ?? null,
      input.ssh_target ?? null,
      input.interview_complete ? 1 : 0
    );
  const created = getClient(id);
  if (!created) throw new Error('Failed to create client');
  return created;
}

export type UpdateClientInput = Partial<CreateClientInput>;

/** Patch a client. Only provided fields are touched. Returns the new record. */
export function updateClient(id: string, patch: UpdateClientInput): Client | null {
  const existing = getClient(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  const assign = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    params.push(val);
  };

  if (patch.name !== undefined) assign('name', patch.name);
  if (patch.gateway_url !== undefined) assign('gateway_url', patch.gateway_url);
  if (patch.gateway_token !== undefined) assign('gateway_token', patch.gateway_token);
  if (patch.cf_access_client_id !== undefined) assign('cf_access_client_id', patch.cf_access_client_id);
  if (patch.cf_access_client_secret !== undefined) assign('cf_access_client_secret', patch.cf_access_client_secret);
  if (patch.workspace_root !== undefined) assign('workspace_root', patch.workspace_root);
  if (patch.ssh_target !== undefined) assign('ssh_target', patch.ssh_target);
  if (patch.interview_complete !== undefined) assign('interview_complete', patch.interview_complete ? 1 : 0);

  if (sets.length === 0) return existing;

  sets.push(`updated_at = datetime('now')`);
  params.push(id);
  getDb().prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getClient(id);
}

/**
 * Set the selected client cookie. Must be called from a Server Action or Route
 * Handler (anywhere `cookies()` is writable). Validates the id exists first.
 * Returns false when the id is unknown.
 */
export function setSelectedClient(id: string): boolean {
  if (!getClient(id)) return false;
  cookies().set(SELECTED_CLIENT_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
  return true;
}

/**
 * Per-client AI Workforce interview flag accessor (E3). DB-backed and
 * client-scoped, unlike the host-wide filesystem detection in
 * `interview-state.ts`. Reads default to the selected client.
 */
export function getInterviewComplete(clientId?: string): boolean {
  const id = clientId ?? getSelectedClientId();
  if (!id) return false;
  return getClient(id)?.interview_complete ?? false;
}

/**
 * Backfill helper: mark an already-onboarded client's interview complete.
 * Returns the updated record (or null if the id is unknown).
 */
export function setInterviewComplete(clientId: string, complete = true): Client | null {
  return updateClient(clientId, { interview_complete: complete });
}

/** True when the given client (or the selected one) is the operator's own box. */
export function isSelfClient(client?: Client | null): boolean {
  const c = client ?? getClientContext();
  return !!c?.is_self;
}

/**
 * Connection target for the OpenClaw gateway factory. Pass this to
 * `getOpenClawClient(clientToOpenClawTarget(client))` so the connection carries
 * the client's gateway token + Cloudflare Access service-token headers. For the
 * self/local client this resolves to the loopback default.
 */
export interface OpenClawTarget {
  id: string;
  url: string;
  token?: string | null;
  cfAccessClientId?: string | null;
  cfAccessClientSecret?: string | null;
}

export function clientToOpenClawTarget(client: Client): OpenClawTarget {
  return {
    id: client.is_self ? '__self__' : client.id,
    url: client.gateway_url,
    token: client.gateway_token,
    cfAccessClientId: client.cf_access_client_id,
    cfAccessClientSecret: client.cf_access_client_secret,
  };
}

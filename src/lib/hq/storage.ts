/**
 * Company Headquarters — typed persistence decoders and schema readiness
 * (unit B01, milestone V02).
 *
 * Authority: SPEC.md revision 4, section S6, and the frozen storage contract
 * `evidence/contracts/storage-auth.md` §a/§b. The ONLY DDL for these tables
 * lives in reserved migration `169` (`src/lib/db/migrations.ts`, single writer
 * B01, per-table families inside ONE migration — no per-table separate
 * migration workers).
 *
 * What this module is NOT: it is not the activity writer (B05), the chat state
 * machine (B09) or the run-binding writer (B20). It owns the row SHAPES, the
 * decoder that turns a raw SQLite row into those shapes, and the readiness
 * probe. Row types are declared here rather than in `src/lib/hq/types.ts`
 * because that file is P01's (B01 card: "types.ts remains P01 owner"); the
 * P01 transport/contract names are imported, never redeclared.
 *
 * Installed libraries only: `better-sqlite3` (through the caller's handle). No
 * `node:*` import, so the module stays importable from client components and
 * from a plain `tsc --noEmit` (same rule P01's types.ts documents).
 */

import type Database from 'better-sqlite3';
import {
  HQ_CHAT_TURN_STATES,
  type HqChatTurnState,
  HQ_ACTIVITY_KINDS,
} from './types';

/* ================================================================== *
 * Row shapes (SPEC S6 columns, verbatim)
 * ================================================================== */

/** S6 `hq_activity`. `payload_json` stays text; callers sanitize before serving. */
export type HqActivityRow = {
  seq: number;
  id: string;
  company_id: string;
  source_key: string;
  content_hash: string;
  kind: string;
  task_id: string | null;
  actor_agent_id: string | null;
  recipient_agent_id: string | null;
  from_workspace_id: string | null;
  to_workspace_id: string | null;
  exchange_id: string | null;
  phase: string | null;
  payload_json: string;
  occurred_at: string | null;
  received_at: string;
  payload_bytes: number;
};

/** S6 `hq_activity_state` — cursor survives even when all history is pruned. */
export type HqActivityStateRow = {
  company_id: string;
  high_seq: number;
  pruned_through_seq: number;
  capture_state: string;
  retained_bytes: number;
  updated_at: string;
};

/** S6 `hq_activity_receipts` — dedup keys outlive feed pruning. */
export type HqActivityReceiptRow = {
  company_id: string;
  source_key: string;
  content_hash: string;
  issued_at: string | null;
  accepted_at: string;
  original_seq: number | null;
};

/** S6 `hq_run_bindings` — trusted source binding, visibility never body-supplied. */
export type HqRunBindingVisibility = 'task-audience' | 'private-owner';
export type HqRunBindingRow = {
  company_id: string;
  runtime_run_id: string;
  runtime_session_key: string | null;
  agent_id: string | null;
  task_id: string | null;
  execution_id: string | null;
  visibility: string;
  owner_subject: string | null;
  recorded_at: string;
  expires_at: string | null;
};

/** S6 `hq_chat_sessions` — the logical conversation; each turn owns a gateway key. */
export type HqChatSessionRow = {
  id: string;
  company_id: string;
  owner_subject: string;
  installation_id: string;
  head_agent_id: string | null;
  runtime_agent_id: string | null;
  created_at: string;
  last_activity_at: string;
  closed_at: string | null;
};

/** S6 `hq_chat_turns` — gateway_session_key never leaves the server (S8/S9). */
export type HqChatTurnRow = {
  id: string;
  company_id: string;
  session_id: string;
  owner_subject: string;
  client_request_id: string;
  payload_hash: string | null;
  message_text: string;
  reply_text: string | null;
  state: string;
  attempts: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  gateway_session_key: string | null;
  source_run_id: string | null;
  task_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  content_expired_at: string | null;
};

/** S6 `hq_owner_login_uses` — one-use nonce, `expires_at`/`used_at` are epoch ms. */
export type HqOwnerLoginUseRow = {
  nonce: string;
  expires_at: number;
  used_at: number;
};

/** Every table reserved migration 169 creates, in foreign-key (child-last) order. */
export const HQ_TABLES = [
  'hq_activity',
  'hq_activity_state',
  'hq_activity_receipts',
  'hq_run_bindings',
  'hq_chat_sessions',
  'hq_chat_turns',
  'hq_owner_login_uses',
] as const;
export type HqTableName = (typeof HQ_TABLES)[number];

/**
 * The one partial unique index that enforces "only one nonterminal turn per
 * session" (S6 line 253). Named here so tests and readiness checks agree on the
 * string instead of re-typing it.
 */
export const HQ_ONE_ACTIVE_TURN_INDEX = 'idx_hq_chat_turns_one_active_per_session';

/** S9 nonterminal states — the partial index predicate, spelled once. */
export const HQ_NONTERMINAL_TURN_STATES: readonly HqChatTurnState[] = [
  'queued',
  'sending',
  'awaiting_reply',
  'reconciling',
];

/* ================================================================== *
 * Decoders — raw SQLite row in, typed row out
 * ================================================================== */

/**
 * Decode a raw row into its typed shape, or `null` when it is not one.
 *
 * The container types are checked for real (the value is not a bare `as`): a
 * row missing a NOT NULL column, or carrying a turn state outside the S9 set,
 * returns `null` rather than flowing onward as a plausible-looking object.
 * Unknown-but-permitted string columns (kind/phase/visibility) are kept as
 * given — SPEC collapses them at the projection boundary, not at storage.
 */
function decodeRow<T extends object>(
  raw: unknown,
  requiredNotNull: readonly string[],
  enums: Record<string, readonly string[]>,
): T | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  for (const key of requiredNotNull) {
    const value = row[key];
    if (value === null || value === undefined) return null;
  }
  for (const [key, allowed] of Object.entries(enums)) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' || !allowed.includes(value)) return null;
  }
  return row as unknown as T;
}

export function decodeHqActivityRow(raw: unknown): HqActivityRow | null {
  return decodeRow<HqActivityRow>(
    raw,
    ['seq', 'id', 'company_id', 'source_key', 'content_hash', 'kind', 'payload_json', 'received_at'],
    { kind: HQ_ACTIVITY_KINDS },
  );
}

export function decodeHqActivityStateRow(raw: unknown): HqActivityStateRow | null {
  return decodeRow<HqActivityStateRow>(
    raw,
    ['company_id', 'high_seq', 'pruned_through_seq', 'capture_state', 'updated_at'],
    {},
  );
}

export function decodeHqActivityReceiptRow(raw: unknown): HqActivityReceiptRow | null {
  return decodeRow<HqActivityReceiptRow>(raw, ['company_id', 'source_key', 'content_hash', 'accepted_at'], {});
}

export function decodeHqRunBindingRow(raw: unknown): HqRunBindingRow | null {
  return decodeRow<HqRunBindingRow>(
    raw,
    ['company_id', 'runtime_run_id', 'visibility', 'recorded_at'],
    { visibility: ['task-audience', 'private-owner'] },
  );
}

export function decodeHqChatSessionRow(raw: unknown): HqChatSessionRow | null {
  return decodeRow<HqChatSessionRow>(
    raw,
    ['id', 'company_id', 'owner_subject', 'installation_id', 'created_at', 'last_activity_at'],
    {},
  );
}

export function decodeHqChatTurnRow(raw: unknown): HqChatTurnRow | null {
  return decodeRow<HqChatTurnRow>(
    raw,
    ['id', 'company_id', 'session_id', 'owner_subject', 'client_request_id', 'message_text', 'state', 'created_at', 'updated_at'],
    { state: HQ_CHAT_TURN_STATES },
  );
}

export function decodeHqOwnerLoginUseRow(raw: unknown): HqOwnerLoginUseRow | null {
  return decodeRow<HqOwnerLoginUseRow>(raw, ['nonce', 'expires_at', 'used_at'], {});
}

/* ================================================================== *
 * Schema readiness
 * ================================================================== */

/**
 * Readiness of the additive HQ schema for ONE handle.
 *
 * `checkHqSchemaReady` answers the S6 line 259 requirement "check schema
 * before access": a caller (B05/B07/B09/B20/B33) asks whether 169 has reached
 * this database before it prepares a statement, instead of discovering a
 * missing table as a runtime SQL error. It reads the LIVE schema
 * (`sqlite_master`), never a migration ledger, for the same reason migration
 * 097 exists — a ledger can claim applied while the table is absent.
 */
export type HqSchemaReadiness = {
  ok: boolean;
  tables: HqTableName[];
  missingTables: HqTableName[];
  missingIndexes: string[];
};

export function checkHqSchemaReady(db: Database.Database): HqSchemaReadiness {
  const names = new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as { name: string }[]
    ).map((row) => row.name),
  );
  const missingTables = HQ_TABLES.filter((table) => !names.has(table));

  const indexNames = new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
        .all() as { name: string }[]
    ).map((row) => row.name),
  );
  const missingIndexes: string[] = [];
  if (!indexNames.has(HQ_ONE_ACTIVE_TURN_INDEX)) missingIndexes.push(HQ_ONE_ACTIVE_TURN_INDEX);

  return { ok: missingTables.length === 0 && missingIndexes.length === 0, tables: [...HQ_TABLES], missingTables, missingIndexes };
}

/** Throws with the exact missing objects named when readiness is not `ok`. */
export function requireHqSchema(res: HqSchemaReadiness): void {
  if (res.ok) return;
  throw new Error(
    `[hq/storage] HQ schema not ready — missing table(s) [${res.missingTables.join(', ') || 'none'}] / index(es) ` +
      `[${res.missingIndexes.join(', ') || 'none'}]. Reserved migration 169 (src/lib/db/migrations.ts) has not reached this database.`,
  );
}

/* ================================================================== *
 * Small typed readers (decoder entry points for the writer units)
 * ================================================================== */

/** Reads one activity row by company + seq. Returns null when absent or undecodable. */
export function readHqActivityRow(
  db: Database.Database,
  companyId: string,
  seq: number,
): HqActivityRow | null {
  const raw = db
    .prepare(`SELECT * FROM hq_activity WHERE company_id = ? AND seq = ?`)
    .get(companyId, seq);
  return decodeHqActivityRow(raw);
}

/** Reads the cursor/watermark row for a company. */
export function readHqActivityStateRow(
  db: Database.Database,
  companyId: string,
): HqActivityStateRow | null {
  const raw = db.prepare(`SELECT * FROM hq_activity_state WHERE company_id = ?`).get(companyId);
  return decodeHqActivityStateRow(raw);
}

/** Reads one chat turn by company + id. `gateway_session_key` is included here and
 *  must never be projected to a browser (S8/S9, gap G-17). */
export function readHqChatTurnRow(
  db: Database.Database,
  companyId: string,
  turnId: string,
): HqChatTurnRow | null {
  const raw = db
    .prepare(`SELECT * FROM hq_chat_turns WHERE company_id = ? AND id = ?`)
    .get(companyId, turnId);
  return decodeHqChatTurnRow(raw);
}

/** True for the S9 states the partial unique index treats as active. */
export function isNonterminalHqTurn(state: HqChatTurnState): boolean {
  return HQ_NONTERMINAL_TURN_STATES.includes(state);
}

// The four terminal states are the S9 set minus the predicate above. Asserted
// at module load so a P01 change that adds a state cannot silently widen or
// narrow the one-active-turn index.
{
  const terminal: readonly HqChatTurnState[] = ['replied', 'failed_unsent', 'refused', 'unresolved'];
  const classified = [...HQ_NONTERMINAL_TURN_STATES, ...terminal].sort().join(',');
  if (classified !== [...HQ_CHAT_TURN_STATES].sort().join(',')) {
    throw new Error(
      '[hq/storage] S9 turn-state set changed — the one-active-turn partial index predicate ' +
        `(${HQ_NONTERMINAL_TURN_STATES.join(',')}) no longer partitions ${HQ_CHAT_TURN_STATES.join(',')}. ` +
        'Update migration 169 and this module together.',
    );
  }
}

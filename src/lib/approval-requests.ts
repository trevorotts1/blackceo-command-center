/**
 * approval-requests.ts — the owner's approvals inbox.
 *
 * WHY. The Convert and Flow safety gate (Skill 44) refuses every CRM write
 * unless `CAF_APPROVAL_ID` names a launch approval record that Command Center
 * minted from the owner's own verified identity. Until this module existed,
 * nothing in the product let the owner create that record: the agent had no
 * way to say "this needs your yes", and the owner had no button to give it.
 *
 * THE SPLIT (fail-closed, both directions):
 *   - The AGENT (MC_API_TOKEN bearer, subject `operator:api`) may REGISTER a
 *     request and READ its status. It can never decide one.
 *   - Only a REGISTERED OWNER identity (signed session cookie or verified
 *     Access JWT whose subject/email is in the tenant registration) may decide.
 *     Approving mints one `launch_approvals` row with
 *     `verification_class = 'authenticated_platform_record'` and
 *     `approver` = that verified identity. The id of that row is what the agent
 *     then exports as CAF_APPROVAL_ID.
 *
 * Pure of fs/network; the DB is reached through the shared `@/lib/db` layer.
 */
import { randomUUID } from 'node:crypto';
import { queryAll, queryOne, run, transaction } from '@/lib/db';
import type { TenantContext } from '@/lib/auth/tenant-context';
import {
  PLAN_HASH_RE,
  VERIFICATION_CLASS_OWNER,
  registeredClientIdentity,
} from '@/lib/launch-approvals';

/** The two kinds the safety gate reads (`automation_write`, `publish`). */
export const REQUEST_KINDS = ['automation_write', 'publish'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export type RequestStatus = 'pending' | 'approved' | 'changes_requested' | 'expired';

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_TTL_MS = 30 * 24 * 3600 * 1000;
const ALLOWED_FIELDS = new Set([
  'kind', 'location_id', 'action', 'object_key', 'plan_sha256', 'title', 'summary',
  'preview', 'requested_by', 'expires_at',
]);
/** Fields only the server sets; naming one is a direct-write attempt. */
const SERVER_OWNED = [
  'request_id', 'tenant_id', 'status', 'created_at', 'decided_at', 'decided_by',
  'decision_note', 'approval_id', 'approver', 'verification_class',
] as const;

export interface PreviewLink { label: string; url: string }
export interface ApprovalPreview {
  /** Plain text. Rendered as text, never as HTML. */
  text?: string;
  /** Documents the owner should open: a Google Sheet, a PDF, a draft page. */
  links?: PreviewLink[];
  /** Image URLs shown inline (https only). */
  images?: string[];
}

export interface ApprovalRequest {
  request_id: string;
  kind: RequestKind;
  location_id: string;
  action: string;
  object_key: string;
  plan_sha256: string;
  title: string;
  summary: string;
  preview: ApprovalPreview;
  requested_by: string;
  status: RequestStatus;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  /** Set once approved: the value for CAF_APPROVAL_ID. */
  approval_id: string | null;
  /** Stable deep link the agent can send to the owner. */
  path: string;
}

interface Row {
  request_id: string; tenant_id: string; kind: RequestKind; location_id: string; action: string;
  object_key: string; plan_sha256: string; title: string; summary: string; preview_json: string;
  requested_by: string; status: 'pending' | 'approved' | 'changes_requested'; expires_at: string;
  created_at: string; decided_at: string | null; decided_by: string | null;
  decision_note: string | null; approval_id: string | null;
}

export interface RequestResult { status: number; payload: Record<string, unknown> }
const refuse = (status: number, error: string, detail?: string): RequestResult => ({
  status, payload: detail ? { error, detail } : { error },
});

export const approvalRequestPath = (requestId: string): string => `/approvals/${requestId}`;

function parsePreview(raw: string): ApprovalPreview {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as ApprovalPreview) : {};
  } catch { return {}; }
}

export function toRequest(r: Row, now = Date.now()): ApprovalRequest {
  const expired = r.status === 'pending' && Date.parse(r.expires_at) <= now;
  return {
    request_id: r.request_id, kind: r.kind, location_id: r.location_id, action: r.action,
    object_key: r.object_key, plan_sha256: r.plan_sha256, title: r.title, summary: r.summary,
    preview: parsePreview(r.preview_json), requested_by: r.requested_by,
    status: expired ? 'expired' : r.status, expires_at: r.expires_at, created_at: r.created_at,
    decided_at: r.decided_at, decided_by: r.decided_by, decision_note: r.decision_note,
    approval_id: r.approval_id, path: approvalRequestPath(r.request_id),
  };
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= max ? t : null;
};

/** http(s) only, no credentials in the URL; `images` additionally require https. */
function safeUrl(v: unknown, httpsOnly: boolean): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v.trim());
    if (u.username || u.password) return null;
    if (u.protocol === 'https:' || (!httpsOnly && u.protocol === 'http:')) return u.toString();
  } catch { /* fall through */ }
  return null;
}

function validatePreview(raw: unknown): ApprovalPreview | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (Object.keys(p).some((k) => !['text', 'links', 'images'].includes(k))) return null;
  const out: ApprovalPreview = {};
  if (p.text !== undefined) {
    if (typeof p.text !== 'string' || p.text.length > 20000) return null;
    out.text = p.text;
  }
  if (p.links !== undefined) {
    if (!Array.isArray(p.links) || p.links.length > 25) return null;
    out.links = [];
    for (const l of p.links) {
      const o = l as Record<string, unknown> | null;
      const label = o && typeof o === 'object' ? str(o.label, 200) : null;
      const url = o && typeof o === 'object' ? safeUrl(o.url, false) : null;
      if (!label || !url) return null;
      out.links.push({ label, url });
    }
  }
  if (p.images !== undefined) {
    if (!Array.isArray(p.images) || p.images.length > 40) return null;
    out.images = [];
    for (const i of p.images) {
      const url = safeUrl(i, true);
      if (!url) return null;
      out.images.push(url);
    }
  }
  return out;
}

/**
 * AGENT DOOR: register "this needs the owner's yes". Only the operator/agent
 * bearer (`operator:api`) may call this; an owner session is refused because
 * the owner's way to decide is the page, not authoring requests. Registering
 * the same unexpired pending/approved plan again returns the stored request.
 */
export function createApprovalRequest(ctx: TenantContext, body: unknown): RequestResult {
  if (ctx.subject !== 'operator:api') return refuse(403, 'agent_token_required', 'requests are registered by the agent');
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse(400, 'invalid_body');
  const b = body as Record<string, unknown>;
  if (SERVER_OWNED.some((k) => k in b)) return refuse(403, 'server_owned_field', 'status, approver and approval fields are set by the server only');
  const unknown = Object.keys(b).find((k) => !ALLOWED_FIELDS.has(k));
  if (unknown) return refuse(400, 'unknown_field', unknown);

  const kind = b.kind as RequestKind;
  if (!REQUEST_KINDS.includes(kind)) return refuse(400, 'invalid_kind', REQUEST_KINDS.join(', '));
  const locationId = str(b.location_id, 200);
  if (!locationId) return refuse(400, 'invalid_location_id');
  const action = str(b.action, 200);
  if (!action) return refuse(400, 'invalid_action');
  const objectKey = str(b.object_key, 500);
  if (!objectKey) return refuse(400, 'invalid_object_key');
  const planSha = typeof b.plan_sha256 === 'string' ? b.plan_sha256.trim() : '';
  if (!PLAN_HASH_RE.test(planSha)) return refuse(400, 'invalid_plan_sha256', '64 hex characters, optionally prefixed sha256:');
  const title = str(b.title, 200);
  if (!title) return refuse(400, 'invalid_title');
  const summary = str(b.summary, 4000);
  if (!summary) return refuse(400, 'invalid_summary');
  const preview = validatePreview(b.preview);
  if (!preview) return refuse(400, 'invalid_preview', 'text (string), links [{label,url}], images [https url]');
  const requestedBy = b.requested_by === undefined ? 'agent' : str(b.requested_by, 100);
  if (!requestedBy) return refuse(400, 'invalid_requested_by');

  const now = Date.now();
  let expires = now + DEFAULT_TTL_MS;
  if (b.expires_at !== undefined) {
    const t = typeof b.expires_at === 'string' ? Date.parse(b.expires_at) : NaN;
    if (!Number.isFinite(t) || t <= now || t > now + MAX_TTL_MS) return refuse(400, 'invalid_expires_at');
    expires = t;
  }

  const existing = queryAll<Row>(
    `SELECT * FROM approval_requests
       WHERE tenant_id = ? AND kind = ? AND location_id = ? AND action = ? AND object_key = ? AND plan_sha256 = ?
         AND status IN ('pending','approved') AND expires_at > ?
       ORDER BY created_at DESC`,
    [ctx.tenantId, kind, locationId, action, objectKey, planSha, new Date(now).toISOString()],
  )[0];
  if (existing) return { status: 200, payload: { ...toRequest(existing, now), replayed: true } };

  const requestId = randomUUID();
  run(
    `INSERT INTO approval_requests (request_id, tenant_id, kind, location_id, action, object_key, plan_sha256,
       title, summary, preview_json, requested_by, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [requestId, ctx.tenantId, kind, locationId, action, objectKey, planSha, title, summary,
      JSON.stringify(preview), requestedBy, new Date(expires).toISOString(), new Date(now).toISOString()],
  );
  const row = queryOne<Row>('SELECT * FROM approval_requests WHERE request_id = ?', [requestId])!;
  return { status: 201, payload: { ...toRequest(row, now) } };
}

/** One request, scoped to the caller's tenant (another tenant's id reads as not found). */
export function getApprovalRequest(tenantId: string, requestId: string): RequestResult {
  const row = queryOne<Row>('SELECT * FROM approval_requests WHERE request_id = ? AND tenant_id = ?', [requestId, tenantId]);
  return row ? { status: 200, payload: { ...toRequest(row) } } : refuse(404, 'request_not_found');
}

/** The request as a plain object (for server-rendered pages), or null. */
export function loadApprovalRequest(tenantId: string, requestId: string): ApprovalRequest | null {
  const row = queryOne<Row>('SELECT * FROM approval_requests WHERE request_id = ? AND tenant_id = ?', [requestId, tenantId]);
  return row ? toRequest(row) : null;
}

export function listApprovalRequests(tenantId: string, filter: 'pending' | 'all' = 'all', limit = 100): ApprovalRequest[] {
  const now = Date.now();
  const rows = queryAll<Row>(
    'SELECT * FROM approval_requests WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
    [tenantId, Math.max(1, Math.min(500, limit))],
  ).map((r) => toRequest(r, now));
  return filter === 'pending' ? rows.filter((r) => r.status === 'pending') : rows;
}

export function countPendingApprovals(tenantId: string): number {
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM approval_requests WHERE tenant_id = ? AND status = 'pending' AND expires_at > ?`,
    [tenantId, new Date().toISOString()],
  );
  return row?.n ?? 0;
}

export interface DecisionInput { decision: 'approve' | 'request_changes'; note?: string }

/**
 * OWNER DOOR: approve, or ask for changes. `ctx` MUST come from
 * resolveTenantContext. The agent bearer is refused 403 (it is never a
 * registered client identity). Approve mints exactly one launch_approvals row;
 * a repeated approve returns the same record (idempotent), and the
 * unique (tenant, source_message_ref) constraint backs that up at the table.
 * The minted record lives 7 days from the click (not from the request), so a
 * late yes is still usable.
 */
export function decideApprovalRequest(ctx: TenantContext, requestId: string, input: unknown): RequestResult {
  const identity = registeredClientIdentity(ctx);
  if (!identity) return refuse(403, 'client_identity_required', "only the tenant's registered owner may decide");
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refuse(400, 'invalid_body');
  const { decision, note } = input as Record<string, unknown>;
  if (decision !== 'approve' && decision !== 'request_changes') return refuse(400, 'invalid_decision', 'approve | request_changes');
  if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) return refuse(400, 'invalid_note');
  const cleanNote = typeof note === 'string' ? note.trim() : '';

  return transaction(() => {
    const row = queryOne<Row>('SELECT * FROM approval_requests WHERE request_id = ? AND tenant_id = ?', [requestId, ctx.tenantId]);
    if (!row) return refuse(404, 'request_not_found');
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    if (row.status === 'approved' && decision === 'approve') {
      return { status: 200, payload: { ...toRequest(row, nowMs), replayed: true } };
    }
    if (row.status !== 'pending') return refuse(409, 'request_not_pending', row.status);
    if (Date.parse(row.expires_at) <= nowMs) return refuse(409, 'request_expired');

    if (decision === 'request_changes') {
      run(
        `UPDATE approval_requests SET status = 'changes_requested', decided_at = ?, decided_by = ?, decision_note = ?
          WHERE request_id = ? AND status = 'pending'`,
        [nowIso, identity, cleanNote, requestId],
      );
    } else {
      const approvalId = randomUUID();
      const digest = PLAN_HASH_RE.exec(row.plan_sha256)![1].toLowerCase();
      run(
        `INSERT INTO launch_approvals (approval_id, tenant_id, client_identity_ref, kind, plan_hash, scope,
           cap_minor, currency, expires_at, revoked, source_message_ref, created_at,
           location_id, action, object_key, plan_sha256, approver, verification_class, request_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [approvalId, ctx.tenantId, identity, row.kind, `sha256:${digest}`, `${row.title} — ${row.action} ${row.object_key}`.slice(0, 1000),
          new Date(nowMs + DEFAULT_TTL_MS).toISOString(), `approval-request:${requestId}`, nowIso,
          row.location_id, row.action, row.object_key, row.plan_sha256, identity, VERIFICATION_CLASS_OWNER, requestId],
      );
      run(
        `UPDATE approval_requests SET status = 'approved', decided_at = ?, decided_by = ?, decision_note = ?, approval_id = ?
          WHERE request_id = ? AND status = 'pending'`,
        [nowIso, identity, cleanNote, approvalId, requestId],
      );
    }
    const updated = queryOne<Row>('SELECT * FROM approval_requests WHERE request_id = ?', [requestId])!;
    return { status: 200, payload: { ...toRequest(updated, nowMs) } };
  });
}

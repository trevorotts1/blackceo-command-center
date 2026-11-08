/**
 * launch-approvals.ts — the ONE launch approval primitive (PRD-32 / PRD-01).
 *
 * An approval record is minted ONLY from the client's own reply: a reply that
 * contains `APPROVE <first 8 hex chars of the plan hash>`, submitted by the
 * tenant's REGISTERED client identity (a signed session cookie or a verified
 * Access JWT — never the agent/operator bearer, which proves "a machine", not
 * "the client"). The agent session can read a record (GET) but has no door that
 * writes one: no direct field setting, no PUT/PATCH/DELETE, and the table
 * itself refuses DELETE and any edit other than a revoke.
 *
 * Skills 83, 6 and 44 refuse effects without a live record for their plan hash.
 *
 * Pure of fs/network; the DB is reached through the shared `@/lib/db` layer.
 */
import { randomUUID } from 'node:crypto';
import { queryOne, run } from '@/lib/db';
import { tenantRegistration, type TenantContext } from '@/lib/auth/tenant-context';

export const APPROVAL_KINDS = [
  'plan_build',
  'paid_asset_budget',
  'publish',
  'automation_write',
  'pin_rotation',
  'design_board',
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export interface LaunchApprovalRecord {
  approval_id: string;
  tenant_id: string;
  client_identity_ref: string;
  kind: ApprovalKind;
  plan_hash: string;
  scope: string;
  cap_minor: number | null;
  currency: string | null;
  expires_at: string;
  revoked: boolean;
  source_message_ref: string;
}

/** Default and maximum lifetime of an approval. */
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_TTL_MS = 30 * 24 * 3600 * 1000;

/** Fields only the server may set; a body that names one is a direct-write attempt. */
const SERVER_OWNED = ['approval_id', 'tenant_id', 'client_identity_ref', 'revoked', 'source_message_ref'] as const;
const ALLOWED = new Set<string>([
  'kind', 'plan_hash', 'scope', 'cap_minor', 'currency', 'expires_at', 'source_message',
]);
const PLAN_HASH_RE = /^(?:sha256:)?([0-9a-f]{64})$/i;
const APPROVE_RE = /\bAPPROVE\s+([0-9a-f]{8})\b/i;

export interface ApprovalResult {
  status: number;
  payload: Record<string, unknown>;
}
const refuse = (status: number, error: string, detail?: string): ApprovalResult => ({
  status,
  payload: detail ? { error, detail } : { error },
});

/** True when `text` carries `APPROVE <first 8 hex chars of the plan digest>`. */
export function replyApprovesPlan(text: string, planHash: string): boolean {
  const digest = PLAN_HASH_RE.exec(planHash)?.[1];
  const said = APPROVE_RE.exec(text)?.[1];
  return Boolean(digest && said && said.toLowerCase() === digest.slice(0, 8).toLowerCase());
}

type Row = Omit<LaunchApprovalRecord, 'revoked'> & { revoked: number };
const toRecord = (r: Row): LaunchApprovalRecord => ({ ...r, revoked: r.revoked === 1 });

/**
 * The tenant's registered client identity behind this verified caller, or null.
 * Registered = listed in the tenant registration's `subjects` / `allowedEmails`.
 * The operator bearer (`operator:api`) is never a client identity.
 */
function registeredClientIdentity(ctx: TenantContext): string | null {
  if (ctx.subject === 'operator:api') return null;
  let reg;
  try { reg = tenantRegistration(ctx.host); } catch { return null; }
  const registered = new Set([...(reg.subjects ?? []), ...(reg.allowedEmails ?? [])].map((s) => s.toLowerCase()));
  for (const candidate of [ctx.email, ctx.subject]) {
    if (candidate && registered.has(candidate.toLowerCase())) return candidate.toLowerCase();
  }
  return null;
}

/** Mint one approval from a client reply. `ctx` MUST come from resolveTenantContext. */
export function mintLaunchApproval(ctx: TenantContext, body: unknown): ApprovalResult {
  const identity = registeredClientIdentity(ctx);
  if (!identity) return refuse(403, 'client_identity_required', 'only the tenant\'s registered client may approve');

  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse(400, 'invalid_body');
  const b = body as Record<string, unknown>;
  if (SERVER_OWNED.some((k) => k in b)) return refuse(403, 'server_owned_field', 'approval fields are set by the server only');
  const unknown = Object.keys(b).find((k) => !ALLOWED.has(k));
  if (unknown) return refuse(400, 'unknown_field', unknown);

  const src = b.source_message as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') return refuse(403, 'source_message_required', 'an approval is minted only from the client reply');
  const ref = typeof src.ref === 'string' ? src.ref.trim() : '';
  const sender = typeof src.sender === 'string' ? src.sender.trim().toLowerCase() : '';
  const text = typeof src.text === 'string' ? src.text : '';
  if (!ref || ref.length > 200 || !text || text.length > 4000) return refuse(400, 'invalid_source_message');
  if (sender !== identity) return refuse(403, 'sender_not_client', 'reply sender is not the verified client identity');

  const kind = b.kind as ApprovalKind;
  if (!APPROVAL_KINDS.includes(kind)) return refuse(400, 'invalid_kind', APPROVAL_KINDS.join(', '));
  const digest = typeof b.plan_hash === 'string' ? PLAN_HASH_RE.exec(b.plan_hash)?.[1]?.toLowerCase() : undefined;
  if (!digest) return refuse(400, 'invalid_plan_hash', 'sha256:<64 hex>');
  const planHash = `sha256:${digest}`;
  if (!replyApprovesPlan(text, planHash)) return refuse(422, 'approval_phrase_mismatch', 'reply must contain APPROVE <first 8 chars of the plan hash>');

  const scope = typeof b.scope === 'string' ? b.scope.trim() : '';
  if (!scope || scope.length > 1000) return refuse(400, 'invalid_scope');
  const capMinor = b.cap_minor ?? null;
  const currency = b.currency ?? null;
  if (kind === 'paid_asset_budget' && (capMinor === null || currency === null)) return refuse(400, 'cap_required', 'paid_asset_budget needs cap_minor and currency');
  if ((capMinor === null) !== (currency === null)) return refuse(400, 'cap_currency_pair');
  if (capMinor !== null && (!Number.isSafeInteger(capMinor) || (capMinor as number) < 0)) return refuse(400, 'invalid_cap_minor');
  if (currency !== null && !(typeof currency === 'string' && /^[A-Z]{3}$/.test(currency))) return refuse(400, 'invalid_currency');

  const now = Date.now();
  let expires = now + DEFAULT_TTL_MS;
  if (b.expires_at !== undefined) {
    const t = typeof b.expires_at === 'string' ? Date.parse(b.expires_at) : NaN;
    if (!Number.isFinite(t) || t <= now || t > now + MAX_TTL_MS) return refuse(400, 'invalid_expires_at');
    expires = t;
  }

  // Replay of the same client reply returns the stored record; a different
  // claim on a used message ref is a conflict, never an overwrite.
  const existing = queryOne<Row>('SELECT * FROM launch_approvals WHERE tenant_id = ? AND source_message_ref = ?', [ctx.tenantId, ref]);
  if (existing) {
    const same = existing.kind === kind && existing.plan_hash === planHash && existing.scope === scope;
    return same ? { status: 200, payload: { ...toRecord(existing), replayed: true } } : refuse(409, 'source_message_already_used');
  }

  const approvalId = randomUUID();
  run(
    `INSERT INTO launch_approvals (approval_id, tenant_id, client_identity_ref, kind, plan_hash, scope,
       cap_minor, currency, expires_at, revoked, source_message_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [approvalId, ctx.tenantId, identity, kind, planHash, scope, capMinor, currency, new Date(expires).toISOString(), ref, new Date(now).toISOString()],
  );
  const row = queryOne<Row>('SELECT * FROM launch_approvals WHERE approval_id = ?', [approvalId])!;
  return { status: 201, payload: { ...toRecord(row) } };
}

/** One stored record, scoped to the caller's tenant (another tenant's id reads as not found). */
export function getLaunchApproval(tenantId: string, approvalId: string): ApprovalResult {
  const row = queryOne<Row>('SELECT * FROM launch_approvals WHERE approval_id = ? AND tenant_id = ?', [approvalId, tenantId]);
  if (!row) return refuse(404, 'approval_not_found');
  const record = toRecord(row);
  return { status: 200, payload: { ...record, active: !record.revoked && Date.parse(record.expires_at) > Date.now() } };
}

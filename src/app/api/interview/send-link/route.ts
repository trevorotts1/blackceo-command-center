/** Operator-triggered private interview entry; never expose tickets in responses or logs. */
import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { queryOne, run, transaction } from '@/lib/db';
import { resolveTenantContext, type TenantContext } from '@/lib/auth/tenant-context';
import { createInterviewInvitation } from '@/lib/interview/invitation';
import { resolveWorkspaceDir } from '@/lib/interview/paths';
import { readBuildState, readHandoff, readInterviewProgress } from '@/lib/interview/seam';
import { notifyOwnerPrivate, resolveOwnerChatId } from '@/lib/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const EVENT_TYPE = 'interview_link_delivery';
const HEADERS = { 'cache-control': 'private, no-store' };
const requestSchema = z.object({ force: z.boolean().optional() }).strict();
type DeliveryStatus = 'pending' | 'accepted' | 'uncertain' | 'not-dispatched';

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: HEADERS });
}

/** Same receipt path as the canonical onboarding send-interview-link.sh.
 * A retry through another entry point must not bypass unknown delivery or
 * adopt a receipt belonging to another client, installation, host or owner.
 */
function shellDeliveryFence(context: TenantContext, recipientHash: string, force: boolean): string | null {
  const file = path.join(resolveWorkspaceDir(), 'company-discovery', '.interview-link-sends.log.receipt.json');
  let receipt: Record<string, unknown>;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return 'delivery_receipt_unverified';
    receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'delivery_receipt_unverified';
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return 'delivery_receipt_unverified';
  let origin: string;
  try { origin = new URL(process.env.MC_TENANT_PUBLIC_URL || '').origin; }
  catch { return 'delivery_receipt_unverified'; }
  if (receipt.companyId !== context.companyId || receipt.tenantId !== context.tenantId ||
      receipt.installationId !== context.installationId || receipt.origin !== origin ||
      new URL(origin).hostname !== context.host || receipt.recipientHash !== recipientHash) {
    return 'delivery_receipt_unverified';
  }
  if (receipt.status === 'sending' || receipt.status === 'uncertain') return 'delivery_uncertain';
  if (!['accepted', 'rejected'].includes(String(receipt.status))) return 'delivery_receipt_unverified';
  if (receipt.status === 'accepted') {
    if (typeof receipt.messageId !== 'string' || !receipt.messageId.trim() ||
        typeof receipt.epoch !== 'number' || !Number.isFinite(receipt.epoch) ||
        typeof receipt.invitationExpiresAt !== 'number' || !Number.isFinite(receipt.invitationExpiresAt)) {
      return 'delivery_receipt_unverified';
    }
    const expired = receipt.invitationExpiresAt <= Date.now() / 1000;
    if (!force && !expired && Date.now() / 1000 - receipt.epoch < 1800) return 'cooldown';
  }
  return null;
}

/** Durable reservation precedes issuance and delivery. Force never bypasses an
 * uncertain attempt: a missing acknowledgement cannot certify non-delivery. */
function reserve(context: TenantContext, recipientHash: string, mode: string, force: boolean) {
  return transaction(() => {
    const params = [context.companyId, context.tenantId, context.installationId, context.host];
    const prior = queryOne<{ status: DeliveryStatus; created_at: string }>(
      `SELECT json_extract(metadata,'$.status') AS status, created_at FROM events
       WHERE type=? AND json_extract(metadata,'$.companyId')=?
       AND json_extract(metadata,'$.tenantId')=? AND json_extract(metadata,'$.installationId')=?
       AND json_extract(metadata,'$.host')=?
       AND json_extract(metadata,'$.status') IN ('pending','uncertain','accepted')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`, [EVENT_TYPE, ...params]);
    // An earlier uncertain attempt remains a blocker even after other rows.
    const uncertain = queryOne(
      `SELECT id FROM events WHERE type=? AND json_extract(metadata,'$.companyId')=?
       AND json_extract(metadata,'$.tenantId')=? AND json_extract(metadata,'$.installationId')=?
       AND json_extract(metadata,'$.host')=?
       AND json_extract(metadata,'$.status') IN ('pending','uncertain') LIMIT 1`, [EVENT_TYPE, ...params]);
    if (uncertain) return { error: 'delivery_uncertain' } as const;
    const age = prior ? Date.now() - Date.parse(prior.created_at) : Infinity;
    if (prior && (!Number.isFinite(age) || age < 30 * 60_000) && !force) {
      return { error: 'cooldown' } as const;
    }
    // Honor recent pre-upgrade sends whose historical ledger had no tenant keys.
    const legacy = queryOne(
      "SELECT id FROM events WHERE type='interview_link_sent' AND created_at>datetime('now','-30 minutes') LIMIT 1");
    if (legacy && !force) return { error: 'cooldown' } as const;
    const id = randomUUID();
    run(`INSERT INTO events(id,type,task_id,message,metadata,created_at) VALUES(?,?,NULL,?,?,?)`,
      [id, EVENT_TYPE, 'Operator requested private interview entry', JSON.stringify({
        companyId: context.companyId, tenantId: context.tenantId,
        installationId: context.installationId, host: context.host,
        recipientHash, mode, status: 'pending',
      }), new Date().toISOString()]);
    return { id } as const;
  });
}

function finish(id: string, status: DeliveryStatus) {
  run("UPDATE events SET metadata=json_set(metadata,'$.status',?) WHERE id=? AND type=?",
    [status, id, EVENT_TYPE]);
}

export async function POST(req: NextRequest) {
  let context: TenantContext;
  try {
    context = await resolveTenantContext(req);
    if (context.subject !== 'operator:api' || context.kind !== 'self' ||
        context.installationId !== process.env.MC_INSTALLATION_ID ||
        context.companyId !== process.env.MC_COMPANY_ID) {
      return response({ error: 'operator_required' }, 403);
    }
  } catch { return response({ error: 'operator_required' }, 403); }

  let force = false;
  try {
    const text = await req.text();
    force = requestSchema.parse(text.trim() ? JSON.parse(text) : {}).force === true;
  } catch { return response({ error: 'invalid_request' }, 400); }

  const state = readBuildState();
  if (!state || state.companyId !== context.companyId || state.tenantId !== context.tenantId ||
      state.installationId !== context.installationId) {
    return response({ error: 'interview_identity_unverified' }, 409);
  }
  if (state.interviewComplete === true) return response({ error: 'interview_complete' }, 409);
  const progress = readInterviewProgress(state);
  const started = !!state.interviewSessionId &&
    (readHandoff().exists || (progress.lastQuestionNumber ?? 0) > 0);
  const mode = started ? 'resume' : 'start';
  const target = resolveOwnerChatId();
  if (!target) return response({ error: 'owner_not_reachable', mode }, 502);
  const recipientHash = createHash('sha256').update(target).digest('hex');
  const shellBlock = shellDeliveryFence(context, recipientHash, force);
  if (shellBlock) return response({ ok: false, error: shellBlock, mode }, 409);

  let reservation;
  try {
    reservation = reserve(context, recipientHash, mode, force);
  } catch { return response({ error: 'delivery_ledger_unavailable' }, 503); }
  if ('error' in reservation) return response({ ok: false, error: reservation.error, mode }, 409);
  const { id } = reservation;
  try {
    const issued = await createInterviewInvitation(req, recipientHash);
    if (issued.status !== 200) {
      finish(id, 'not-dispatched');
      return response({ error: 'interview_not_ready', mode }, 409);
    }
    const invitation = await issued.json();
    const privateUrl = new URL(invitation.url);
    if (invitation.companyId !== context.companyId || invitation.tenantId !== context.tenantId ||
        invitation.installationId !== context.installationId || privateUrl.hostname !== context.host ||
        privateUrl.pathname !== '/interview' || !privateUrl.hash.startsWith('#enroll=')) {
      finish(id, 'not-dispatched');
      return response({ error: 'invitation_identity_unverified' }, 409);
    }
    const bookmark = `${privateUrl.origin}/interview`;
    const message = (mode === 'resume'
      ? 'Welcome back — your saved answers are still there. Continue your interview here: '
      : 'Your AI Workforce Interview is ready. Start here: ') + invitation.url +
      '\n\nThis private sign-in link can be used once within 24 hours. Keep it private. ' +
      'After signing in, bookmark ' + bookmark +
      '. The bookmark works while you are signed in; if asked to sign in again, request a fresh private link. ' +
      'Each answer is saved when you press Continue or Send.';
    // Issuance awaits signature/readiness work; recheck a shell attempt that
    // became visible during that interval before touching the gateway.
    const shellChanged = shellDeliveryFence(context, recipientHash, force);
    if (shellChanged) {
      finish(id, 'not-dispatched');
      return response({ ok: false, error: shellChanged, mode }, 409);
    }
    const status = await notifyOwnerPrivate({ companyId: context.companyId, expectedChatId: target, message });
    finish(id, status);
    if (status === 'accepted') return response({ ok: true, status, mode, bookmark, expiresAt: invitation.expiresAt, companyId: context.companyId, tenantId: context.tenantId, installationId: context.installationId });
    return response({ ok: false, error: status === 'uncertain' ? 'delivery_uncertain' : 'owner_not_reachable', mode }, 502);
  } catch {
    // Keep the pending row: exceptions after dispatch may hide a real delivery.
    return response({ ok: false, error: 'delivery_uncertain', mode }, 503);
  }
}

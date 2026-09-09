/** One installed company, one private weekly invitation, acknowledged delivery. */
import { randomUUID } from 'crypto';
import { queryOne, run, transaction } from '@/lib/db';
import { tenantRegistration } from '@/lib/auth/tenant-context';
import { resolvePrivateOwnerChatId, notifyOwnerPrivate } from '@/lib/notify';
import { ensureCycle, ensureDraftSession, getPolicy } from './cycles';
import { mintInvitationToken, SOCIAL_THEME_INVITATION_PURPOSE } from './theme-sessions';
import { SOCIAL_THEME_INVITATION_TTL_SECONDS } from './session-policy';

export function localSocialBinding() {
  const companyId = process.env.MC_COMPANY_ID;
  const installationId = process.env.MC_INSTALLATION_ID;
  if (!companyId || !installationId) throw new Error('installation_identity_unconfigured');
  const origin = new URL(process.env.MC_TENANT_PUBLIC_URL || '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('public_origin_unconfigured');
  const registered = tenantRegistration(origin.hostname);
  if (registered.kind !== 'self' || registered.companyId !== companyId || registered.installationId !== installationId) throw new Error('installation_identity_mismatch');
  // Mini-app rows use clients.id; task/workspace ownership uses companies.id.
  // Bind through this installation's explicit self record, never a name match.
  const self = queryOne<{ id: string; name: string }>('SELECT id,name FROM clients WHERE is_self=1');
  const count = queryOne<{ n: number }>('SELECT count(*) AS n FROM clients WHERE is_self=1');
  if (!self || count?.n !== 1) throw new Error('self_client_unverified');
  const owner = resolvePrivateOwnerChatId();
  if (!owner) throw new Error('owner_not_reachable');
  const company = queryOne<{ config: string | null }>('SELECT config FROM companies WHERE id=?', [companyId]);
  if (!company) throw new Error('company_unverified');
  const config = JSON.parse(company.config || '{}');
  const previousCycle = queryOne<{timezone:string}>('SELECT timezone FROM social_cycles WHERE company_id=? ORDER BY created_at DESC LIMIT 1',[self.id]);
  const timezone = process.env.MC_TIMEZONE || config.timezone || config.timeZone || previousCycle?.timezone || process.env.TZ || 'America/New_York';
  new Intl.DateTimeFormat('en-US', {timeZone:timezone}).format();
  return { companyId, clientId: self.id, name: self.name, installationId, origin: origin.origin, owner, timezone };
}

export function localWeek(now: Date, timezone: string, upcoming = false): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(now).map(p=>[p.type,p.value]));
  const day = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  const offset = (day.getUTCDay()+6)%7;
  day.setUTCDate(day.getUTCDate()-offset+(upcoming?7:0));
  return day.toISOString().slice(0,10);
}

export async function deliverSocialLink(input: { week: string; reminder?: boolean; renew?: boolean; now?: Date }) {
  const binding = localSocialBinding();
  const now = input.now || new Date();
  const { cycle } = ensureCycle({ companyId: binding.clientId, weekStartLocal: input.week, timezone: binding.timezone });
  const session = ensureDraftSession(cycle, false);
  if (session.status !== 'draft' || ['closed','skipped','responded'].includes(cycle.state)) return { status:'already_submitted', cycle_id:cycle.id };
  const key = `private-weekly-invite:${cycle.id}:${input.reminder ? 'reminder' : 'initial'}`;
  const reservation = transaction(() => {
    const previous = queryOne<{ id:string; delivery_state:string; attempt_count:number; updated_at:string }>('SELECT id,delivery_state,attempt_count,updated_at FROM social_notification_outbox WHERE company_id=? AND dedupe_key=?',[binding.clientId,key]);
    if (previous && ['sending','uncertain'].includes(previous.delivery_state)) return { blocked:previous.delivery_state };
    if (previous?.delivery_state === 'sent' && (!input.renew || now.getTime() - new Date(previous.updated_at).getTime() < 60_000)) return { blocked:'sent' };
    const id = previous?.id || randomUUID();
    run(`INSERT INTO social_notification_outbox(id,company_id,event_id,dedupe_key,destination_ref,subject,body,delivery_state,attempt_count,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'sending',1,?,?) ON CONFLICT(company_id,dedupe_key) DO UPDATE SET delivery_state='sending',attempt_count=attempt_count+1,updated_at=excluded.updated_at`,
      [id,binding.clientId,`private-social-invite:${cycle.id}`,key,`company:${binding.clientId}`,'Your weekly social plan',JSON.stringify({cycle_id:cycle.id,installation_id:binding.installationId}),now.toISOString(),now.toISOString()]);
    return { id };
  });
  if ('blocked' in reservation) return { status:reservation.blocked==='sent'?'already_delivered':'delivery_uncertain',cycle_id:cycle.id };
  const { raw, tokenHash } = mintInvitationToken();
  const invitationId=randomUUID();
  const expires=new Date(now.getTime()+SOCIAL_THEME_INVITATION_TTL_SECONDS*1000).toISOString();
  run('INSERT INTO social_invitations(id,token_hash,purpose,company_id,cycle_id,session_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [invitationId,tokenHash,SOCIAL_THEME_INVITATION_PURPOSE,binding.clientId,cycle.id,session.id,expires,now.toISOString()]);
  const url=`${binding.origin}/social-theme/welcome?ticket=${encodeURIComponent(raw)}`;
  const receipt=await notifyOwnerPrivate({companyId:binding.companyId,expectedChatId:binding.owner,
    message:`${input.reminder?'A reminder to finish':'Let’s plan'} your content for the week of ${cycle.week_start_local}. Choose your theme, offer and priorities here:\n${url}\n\nYour answers save as you go. This private link works once within 24 hours. If it expires, say “renew my social plan link.”`});
  const state=receipt.status==='accepted'?'sent':receipt.status==='not-dispatched'?'pending':'uncertain';
  run('UPDATE social_notification_outbox SET delivery_state=?,body=?,updated_at=? WHERE id=? AND delivery_state=\'sending\'',
    [state,JSON.stringify({cycle_id:cycle.id,invitation_id:invitationId,expires_at:expires,installation_id:binding.installationId,...(receipt.status==='accepted'?{message_id:receipt.messageId}:{error:receipt.status})}),new Date().toISOString(),reservation.id]);
  if(receipt.status==='accepted')run(`UPDATE social_cycles SET state='invited',invitation_sent_at=COALESCE(invitation_sent_at,?),invitation_channel='telegram',reminder_due_at=?,reminder_count=COALESCE(reminder_count,0)+?,updated_at=? WHERE id=? AND state IN ('draft','invited')`,
    [now.toISOString(),new Date(now.getTime()+8*3600_000).toISOString(),input.reminder?1:0,now.toISOString(),cycle.id]);
  return {status:receipt.status==='accepted'?'delivered':receipt.status,cycle_id:cycle.id,...(receipt.status==='accepted'?{message_id:receipt.messageId}:{})};
}

export async function runWeeklySocialInvitations(now=new Date()) {
  if(process.env.SOCIAL_THEME_AUTOPILOT_ENABLED!=='1')return {status:'disabled'};
  const binding=localSocialBinding();
  const policy=getPolicy(binding.clientId);
  if(policy?.reminders_paused)return {status:'paused'};
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:binding.timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  const day=policy?.reminder_day || 'Saturday';
  const time=policy?.reminder_time || '09:00';
  if(!/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(day)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new Error('weekly_schedule_invalid');
  // Five-minute sweep catches the configured local-time window without UTC/DST drift.
  const minute=Number(parts.hour)*60+Number(parts.minute), scheduled=Number(time.slice(0,2))*60+Number(time.slice(3));
  if(parts.weekday===day.slice(0,3)&&minute>=scheduled&&minute<scheduled+60)return deliverSocialLink({week:localWeek(now,binding.timezone,true),now});
  const due=queryOne<{week_start_local:string}>(`SELECT week_start_local FROM social_cycles WHERE company_id=? AND state='invited' AND invitation_channel='telegram' AND reminder_due_at<=? AND COALESCE(reminder_count,0)<1 ORDER BY reminder_due_at LIMIT 1`,[binding.clientId,now.toISOString()]);
  return due?deliverSocialLink({week:due.week_start_local,reminder:true,now}):{status:'not_due'};
}

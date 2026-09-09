import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
const state=vi.hoisted(()=>({db:null as any,send:vi.fn(),task:vi.fn()}));
vi.mock('@/lib/db',()=>({queryOne:(sql:string,p:any[]=[])=>state.db.prepare(sql).get(...p),run:(sql:string,p:any[]=[])=>state.db.prepare(sql).run(...p),transaction:(fn:any)=>state.db.transaction(fn)(),queryAll:(sql:string,p:any[]=[])=>state.db.prepare(sql).all(...p)}));
vi.mock('@/lib/notify',()=>({resolvePrivateOwnerChatId:()=> 'owner-a',notifyOwnerPrivate:(x:any)=>state.send(x)}));
import { deliverSocialLink, localWeek, runWeeklySocialInvitations } from '@/lib/social-theme/delivery';
vi.mock('@/lib/tasks',()=>({createTaskCore:(...args:any[])=>state.task(...args)}));
import { processSocialSubmission } from '@/lib/social-theme/submission-worker';
import { submitThemeSession } from '@/lib/social-theme/cycles';
import { hashInvitationToken } from '@/lib/social-theme/theme-sessions';
beforeEach(()=>{
 state.db=new Database(':memory:');
 state.db.exec(`CREATE TABLE clients(id TEXT,name TEXT,is_self INTEGER);INSERT INTO clients VALUES('self','Client A',1);
 CREATE TABLE companies(id TEXT,config TEXT);INSERT INTO companies VALUES('a','{"timezone":"America/New_York"}');
 CREATE TABLE social_cycles(id TEXT PRIMARY KEY,company_id TEXT,week_start_local TEXT,timezone TEXT,policy_revision INTEGER,state TEXT,next_action_at TEXT,created_at TEXT,updated_at TEXT,invitation_sent_at TEXT,invitation_channel TEXT,reminder_due_at TEXT,reminder_count INTEGER,UNIQUE(company_id,week_start_local));
 CREATE TABLE social_theme_sessions(id TEXT PRIMARY KEY,company_id TEXT,cycle_id TEXT,questionnaire_version TEXT,answers_json TEXT,revision INTEGER,status TEXT,saved_at TEXT,submitted_at TEXT,created_at TEXT,updated_at TEXT,UNIQUE(company_id,cycle_id));
 CREATE TABLE social_invitations(id TEXT,token_hash TEXT,purpose TEXT,company_id TEXT,cycle_id TEXT,session_id TEXT,expires_at TEXT,created_at TEXT);
 CREATE TABLE social_notification_outbox(id TEXT PRIMARY KEY,company_id TEXT,event_id TEXT,dedupe_key TEXT,destination_ref TEXT,subject TEXT,body TEXT,delivery_state TEXT,attempt_count INTEGER,retry_at TEXT,created_at TEXT,updated_at TEXT,UNIQUE(company_id,dedupe_key));
 CREATE TABLE workspaces(id TEXT,company_id TEXT,slug TEXT);INSERT INTO workspaces VALUES('ws-a','a','social-media');
 CREATE TABLE social_policies(company_id TEXT PRIMARY KEY,reminders_paused INTEGER,reminder_day TEXT,reminder_time TEXT,policy_revision INTEGER,mode TEXT,updated_at TEXT);`);
 vi.stubEnv('MC_COMPANY_ID','a');vi.stubEnv('MC_INSTALLATION_ID','install-a');vi.stubEnv('MC_TENANT_PUBLIC_URL','https://a.example.test');vi.stubEnv('MC_TENANT_REGISTRY_JSON',JSON.stringify({'a.example.test':{tenantId:'ta',kind:'self',companyId:'a',installationId:'install-a'}}));vi.stubEnv('SOCIAL_THEME_AUTOPILOT_ENABLED','1');
 state.task.mockReset().mockResolvedValue({task:{id:'task-a'},deduped:false});
 state.send.mockReset().mockResolvedValue({status:'accepted',messageId:'message-1'});
});
afterEach(()=>{state.db.close();vi.unstubAllEnvs();});
describe('private weekly social link delivery',()=>{
 it('sends a redeemable company-bound miniapp invitation and stores no raw ticket',async()=>{
  expect((await deliverSocialLink({week:'2026-09-14'})).status).toBe('delivered');
  const payload=state.send.mock.calls[0][0];expect(payload.companyId).toBe('a');expect(payload.expectedChatId).toBe('owner-a');
  const url=payload.message.match(/https:\/\/\S+/)[0];const token=new URL(url).searchParams.get('ticket')!;
  const invitation=state.db.prepare('select * from social_invitations').get();expect(invitation.token_hash).toBe(hashInvitationToken(token));expect(invitation.company_id).toBe('self');
  const out=state.db.prepare('select * from social_notification_outbox').get();expect(out.delivery_state).toBe('sent');expect(JSON.stringify(out)).not.toContain(token);expect(out.body).toContain('message-1');
 });
 it('does not double-send concurrent sweeps',async()=>{await Promise.all([deliverSocialLink({week:'2026-09-14'}),deliverSocialLink({week:'2026-09-14'})]);expect(state.send).toHaveBeenCalledTimes(1);});
 it('leaves uncertain sends visible and never retries them blindly',async()=>{state.send.mockResolvedValue({status:'uncertain'});await deliverSocialLink({week:'2026-09-14'});expect((await deliverSocialLink({week:'2026-09-14'})).status).toBe('delivery_uncertain');expect(state.send).toHaveBeenCalledTimes(1);expect(state.db.prepare('select state from social_cycles').get().state).toBe('draft');});
 it('refuses another installation public host before sending',async()=>{vi.stubEnv('MC_TENANT_PUBLIC_URL','https://b.example.test');await expect(deliverSocialLink({week:'2026-09-14'})).rejects.toThrow();expect(state.send).not.toHaveBeenCalled();});
 it('preserves submitted answers and does not reinvite that week',async()=>{await deliverSocialLink({week:'2026-09-14'});state.db.exec(`UPDATE social_theme_sessions SET status='submitted',answers_json='{"theme":"client answer"}',revision=12;UPDATE social_cycles SET state='responded';`);expect((await deliverSocialLink({week:'2026-09-14'})).status).toBe('already_submitted');expect(state.send).toHaveBeenCalledTimes(1);expect(state.db.prepare('select revision from social_theme_sessions').get().revision).toBe(12);});
 it('uses Saturday in the client timezone and the coming Monday, including DST',async()=>{expect(localWeek(new Date('2026-11-07T14:00:00Z'),'America/New_York',true)).toBe('2026-11-09');expect((await runWeeklySocialInvitations(new Date('2026-09-12T12:00:00Z'))).status).toBe('not_due');expect((await runWeeklySocialInvitations(new Date('2026-09-12T13:00:00Z'))).status).toBe('delivered');expect(state.db.prepare('select week_start_local from social_cycles').get().week_start_local).toBe('2026-09-14');});
 it('renews the same draft after the resend cooldown',async()=>{
  const first=await deliverSocialLink({week:'2026-09-14'});
  state.db.exec("UPDATE social_notification_outbox SET updated_at='2026-01-01T00:00:00Z'");
  expect((await deliverSocialLink({week:'2026-09-14',renew:true})).status).toBe('delivered');
  expect(state.send).toHaveBeenCalledTimes(2);
  expect(state.db.prepare('select count(*) n from social_theme_sessions').get().n).toBe(1);
  expect(state.db.prepare('select cycle_id from social_theme_sessions').get().cycle_id).toBe(first.cycle_id);
 });
 it('honors reminder pause',async()=>{state.db.exec("INSERT INTO social_policies(company_id,reminders_paused,reminder_day,reminder_time) VALUES('self',1,'Saturday','09:00')");expect((await runWeeklySocialInvitations(new Date('2026-09-12T13:00:00Z'))).status).toBe('paused');expect(state.send).not.toHaveBeenCalled();});
});

describe('submitted questionnaire recovery',()=>{
 it('creates one company-owned task from the sealed answers and holds an unapproved budget',async()=>{
  const delivered=await deliverSocialLink({week:'2026-09-14'});
  const session=state.db.prepare('select * from social_theme_sessions').get();
  submitThemeSession({companyId:'self',cycleId:delivered.cycle_id,sessionId:session.id,expectedRevision:0,answers:{theme:'Actual client answer'},destinationRef:'company:self',policy:{mode:'standard',budgetUsd:null,approvalPolicy:'client-approve'}});
  expect((await processSocialSubmission()).status).toBe('awaiting_budget');
  expect((await processSocialSubmission()).status).toBe('no_pending_submission');
  expect(state.task).toHaveBeenCalledTimes(1);
  const task=state.task.mock.calls[0][0];expect(task.workspace_id).toBe('ws-a');expect(task.idempotency_company_id).toBe('a');expect(task.routing_hold_reason).toBe('social_budget_unconfigured');expect(task.description).toContain('Actual client answer');
  expect(state.db.prepare('select status from social_theme_sessions').get().status).toBe('submitted');
 });
});

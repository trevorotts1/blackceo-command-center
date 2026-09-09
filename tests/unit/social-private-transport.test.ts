import { beforeEach,afterEach,it,expect,vi } from 'vitest';
const gateway=vi.hoisted(()=>({connect:vi.fn(),call:vi.fn()}));
vi.mock('@/lib/openclaw/client',()=>({getOpenClawClient:()=>gateway}));
import { notifyOwnerPrivate } from '@/lib/notify';
beforeEach(()=>{
 vi.stubEnv('MC_COMPANY_ID','a');vi.stubEnv('OPENCLAW_OWNER_CHAT_ID','7000000001');
 vi.stubEnv('OWNER_NOTIFY_ALLOW_SEND_IN_TEST','1');vi.stubEnv('OWNER_NOTIFY_TELEGRAM_DISABLED','0');
 gateway.connect.mockReset().mockResolvedValue(undefined);
 gateway.call.mockReset().mockImplementation(async (_method,p)=>({channel:'telegram',messageId:'42',runId:p.idempotencyKey}));
});
afterEach(()=>vi.unstubAllEnvs());
const input={companyId:'a',expectedChatId:'7000000001',message:'Private weekly link'};
it('accepts the installed gateway receipt without an optional chatId and pins the agent',async()=>{
 expect(await notifyOwnerPrivate(input)).toEqual({status:'accepted',messageId:'42'});
 expect(gateway.call.mock.calls[0][0]).toBe('send');expect(gateway.call.mock.calls[0][1].agentId).toBe('main');
 const first=gateway.call.mock.calls[0][1].idempotencyKey;await notifyOwnerPrivate(input);expect(gateway.call.mock.calls[1][1].idempotencyKey).toBe(first);
});
it('rejects a receipt for a different delivery or recipient',async()=>{
 gateway.call.mockResolvedValue({channel:'telegram',messageId:'42',runId:'foreign'});
 expect((await notifyOwnerPrivate(input)).status).toBe('uncertain');
 gateway.call.mockImplementation(async (_m,p)=>({channel:'telegram',messageId:'42',runId:p.idempotencyKey,chatId:'999'}));
 expect((await notifyOwnerPrivate(input)).status).toBe('uncertain');
});
it('does not dispatch if connection or ownership verification fails',async()=>{
 gateway.connect.mockRejectedValue(new Error('offline'));expect((await notifyOwnerPrivate(input)).status).toBe('not-dispatched');expect(gateway.call).not.toHaveBeenCalled();
 expect((await notifyOwnerPrivate({...input,companyId:'b'})).status).toBe('not-dispatched');
});

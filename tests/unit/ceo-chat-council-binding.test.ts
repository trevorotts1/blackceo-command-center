/**
 * CWE-045: CEO chat surface binding for the Council of Wise Elders
 * intents (CWE-037 remainder, Section 17.5).
 *
 * A chat message that classifies as one of the seven registered
 * council intents is dispatched through the council's composed
 * intent adapter and answered from council state, instead of being
 * forwarded to the agent as ordinary chat. Ordinary messages follow
 * the normal forward path. The binding is fail-open: it engages
 * only when a verified council principal resolves for the request.
 *
 * Isolated temp DB; forwardToAgent is mocked (vitest-only, same
 * pattern as ceo-chat-message-route-passthrough.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { ChatChunk, ForwardRequest } from '@/lib/ceo-chat/gateway';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ceo-council-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
delete process.env.MY_AI_CEO_BETA;
process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
  'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', kind: 'self', installationId: 'install-a' },
});
process.env.MC_TENANT_SESSION_SECRET = 'cwe045-ceo-session-secret';
process.env.MC_API_TOKEN = 'cwe045-ceo-operator-token';
process.env.MC_CSRF_COOKIE_SECRET = 'cwe045-ceo-csrf-secret';

let capturedRequests: ForwardRequest[] = [];
const canned: ChatChunk[] = [{ type: 'token', text: 'Agent reply.' }, { type: 'done' }];

vi.doMock('@/lib/ceo-chat/gateway', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ceo-chat/gateway')>('@/lib/ceo-chat/gateway');
  return {
    ...actual,
    async *forwardToAgent(req: ForwardRequest) {
      capturedRequests.push(req);
      for (const chunk of canned) yield chunk;
    },
  };
});

type RouteModule = typeof import('@/app/api/ceo-chat/message/route');
let POST: RouteModule['POST'];
let signTenantGrantFn: typeof import('@/lib/auth/tenant-context').signTenantGrant;
let getCeoChatHistoryFn: typeof import('@/lib/ceo-chat/store').getCeoChatHistory;

beforeAll(async () => {
  const db = await import('@/lib/db');
  db.getDb();
  const auth = await import('@/lib/auth/tenant-context');
  signTenantGrantFn = auth.signTenantGrant;
  const store = await import('@/lib/ceo-chat/store');
  getCeoChatHistoryFn = store.getCeoChatHistory;
  const route = await import('@/app/api/ceo-chat/message/route');
  POST = route.POST;
});

afterAll(() => {
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

beforeEach(() => {
  capturedRequests = [];
});

async function postCouncilChat(sessionId: string, message: string): Promise<{ status: number; text: string }> {
  const token = await signTenantGrantFn({
    purpose: 'session',
    tenantId: 'tenant-a',
    companyId: 'company-a',
    subject: 'owner:alice',
    host: 'council-a.test',
    installationId: 'install-a',
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: `ceo-council-${Math.random()}`,
  });
  const req = new NextRequest('https://council-a.test/api/ceo-chat/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'council-a.test', cookie: `mc_tenant_session=${token}` },
    body: JSON.stringify({ sessionId, message }),
  });
  const res = (await POST(req)) as unknown as Response;
  return { status: res.status, text: await res.text() };
}

describe('POST /api/ceo-chat/message - CWE-045 council intent binding', () => {
  it('a convene intent is answered by the council binding and never forwarded', async () => {
    const { status, text } = await postCouncilChat('ceo-thread-council-1', 'Take this decision to the council');
    expect(status).toBe(200);
    expect(capturedRequests).toHaveLength(0);
    expect(text).toContain('convenes the full council');
    expect(text).toContain('council-of-wise-elders');
    const history = getCeoChatHistoryFn('ceo-thread-council-1');
    const assistant = history.filter((entry) => entry.role === 'assistant');
    expect(assistant.length).toBeGreaterThan(0);
    expect(assistant[assistant.length - 1].content).toContain('convenes the full council');
  });

  it('an ordinary message follows the normal forward path unchanged', async () => {
    const { status, text } = await postCouncilChat('ceo-thread-plain-1', 'Hello, how are you today?');
    expect(status).toBe(200);
    expect(capturedRequests).toHaveLength(1);
    expect(text).toContain('Agent reply.');
  });
});

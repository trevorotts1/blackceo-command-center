/**
 * P5-01 — My AI CEO chat transcript store (DB-backed).
 *
 * Proves migration 101 creates ceo_chat_messages on a throwaway DB and the store
 * inserts/reads a session's transcript in chronological order, including the
 * trust-engine report-back rows (role 'trust').
 *
 * MUST import _isolated-db FIRST so getDb() opens a throwaway DB, never the real
 * mission-control.db. Fail-first: pre-P5-01 the table + store module don't exist.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, queryOne } from '../../src/lib/db';
import {
  insertCeoChatMessage,
  appendTrustMessage,
  getCeoChatHistory,
} from '../../src/lib/ceo-chat/store';

beforeAll(() => {
  // Force migrations to run on the isolated DB.
  getDb();
});

describe('migration 101 — ceo_chat_messages table', () => {
  it('exists after migrations', () => {
    const row = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='ceo_chat_messages'",
    );
    expect(row?.name).toBe('ceo_chat_messages');
  });
});

describe('ceo-chat store', () => {
  it('persists and returns a session transcript in chronological order', async () => {
    const sid = `sess-${Date.now()}`;
    insertCeoChatMessage({ sessionId: sid, role: 'user', content: 'Book me a flight' });
    await new Promise((r) => setTimeout(r, 5));
    insertCeoChatMessage({ sessionId: sid, role: 'assistant', content: 'On it.' });
    await new Promise((r) => setTimeout(r, 5));
    appendTrustMessage(sid, '✅ Got it — assigned to Travel.', 'trust_ack');

    const history = getCeoChatHistory(sid);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'trust']);
    expect(history[0].content).toBe('Book me a flight');
    expect(history[2].kind).toBe('trust_ack');
  });

  it('scopes history to its own session', () => {
    const a = `a-${Date.now()}`;
    const b = `b-${Date.now()}`;
    insertCeoChatMessage({ sessionId: a, role: 'user', content: 'A only' });
    insertCeoChatMessage({ sessionId: b, role: 'user', content: 'B only' });
    expect(getCeoChatHistory(a).map((m) => m.content)).toEqual(['A only']);
    expect(getCeoChatHistory(b).map((m) => m.content)).toEqual(['B only']);
  });

  it('records upload receipts with attachment provenance (path stored, not bytes)', () => {
    const sid = `up-${Date.now()}`;
    insertCeoChatMessage({
      sessionId: sid,
      role: 'user',
      content: 'Uploaded deck.pdf',
      kind: 'upload',
      attachmentPath: '/srv/workspace/inbox/ceo-chat/2026-07-11/abc-deck.pdf',
      attachmentName: 'deck.pdf',
      attachmentType: 'application/pdf',
      attachmentSize: 12345,
    });
    const [row] = getCeoChatHistory(sid);
    expect(row.kind).toBe('upload');
    expect(row.attachment_name).toBe('deck.pdf');
    expect(row.attachment_size).toBe(12345);
  });

  // U62 (JM/U65, master E.2) — migration 110 usage columns. BINARY
  // acceptance: usage "echoed by history for reload continuity" — the store
  // must round-trip real per-turn usage so a page reload can resume exact
  // metering without a new turn.
  it('U62: an assistant row can carry real usage (input/output/total) and getCeoChatHistory echoes it back', () => {
    const sid = `usage-${Date.now()}`;
    insertCeoChatMessage({ sessionId: sid, role: 'user', content: 'How are we doing?' });
    insertCeoChatMessage({
      sessionId: sid,
      role: 'assistant',
      content: 'Revenue is up.',
      usageInput: 16026,
      usageOutput: 28,
      usageTotal: 16054,
    });

    const history = getCeoChatHistory(sid);
    const assistantRow = history.find((m) => m.role === 'assistant');
    expect(assistantRow?.usage_input).toBe(16026);
    expect(assistantRow?.usage_output).toBe(28);
    expect(assistantRow?.usage_total).toBe(16054);
  });

  it('U62: a row with no usage supplied stores NULL (never a fabricated zero)', () => {
    const sid = `no-usage-${Date.now()}`;
    insertCeoChatMessage({ sessionId: sid, role: 'assistant', content: 'estimate-mode reply' });
    const [row] = getCeoChatHistory(sid);
    expect(row.usage_input).toBeNull();
    expect(row.usage_output).toBeNull();
    expect(row.usage_total).toBeNull();
  });
});

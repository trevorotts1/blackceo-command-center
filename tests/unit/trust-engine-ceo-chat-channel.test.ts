/**
 * P5-01 step 2 — ONE trust engine, TWO channels (DB-backed).
 *
 * The report-back loop is the SAME engine for Telegram and for the My AI CEO
 * chat: a task carrying requester_channel='ceo-chat' reports ack/progress/done
 * back INTO the chat transcript (ceo_chat_messages, role 'trust'); a
 * requester_channel='telegram' task still goes to Telegram (notifyTelegram). This
 * proves the DEFAULT sender in executeSends() routes by channel — the exact
 * behavior the QC (e) "one full request→ack→…→done loop entirely inside the new
 * UI" depends on.
 *
 * Fail-first: pre-P5-01, executeSends had no channel routing and notifyTelegram
 * fired for every channel, so the ceo-chat assertion (a 'trust' row exists AND
 * Telegram was NOT called for that chat) is red.
 *
 * MUST import _isolated-db FIRST. Mocks '@/lib/notify' to observe Telegram sends
 * without a real gateway.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, vi } from 'vitest';

const telegramSpy = vi.fn(() => true);
vi.mock('@/lib/notify', () => ({
  notifyTelegram: (args: { chatId: string; message: string }) => telegramSpy(args),
  notifySystem: () => {},
  resolveOperatorChatId: () => null,
  resolveOwnerChatId: () => null,
}));

// U60/JM-U63c — the new Operations Rail broadcast emit point. Mocked so this
// suite observes exactly what defaultTrustSend() publishes without needing a
// live SSE client registered on the in-process events.ts Set.
const broadcastSpy = vi.fn();
vi.mock('@/lib/events', () => ({
  broadcast: (event: unknown) => broadcastSpy(event),
}));

import { getDb, run } from '../../src/lib/db';
import { executeSends, type PlannedSend } from '../../src/lib/jobs/trust-engine';
import { getCeoChatHistory } from '../../src/lib/ceo-chat/store';

function seedTask(id: string) {
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, 'in_progress', NULL, datetime('now'), datetime('now'))`,
    [id, `task ${id}`],
  );
}

beforeAll(() => {
  getDb();
});

describe('executeSends default channel routing', () => {
  it('routes a ceo-chat report-back into the chat transcript — NOT Telegram', () => {
    telegramSpy.mockClear();
    const sid = `ceochat-${Date.now()}`;
    const taskId = `t-ceo-${Date.now()}`;
    seedTask(taskId);

    const plan: PlannedSend = {
      chatId: sid,
      channel: 'ceo-chat',
      message: '✅ Got it — "task" was assigned to the sales department. I\'ll update you as it moves.',
      stamps: [
        {
          taskId,
          guardColumn: 'ack_sent_at',
          extraSets: {},
          eventType: 'trust_ack',
          eventMessage: `trust_ack -> ${sid}`,
        },
      ],
      doneWithoutDeliverable: [],
    };

    const res = executeSends([plan], { now: new Date() });
    expect(res.sent).toBe(1);

    // It landed in the chat transcript as a 'trust' row...
    const history = getCeoChatHistory(sid);
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('trust');
    expect(history[0].kind).toBe('trust_ack');
    expect(history[0].content).toContain('Got it');
    // ...J.0.7 threading fix (U60/JM-U63c): the stamp's taskId survives onto
    // the written row, so the Operations Rail can join it back to its card.
    expect(history[0].task_id).toBe(taskId);

    // ...and Telegram was NEVER called for this ceo-chat session.
    expect(telegramSpy).not.toHaveBeenCalled();
  });

  it('U60/JM-U63c: a ceo-chat send broadcasts ceo_chat_task_status on the SSE bus, joined by task_id', () => {
    telegramSpy.mockClear();
    broadcastSpy.mockClear();
    const sid = `ceochat-rail-${Date.now()}`;
    const taskId = `t-ceo-rail-${Date.now()}`;
    seedTask(taskId);

    const plan: PlannedSend = {
      chatId: sid,
      channel: 'ceo-chat',
      message: '🔄 "task" is in progress with Sales. Estimated completion: today.',
      stamps: [
        {
          taskId,
          guardColumn: 'progress_last_sent_at',
          extraSets: {},
          eventType: 'trust_progress',
          eventMessage: `trust_progress -> ${sid}`,
        },
      ],
      doneWithoutDeliverable: [],
    };

    const res = executeSends([plan], { now: new Date() });
    expect(res.sent).toBe(1);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledWith({
      type: 'ceo_chat_task_status',
      payload: { taskId, sessionId: sid, kind: 'trust_progress', message: plan.message },
    });
  });

  it('still routes a telegram report-back to Telegram (no regression)', () => {
    telegramSpy.mockClear();
    const taskId = `t-tg-${Date.now()}`;
    seedTask(taskId);

    const plan: PlannedSend = {
      chatId: '551234567',
      channel: 'telegram',
      message: '🔄 in progress',
      stamps: [
        {
          taskId,
          guardColumn: 'progress_last_sent_at',
          extraSets: {},
          eventType: 'trust_progress',
          eventMessage: 'trust_progress -> 551234567',
        },
      ],
      doneWithoutDeliverable: [],
    };

    const res = executeSends([plan], { now: new Date() });
    expect(res.sent).toBe(1);
    expect(telegramSpy).toHaveBeenCalledTimes(1);
    expect(telegramSpy).toHaveBeenCalledWith({ chatId: '551234567', message: '🔄 in progress' });
    // The telegram chat id must NOT have leaked into the chat transcript.
    expect(getCeoChatHistory('551234567')).toHaveLength(0);
  });

  it('an injected ctx.send still wins for every channel (test seam intact)', () => {
    telegramSpy.mockClear();
    const captured: Array<{ chatId: string; message: string; channel?: string }> = [];
    const taskId = `t-inj-${Date.now()}`;
    seedTask(taskId);

    const plan: PlannedSend = {
      chatId: 'sess-inj',
      channel: 'ceo-chat',
      message: 'done',
      stamps: [
        {
          taskId,
          guardColumn: 'completion_sent_at',
          extraSets: {},
          eventType: 'trust_done',
          eventMessage: 'trust_done',
        },
      ],
      doneWithoutDeliverable: [],
    };

    executeSends([plan], {
      now: new Date(),
      send: (chatId, message, channel) => {
        captured.push({ chatId, message, channel });
        return true;
      },
    });

    expect(captured).toEqual([{ chatId: 'sess-inj', message: 'done', channel: 'ceo-chat' }]);
    // The default writer did NOT run, so nothing landed in the transcript.
    expect(getCeoChatHistory('sess-inj')).toHaveLength(0);
    expect(telegramSpy).not.toHaveBeenCalled();
  });
});

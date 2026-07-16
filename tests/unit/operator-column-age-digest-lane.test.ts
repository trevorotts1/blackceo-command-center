/**
 * operator-column-age-digest-lane.test.ts — U102 / C12.3 item 10a.
 *
 * THE CRITERION THIS CLOSES
 * -------------------------
 * U102's BINARY acceptance criterion (b) reads, verbatim:
 *
 *   "the digest names only operator-lane recipients (zero client sends — lane
 *    test) — PASS/FAIL"
 *
 * The unit shipped with `operator-column-age-digest.test.ts` (criterion a: one
 * digest per day) and `notification-failures-log-health.test.ts` (criterion c:
 * the health field), but NO lane test — criterion (b) was correct by
 * construction and unproven by any assertion. Correct-by-construction is not a
 * PASS/FAIL artifact: a later edit swapping `notifySystem` for `notifyOwner`
 * would have shipped a daily client-facing drip with every existing test green.
 * This file is that missing artifact.
 *
 * WHY THESE ASSERTIONS AND NOT A CHAT-ID CAPTURE
 * ---------------------------------------------
 * `notifyTelegram()` is the single choke point for every Telegram send in
 * notify.ts, and SAFETY-01 makes it a no-op inside any test runner — so a test
 * can never observe a real chat target. The lane is therefore proven at the two
 * seams that actually decide it:
 *
 *   1. BEHAVIOURAL — the digest's one dispatch is captured on the Rescue
 *      Rangers escalation rung (the operator lane's only observable send), and
 *      a POPULATED, REACHABLE client lane receives nothing. Populating the
 *      client lane is what keeps this test non-vacuous: "zero client sends" is
 *      trivially true when no client is configured at all.
 *   2. STRUCTURAL — `resolveOperatorChatId()` cannot return a client id
 *      (validOperatorChatId rejects any id outside OPERATOR_CHAT_IDS), which is
 *      what makes notifySystem's Telegram rung unable to reach a client, and a
 *      call-site pin that the digest imports ONLY notifySystem from the notify
 *      lane.
 *
 * The operator id used below ('5252140759') is one of notify.ts's own
 * DEFAULT_OPERATOR_CHAT_IDS — already hardcoded in this repo, so this test adds
 * no new identity to it. The client id is a fabricated fixture value.
 *
 * Run: node --import tsx --test tests/unit/operator-column-age-digest-lane.test.ts
 */

const OPERATOR_CHAT_ID = '5252140759'; // a built-in DEFAULT_OPERATOR_CHAT_IDS entry
const CLIENT_CHAT_ID = '4111111111'; // fabricated fixture: NOT an operator id
const WEBHOOK = 'https://rescue.example.invalid/webhook/escalate';

// Telegram stays muted (SAFETY-01 would mute it anyway); the webhook rung is the
// observable operator-lane send and is opted in per-test, coupled to the double.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.CC_OPERATOR_CHAT_ID = OPERATOR_CHAT_ID; // operator lane: reachable
process.env.OPENCLAW_OWNER_CHAT_ID = CLIENT_CHAT_ID; // client lane: reachable
delete process.env.DISABLE_OPERATOR_COLUMN_AGE_DIGEST;
delete process.env.OPERATOR_COLUMN_AGE_DIGEST_COOLDOWN_HOURS;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(
  path.join(os.tmpdir(), 'bc-col-age-digest-lane-workspace-'),
);

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run } from '../../src/lib/db';
import { resolveOwnerChatId, resolveOperatorChatId } from '../../src/lib/notify';
import { runOperatorColumnAgeDigest } from '../../src/lib/jobs/operator-column-age-digest';

getDb(); // apply full migration chain

interface EscalationBody {
  action?: string;
  agent?: string;
  message?: string;
  [k: string]: unknown;
}

/**
 * Capture every escalation POST without letting a packet leave the process.
 * Mirrors notify-escalation-attribution.test.ts's captureWebhook(): the
 * OWNER_NOTIFY_ALLOW_SEND_IN_TEST opt-in is installed ONLY alongside the fetch
 * double, and restore() removes both together.
 */
function captureWebhook(): { posts: EscalationBody[]; restore: () => void } {
  const posts: EscalationBody[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    posts.push(JSON.parse(String(init?.body ?? '{}')) as EscalationBody);
    return { ok: true } as Response;
  }) as typeof globalThis.fetch;
  process.env.RESCUE_RANGERS_WEBHOOK_URL = WEBHOOK;
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  return {
    posts,
    restore: () => {
      globalThis.fetch = realFetch;
      delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
      delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
    },
  };
}

function clearFixtures(): void {
  run(`DELETE FROM tasks`);
  run(`DELETE FROM events WHERE type = 'operator_column_age_digest_sent'`);
}

function seedAgedCard(title: string, status: string, department: string, daysOld: number): void {
  run(
    `INSERT INTO tasks
       (id, title, status, workspace_id, business_id, department, updated_at, last_progress_at, archived_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
    [
      uuidv4(),
      title,
      status,
      department,
      new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString(),
    ],
  );
}

// ── 0. The fixture is non-vacuous: BOTH lanes are reachable ─────────────────

test('lane fixture is non-vacuous: the client lane is populated and reachable', () => {
  assert.equal(
    resolveOwnerChatId(),
    CLIENT_CHAT_ID,
    'the CLIENT lane must resolve to a real chat id — otherwise "zero client sends" proves nothing',
  );
  assert.equal(resolveOperatorChatId(), OPERATOR_CHAT_ID, 'the OPERATOR lane resolves to the operator');
});

// ── 1. BEHAVIOURAL: one dispatch, operator lane, zero client sends ──────────

test('runOperatorColumnAgeDigest: dispatches on the OPERATOR lane only — zero client sends', async () => {
  clearFixtures();
  seedAgedCard('Stale funnel copy', 'backlog', 'web-development', 12);
  seedAgedCard('Waiting on asset', 'blocked', 'marketing', 9);

  const cap = captureWebhook();
  try {
    const result = await runOperatorColumnAgeDigest();
    assert.equal(result.digestSent, true, 'precondition: the digest actually sent');

    // Exactly ONE dispatch — batched, never a per-task drip.
    assert.equal(cap.posts.length, 1, 'exactly one operator-lane dispatch for the whole board');

    // ...and it is THIS job's operator-lane escalation.
    assert.equal(cap.posts[0].agent, 'operator-column-age-digest');
    assert.equal(cap.posts[0].action, 'daily_digest');

    // ZERO CLIENT SENDS: the reachable client chat id appears in no payload.
    for (const post of cap.posts) {
      assert.doesNotMatch(
        JSON.stringify(post),
        new RegExp(CLIENT_CHAT_ID),
        'the client chat id must never appear in an operator-lane dispatch',
      );
    }
  } finally {
    cap.restore();
  }
});

// ── 2. STRUCTURAL: a client id can never become a SYSTEM target ─────────────

test('a CLIENT chat id can never be resolved as a SYSTEM/operator target', () => {
  const realPin = process.env.CC_OPERATOR_CHAT_ID;
  process.env.CC_OPERATOR_CHAT_ID = CLIENT_CHAT_ID;
  try {
    assert.equal(
      resolveOperatorChatId(),
      null,
      'pinning the operator target to a CLIENT id must resolve to null — notifySystem can never reach a client',
    );
  } finally {
    process.env.CC_OPERATOR_CHAT_ID = realPin;
  }
});

// ── 3. CALL-SITE PIN: the digest touches only the operator lane ─────────────

test('call-site pin: the digest imports notifySystem and NO client/owner-lane sender', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/jobs/operator-column-age-digest.ts'),
    'utf8',
  );
  assert.match(src, /import \{ notifySystem \} from '@\/lib\/notify'/, 'imports the operator lane');
  for (const clientLaneSender of ['notifyOwner', 'notifyOwnerDone', 'notifyTelegram', 'notifyByAudience']) {
    assert.equal(
      src.includes(clientLaneSender),
      false,
      `the digest must never reference the client-lane sender ${clientLaneSender}`,
    );
  }
});

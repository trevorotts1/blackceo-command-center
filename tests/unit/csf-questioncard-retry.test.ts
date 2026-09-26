/**
 * csf-questioncard-retry.test.ts (CSF-005) — client-side retry contract for
 * submitInterviewAnswer() (src/components/interview/QuestionCard.tsx).
 *
 * THE BUG THIS PINS: the CSRF cookie (mc_csrf_token) lives 1 hour
 * (src/lib/csrf-protection.ts CSRF_COOKIE_TTL_SECONDS). A long interview
 * sitting therefore 401s on the next answer POST once the cookie lapses at
 * the middleware CSRF gate (the answer route itself never emits 401 — only
 * 400/403/429/500/502/503), and submitInterviewAnswer() must self-heal: take
 * the fresh cookie the server re-mints on that 401 (CSF-002) and retry the
 * save once with the SAME body and SAME idempotency-key, never losing the
 * typed answer.
 *
 * CONTRACT (self-healing, never lose the typed answer):
 *   1. First POST /api/interview/answer -> 401 (expired token mid-sitting):
 *      exactly ONE fresh-cookie fetch, then exactly ONE retry POST;
 *      second POST -> 200; result.ok === true.
 *   2. The retry re-sends the IDENTICAL body (typed answer preserved) with the
 *      SAME 'idempotency-key' as the first POST.
 *   3. No retry loop: answer-route POSTs are EXACTLY 2 on the 401 path
 *      (never 3+), even when the retry itself 401s.
 *   4. 400 (route validation) -> NO retry: exactly 1 answer POST.
 *   5. 500 (server failure) -> NO retry: exactly 1 answer POST.
 *
 * No DB, no fs, no network — global fetch is stubbed. Drives the REAL
 * exported submitInterviewAnswer, never a re-implementation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { submitInterviewAnswer } from '@/components/interview/QuestionCard';
import { INTERVIEW_SIGN_IN_HELP } from '@/lib/interview/browser-recovery';
import { INTERVIEW_QUESTIONS } from '@/lib/interview-questions';

interface StubResponse {
  status: number;
  body: unknown;
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];
let handler: (url: string, init: RequestInit | undefined) => StubResponse = () => ({
  status: 500,
  body: {},
});

const realFetch = globalThis.fetch;

function installStub(): void {
  calls = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  }) as typeof fetch;
}

function restoreStub(): void {
  globalThis.fetch = realFetch;
}

function answerPosts(): FetchCall[] {
  return calls.filter((c) => c.url === '/api/interview/answer');
}

function idempotencyKey(c: FetchCall): string | undefined {
  const h = c.init?.headers as Record<string, string> | undefined;
  return h?.['idempotency-key'];
}

function answerReq(value: string) {
  const q = INTERVIEW_QUESTIONS[0];
  return { question: q, value, questionNumber: 1 };
}

test('expired token mid-sitting: 401 -> ONE fresh-cookie fetch -> ONE retry POST -> 200 -> ok true', async () => {
  installStub();
  try {
    let posts = 0;
    handler = (url) => {
      if (url === '/api/interview/answer') {
        posts += 1;
        if (posts === 1) return { status: 401, body: {} };
        return { status: 200, body: { ok: true } };
      }
      return { status: 200, body: {} }; // CSRF refresh fetch
    };

    const result = await submitInterviewAnswer(answerReq('Acme Rockets retry-1'));

    const answerCalls = answerPosts();
    assert.equal(
      answerCalls.length,
      2,
      `expected EXACTLY 2 answer POSTs, saw ${answerCalls.length}`,
    );
    assert.equal(
      calls.length,
      3,
      `expected 3 fetches (POST + fresh-cookie refresh + retry), saw ${calls.length}`,
    );
    assert.notEqual(
      calls[1].url,
      '/api/interview/answer',
      'fresh-cookie fetch must come BEFORE the retry POST',
    );
    assert.equal(
      calls[2].url,
      '/api/interview/answer',
      'third fetch must be the retry POST',
    );
    assert.ok(idempotencyKey(answerCalls[0]), 'idempotency-key must be present');
    assert.equal(
      idempotencyKey(answerCalls[0]),
      idempotencyKey(answerCalls[1]),
      'retry must carry the SAME idempotency-key as the first POST',
    );
    assert.equal(
      answerCalls[0].init?.body,
      answerCalls[1].init?.body,
      'retry must re-send the identical body (typed answer preserved)',
    );
    assert.equal(
      result.ok,
      true,
      `expected ok true after retry, got ${JSON.stringify(result)}`,
    );
  } finally {
    restoreStub();
  }
});

test('no retry loop: a retry that also 401s is NOT retried again (answer POSTs stay at 2)', async () => {
  installStub();
  try {
    handler = (url) => {
      if (url === '/api/interview/answer') return { status: 401, body: {} };
      return { status: 200, body: {} };
    };

    const result = await submitInterviewAnswer(answerReq('Acme Rockets retry-2'));

    assert.equal(
      answerPosts().length,
      2,
      `expected EXACTLY 2 answer POSTs (never 3+), saw ${answerPosts().length}`,
    );
    assert.equal(result.ok, false, 'persistent 401 must still surface failure');
    if (!result.ok) {
      assert.equal(
        result.message,
        INTERVIEW_SIGN_IN_HELP,
        'persistent 401 must surface INTERVIEW_SIGN_IN_HELP',
      );
    }
  } finally {
    restoreStub();
  }
});

test('400 validation failure: NO retry, exactly 1 answer POST', async () => {
  installStub();
  try {
    handler = (url) => {
      if (url === '/api/interview/answer') {
        return { status: 400, body: { error: 'invalid_request' } };
      }
      return { status: 200, body: {} };
    };

    const result = await submitInterviewAnswer(answerReq('Acme Rockets retry-3'));

    assert.equal(
      answerPosts().length,
      1,
      `expected exactly 1 answer POST on 400, saw ${answerPosts().length}`,
    );
    assert.equal(calls.length, 1, `expected no extra fetches on 400, saw ${calls.length}`);
    assert.equal(result.ok, false, '400 must surface failure');
  } finally {
    restoreStub();
  }
});

test('500 server failure: NO retry, exactly 1 answer POST', async () => {
  installStub();
  try {
    handler = (url) => {
      if (url === '/api/interview/answer') {
        return { status: 500, body: {} };
      }
      return { status: 200, body: {} };
    };

    const result = await submitInterviewAnswer(answerReq('Acme Rockets retry-4'));

    assert.equal(
      answerPosts().length,
      1,
      `expected exactly 1 answer POST on 500, saw ${answerPosts().length}`,
    );
    assert.equal(calls.length, 1, `expected no extra fetches on 500, saw ${calls.length}`);
    assert.equal(result.ok, false, '500 must surface failure');
  } finally {
    restoreStub();
  }
});

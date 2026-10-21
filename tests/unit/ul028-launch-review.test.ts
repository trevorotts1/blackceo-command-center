/**
 * UL-028 (lane L13) — client review + accessibility derivations.
 *
 * Proves the launch review screens:
 *   - link only real http(s) previews;
 *   - offer exactly ONE next action per run;
 *   - never describe a draft as live;
 *   - group previews/messages/automations into one packet and omit absent routes;
 *   - surface missing preview URLs as actionable inputs;
 *   - give the error summary a link to its detail list.
 *
 * Synthetic data only. No account, no network, no live sends.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPacket,
  diagnosticRows,
  errorSummary,
  nextAction,
  previewLink,
  publicationState,
  safeHttpUrl,
} from '@/app/launch/_lib/review';
import type { LaunchRun, LaunchUnit, LaunchUnitState } from '@/lib/launch-runs';

function unit(
  id: string,
  kind: LaunchUnit['kind'],
  detail: string,
  state: LaunchUnitState = 'pending',
  waitsFor: string[] = [],
): LaunchUnit {
  return { id, kind, label: `${kind} ${id}`, detail, state, waits_for: waitsFor };
}

function run(units: LaunchUnit[], aiRequested = false): LaunchRun {
  const doneUnits = units.filter((u) => u.state === 'complete').length;
  return {
    launchId: 'synthetic-launch',
    sourceFile: 'synthetic-launch.plan.json',
    offerName: 'Synthetic Offer',
    a2pReady: false,
    calendar: {},
    conversationAi: {
      requested: aiRequested,
      mode: aiRequested ? 'reply_bot' : 'none',
      channels: aiRequested ? ['sms'] : [],
      state: aiRequested ? 'pending' : 'dropped',
    },
    units,
    counts: {
      page: { total: 0, done: 0 },
      email: { total: 0, done: 0 },
      text: { total: 0, done: 0 },
      automation: { total: 0, done: 0 },
      conversation_ai: { total: aiRequested ? 1 : 0, done: 0 },
    },
    totalUnits: units.length,
    doneUnits,
    percentage: units.length === 0 ? 0 : Math.round((doneUnits / units.length) * 100),
    warnings: [],
  };
}

describe('UL-028 launch review', () => {
  it('accepts only absolute http(s) URLs as previews', () => {
    assert.equal(safeHttpUrl('https://example.com/landing'), 'https://example.com/landing');
    assert.equal(safeHttpUrl('http://example.com'), 'http://example.com/');
    assert.equal(safeHttpUrl('javascript:alert(1)'), null);
    assert.equal(safeHttpUrl('data:text/html,hi'), null);
    assert.equal(safeHttpUrl('/relative/path'), null);
    assert.equal(safeHttpUrl('planned, no URL yet'), null);
  });

  it('links a preview only for a page unit with a real URL', () => {
    const page = unit('page_landing', 'page', 'https://example.com/landing');
    const planned = unit('page_sales', 'page', 'planned, no URL yet');
    const email = unit('email_1', 'email', 'https://example.com/not-a-preview');

    assert.equal(previewLink(page)?.href, 'https://example.com/landing');
    assert.match(previewLink(page)?.label ?? '', /preview/);
    assert.match(previewLink(page)?.label ?? '', /opens in a new tab/);
    assert.equal(previewLink(planned), null);
    assert.equal(previewLink(email), null);
  });

  it('offers exactly one next action and prefers the real preview', () => {
    const action = nextAction(
      run([
        unit('page_landing', 'page', 'https://example.com/landing', 'complete'),
        unit('page_sales', 'page', 'https://example.com/offer', 'pending'),
        unit('email_1', 'email', '4 emails · drafts only', 'pending'),
      ]),
    );
    assert.equal(action.kind, 'preview');
    assert.equal(action.unitId, 'page_sales');
    assert.equal(action.href, 'https://example.com/offer');
    assert.equal(action.label, 'Review the page page_sales preview');
  });

  it('skips complete and dropped units when choosing the next action', () => {
    const action = nextAction(
      run([
        unit('page_landing', 'page', 'https://example.com/landing', 'complete'),
        unit('text_1', 'text', '2 messages · non-promotional', 'dropped'),
        unit('email_1', 'email', '4 emails · drafts only', 'pending'),
      ]),
    );
    assert.equal(action.kind, 'build');
    assert.equal(action.unitId, 'email_1');
    assert.equal(action.href, null);
  });

  it('asks for a missing preview URL instead of inventing one', () => {
    const action = nextAction(
      run([unit('page_sales', 'page', 'planned, no URL yet', 'pending')]),
    );
    assert.equal(action.kind, 'build');
    assert.match(action.detail, /Add the real preview URL/);
    assert.equal(action.href, null);
  });

  it('turns a blocked unit into a resolve action', () => {
    const action = nextAction(
      run([unit('auto_1', 'automation', 'template: win-back', 'blocked')]),
    );
    assert.equal(action.kind, 'resolve');
    assert.match(action.label, /Resolve/);
  });

  it('returns a go-live review only when every unit is complete and dropped units do not count', () => {
    const complete = nextAction(
      run([
        unit('page_landing', 'page', 'https://example.com/landing', 'complete'),
        unit('text_1', 'text', '2 messages', 'dropped'),
      ]),
    );
    assert.equal(complete.kind, 'go-live');
    assert.match(complete.detail, /separate, explicit decision/);
  });

  it('never describes a run as live', () => {
    const drafting = publicationState(
      run([unit('a', 'page', 'https://example.com/a', 'complete'), unit('b', 'email', '4 emails')]),
    );
    assert.equal(drafting.tone, 'draft');
    assert.match(drafting.label, /not live/);
    assert.equal(drafting.ready, false);

    const ready = publicationState(
      run([unit('a', 'page', 'https://example.com/a', 'complete')]),
    );
    assert.equal(ready.tone, 'ready');
    assert.match(ready.label, /not live/);
    assert.equal(ready.ready, true);

    const attention = publicationState(
      run([unit('a', 'page', 'https://example.com/a', 'blocked')]),
    );
    assert.equal(attention.tone, 'attention');
    assert.match(attention.label, /not live/);
  });

  it('groups previews, messages and automations into one packet', () => {
    const packet = buildPacket(
      run([
        unit('page_landing', 'page', 'https://example.com/landing'),
        unit('page_sales', 'page', 'planned, no URL yet'),
        unit('email_1', 'email', '4 emails · drafts only'),
        unit('text_1', 'text', '2 messages'),
        unit('auto_1', 'automation', 'template: x'),
      ]),
    );
    assert.deepEqual(packet.previews.map((p) => p.unitId), ['page_landing']);
    assert.deepEqual(packet.missingPreviews.map((u) => u.id), ['page_sales']);
    assert.deepEqual(packet.messages.map((u) => u.id), ['email_1', 'text_1']);
    assert.deepEqual(packet.automations.map((u) => u.id), ['auto_1']);
    assert.deepEqual(packet.absentKinds, ['conversation_ai']);
  });

  it('omits routes that are not planned at all', () => {
    const packet = buildPacket(run([unit('page_landing', 'page', 'https://example.com/l')]));
    assert.deepEqual(packet.absentKinds, ['emails', 'texts', 'automations', 'conversation_ai']);
  });

  it('keeps technical diagnostics collapsible in content and complete in data', () => {
    const rows = diagnosticRows(
      run([unit('page_sales', 'page', 'https://example.com/offer', 'running', ['page_landing'])]),
    );
    assert.deepEqual(rows, [
      { id: 'page_sales', kind: 'page', state: 'running', waitsFor: ['page_landing'] },
    ]);
  });

  it('links the error summary to the detail list', () => {
    assert.equal(errorSummary([]), null);
    const summary = errorSummary(['a.json: bad']);
    assert.deepEqual(summary, {
      count: 1,
      heading: '1 file could not be read',
      anchor: '#file-errors',
    });
    assert.equal(errorSummary(['a', 'b'])?.heading, '2 files could not be read');
  });
});

/**
 * Source contract for the two client-review screens. Cheap and mechanical:
 * it locks the accessibility/truthfulness markers the unit acceptance names,
 * so a later edit cannot quietly drop them.
 */
describe('UL-028 launch screens — markup contract', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'launch', rel), 'utf8');

  it('list screen: linked error summary, descriptive card links, progress semantics, no table', () => {
    const page = read('page.tsx');
    const lib = read('_lib/review.ts');
    assert.match(page, /href=\{summary\.anchor\}/);
    assert.match(lib, /anchor: '#file-errors'/);
    assert.match(page, /id="file-errors"/);
    assert.match(page, /role="alert"/);
    assert.match(page, /aria-label=\{`Open launch /);
    assert.match(page, /role="progressbar"/);
    assert.match(page, /aria-valuenow=\{percentage\}/);
    assert.match(page, /focus-visible:outline/);
    assert.match(page, /\{state\.label\}/);
    assert.match(lib, /not live/);
    assert.doesNotMatch(page, /<table/);
    assert.doesNotMatch(page, /role="presentation"/);
  });

  it('detail screen: semantic status, one next action, expandable diagnostics, draft vs live, no table', () => {
    const page = read('[launchId]/page.tsx');
    assert.match(page, /role="status"/);
    assert.match(page, /id="next-action-heading"/);
    assert.match(page, /id="packet"/);
    assert.match(page, /id="draft-live"/);
    assert.match(page, /id="diagnostics"/);
    assert.match(page, /<details/);
    assert.match(page, /<summary/);
    assert.match(page, /focus-visible:outline/);
    assert.match(page, /aria-current="page"/);
    assert.match(page, /sr-only">Status: /);
    assert.match(page, /opens in a new tab/);
    assert.match(page, /Draft or live\?/);
    assert.doesNotMatch(page, /<table/);
    assert.doesNotMatch(page, /min-w-\[240px\]/);
    assert.doesNotMatch(page, /target="_blank"[^>]*>here</);
  });
});

/**
 * RRX-032 — "today" on the rescue page is the Eastern day.
 *
 * The headline counts used to be built from the store's UTC day key, so every
 * evening after 8 PM Eastern (7 PM in daylight time) the page rolled over to
 * the next day's numbers. The page's day is a person's day: midnight to
 * midnight in `America/New_York`.
 *
 * The store's own per-client counters (`utcDayKey`, `capSuppressedForDay`)
 * deliberately stay on the UTC date — those joins are not changed here.
 *
 * Pure logic only: no DB, no network, no DOM. Node built-in test runner under
 * tsx (`npm run test:unit`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { easternDayWindow } from '../../src/lib/rescue/severity';

test('[RRX-032] easternDayWindow: 8:30 PM Eastern on November 11 (standard time) is 05:00Z to 05:00Z', () => {
  const win = easternDayWindow(new Date('2026-11-12T01:30:00Z'));
  assert.equal(win.startIso, '2026-11-11T05:00:00.000Z');
  assert.equal(win.endIso, '2026-11-12T05:00:00.000Z');
});

test('[RRX-032] easternDayWindow: 11:30 PM Eastern on June 30 (daylight time) starts 04:00Z', () => {
  const win = easternDayWindow(new Date('2026-07-01T03:30:00Z'));
  assert.equal(win.startIso, '2026-06-30T04:00:00.000Z');
});

test('[RRX-032] easternDayWindow: the label names the Eastern date and says so', () => {
  const win = easternDayWindow(new Date('2026-11-12T01:30:00Z'));
  assert.ok(win.label.includes('November 11'), `label was ${win.label}`);
  assert.ok(win.label.endsWith('(Eastern)'), `label was ${win.label}`);
});

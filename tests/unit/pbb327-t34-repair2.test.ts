/**
 * tests/unit/pbb327-t34-repair2.test.ts
 *
 * PBB-327 / T-34 repair2 — the two defects the QC verdict (qc5-t-34) left open
 * on cffb709187, plus the ordering class behind one of them.
 *
 *   R1 REACHABILITY. `src/components/ClientExceptionsOutcomes.tsx` existed but
 *      nothing under `src/app/**` imported or rendered it, and no route ran the
 *      one real adapter (`loadFailureAlerts`). A component that is never mounted
 *      is not a view. Cases below sweep `src/app/**` for a mount, then RENDER a
 *      real app route against a real tenant row to prove the adapter is wired.
 *
 *   R2 TIE-BREAK. `lastClosingEvent` ordered by parsed instant, so two closing
 *      events at the SAME instant were credited by ROW ORDER (`at > bestAt` is
 *      false for the second row, so the first row won). Credit flipped with the
 *      input order: '2026-10-24T08:00:00Z' vs '2026-10-24 08:00:00' is the exact
 *      mixed-format pair the original D3 was about. Every ordering comparison in
 *      the unit is exercised for order-independence:
 *        - lastClosingEvent (closing actor)
 *        - duplicate alert ids at equal revision (which record survives)
 *        - duplicate booking ids (row order)
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *        --import ./tests/setup/tmp-sandbox.ts --test \
 *        tests/unit/pbb327-t34-repair2.test.ts
 *
 * Own throwaway database: the route case seeds bug_tickets in an isolated DB.
 */

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH (C8 guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import * as ReactNamespace from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  projectAlerts,
  projectBookings,
  type AlertInput,
  type BookingInput,
} from '../../src/lib/cc/exceptions-outcomes';
import {
  bugTicketsToAlerts,
  type BugTicketEventRow,
  type BugTicketViewRow,
} from '../../src/lib/cc/exceptions-outcomes-db';

/* tsx compiles JSX to the classic factory; the component tree still renders
 * through react-dom/server, so the React namespace is installed as B25 does. */
(globalThis as Record<string, unknown>).React = ReactNamespace;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function ticket(overrides: Partial<BugTicketViewRow> = {}): BugTicketViewRow {
  return {
    id: 'BUG-T',
    symptom: 'Opt-out webhook was ignored',
    severity: 'P1 degraded',
    client_slug: 'client-acorn',
    status: 'CLOSED',
    assigned_healer_agent_id: null,
    dedup_of: null,
    recurrence_count: 0,
    evidence_paths: null,
    healing_report_path: 'evidence/healing/BUG-T.json',
    fix_summary: null,
    closed_at: '2026-10-24 09:30:00',
    reported_at: '2026-10-24 07:00:00',
    updated_at: '2026-10-24 10:00:00',
    ...overrides,
  };
}

function closing(actor: string, created_at: string, reason: string | null = null): BugTicketEventRow {
  return { bug_id: 'BUG-T', to_status: 'CLOSED', actor, reason, created_at };
}

/** The credited closing actor for one row order. */
function credited(order: BugTicketEventRow[]): string | null {
  return bugTicketsToAlerts([ticket()], order)[0].clearance?.by ?? null;
}

function alert(overrides: Partial<AlertInput> = {}): AlertInput {
  return {
    id: 'A-1',
    surface: 'failures',
    severity: 'P1 degraded',
    title: 'Webhook retries stalled',
    owner: { assigned_agent_id: 'agent-healer-1' },
    first_seen_at: '2026-10-24T08:00:00.000Z',
    last_seen_at: '2026-10-24T10:00:00.000Z',
    revision: 3,
    ...overrides,
  };
}

/* ───────────────── R2a: two closing events at the SAME instant ───────────── */

test('R2a: two closing events at one instant credit the SAME actor in both row orders', () => {
  // Same instant, the two writer formats the repo really produces:
  // new Date().toISOString() and sqlite datetime('now').
  const iso = closing('ACTOR-ISO', '2026-10-24T08:00:00Z'); // 08:00Z
  const sqlite = closing('ACTOR-SQLITE', '2026-10-24 08:00:00'); // 08:00Z

  const forward = credited([iso, sqlite]);
  const reversed = credited([sqlite, iso]);

  assert.equal(
    forward,
    reversed,
    `row order changed the credited actor: ${forward} vs ${reversed} — two records competing for the same rank must resolve by a total key, not by arrival`,
  );
  assert.ok(forward === 'ACTOR-ISO' || forward === 'ACTOR-SQLITE', 'one of the two real actors is credited');
});

test('R2b: identical timestamps still resolve by a total key, in both row orders', () => {
  const a = closing('ACTOR-A', '2026-10-24 08:00:00', 'reason-one');
  const b = closing('ACTOR-B', '2026-10-24 08:00:00', 'reason-two');

  assert.equal(
    credited([a, b]),
    credited([b, a]),
    'byte-identical timestamps must not fall back to arrival order',
  );
});

test('R2c: a third event at the same instant is stable under every permutation', () => {
  const events = [
    closing('ACTOR-A', '2026-10-24T08:00:00Z'),
    closing('ACTOR-B', '2026-10-24 08:00:00'),
    closing('ACTOR-C', '2026-10-24T08:00:00.000Z'),
  ];
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ].map((order) => credited(order.map((index) => events[index])));
  assert.equal(new Set(permutations).size, 1, `all six orders agree: ${JSON.stringify(permutations)}`);
});

test('R2 inverse: proven beats unproven, and a later instant still wins', () => {
  assert.equal(
    credited([closing('UNPROVEN', 'not-a-time'), closing('PROVEN', '2026-10-24 09:00:00')]),
    'PROVEN',
    'an unparseable timestamp never outranks a proven one',
  );
  assert.equal(
    credited([closing('EARLIER', '2026-10-24 08:00:00'), closing('LATER', '2026-10-24T09:00:00Z')]),
    'LATER',
    'a genuinely later close still wins',
  );
});

/* ────────── R2d: duplicate ids at EQUAL revision (which record survives) ──── */

test('R2d: duplicate alert ids at equal revision keep the same record in both input orders', () => {
  const alpha = alert({ id: 'DUP', title: 'alpha version', surface: 'failures' });
  const beta = alert({ id: 'DUP', title: 'beta version', surface: 'bookings' });

  const forward = projectAlerts([alpha, beta]).rows;
  const reversed = projectAlerts([beta, alpha]).rows;

  assert.equal(forward.length, 1);
  assert.equal(reversed.length, 1);
  assert.equal(
    forward[0].title,
    reversed[0].title,
    `equal revision must not be decided by arrival: ${forward[0].title} vs ${reversed[0].title}`,
  );
  assert.equal(forward[0].surface, reversed[0].surface);
});

test('R2d inverse: a higher revision still wins over a lower one, in both orders', () => {
  const older = alert({ id: 'DUP', title: 'older', revision: 2 });
  const newer = alert({ id: 'DUP', title: 'newer', revision: 5 });
  assert.equal(projectAlerts([older, newer]).rows[0].title, 'newer');
  assert.equal(projectAlerts([newer, older]).rows[0].title, 'newer');
});

/* ───────────── R2e: duplicate booking ids, row order must be total ───────── */

test('R2e: duplicate booking ids render in the same order in both input orders', () => {
  const requested: BookingInput = { id: 'B-DUP', status: 'requested' };
  const confirmed: BookingInput = { id: 'B-DUP', status: 'confirmed', confirmation_receipt: 'rcpt-1' };

  const forward = projectBookings([requested, confirmed]).rows.map((row) => row.stage);
  const reversed = projectBookings([confirmed, requested]).rows.map((row) => row.stage);

  assert.deepEqual(
    forward,
    reversed,
    `two rows with one id must order by a total key, not by arrival: ${forward.join(',')} vs ${reversed.join(',')}`,
  );
});

/* ───── R2f: control — the pre-existing row order was already total ───────── */

test('R2f control: equal-ranked rows already order by id in both input orders', () => {
  // Same priority, same last-seen instant: only the id separates them, and the
  // comparator already used it. This is the "already deterministic" control —
  // the attack on R2a–R2e is not a blanket failure of every ordering.
  const a = alert({ id: 'A-1', last_seen_at: '2026-10-24T10:00:00.000Z' });
  const b = alert({ id: 'B-1', last_seen_at: '2026-10-24T10:00:00.000Z' });

  const forward = projectAlerts([a, b]).rows.map((row) => row.id);
  const reversed = projectAlerts([b, a]).rows.map((row) => row.id);

  assert.deepEqual(forward, ['A-1', 'B-1']);
  assert.deepEqual(reversed, ['A-1', 'B-1']);
});

/* ─────────────── R1a: the view is mounted on a real app route ────────────── */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts|jsx|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('R1a: an app route imports AND renders ClientExceptionsOutcomes', () => {
  const appDir = path.join(REPO_ROOT, 'src/app');
  const mounted = walk(appDir).filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return (
      /from\s+['"]@\/components\/ClientExceptionsOutcomes['"]/.test(source) &&
      /<ClientExceptionsOutcomes\b/.test(source)
    );
  });

  assert.ok(
    mounted.length > 0,
    'no file under src/app/ imports and renders ClientExceptionsOutcomes — the component is orphaned (this is the verdict\'s clause-12 defect)',
  );

  // Same sweep for a component known to be live: the instrument discriminates.
  const control = walk(appDir).filter((file) => /<MissionQueue\b/.test(fs.readFileSync(file, 'utf8')));
  assert.ok(control.length > 0, 'control: MissionQueue is mounted, so an empty target result is not a broken sweep');

  // The route lives under /workspace, so it inherits the middleware auth gate
  // rather than opening a new unauthenticated surface.
  for (const file of mounted) {
    assert.ok(
      path.relative(appDir, file).startsWith(path.join('workspace')),
      `${path.relative(REPO_ROOT, file)} must sit under the authenticated /workspace route tree`,
    );
  }
});

/* ───────── R1b: the route really runs the real adapter on real rows ──────── */

test('R1b: the mounted route renders a REAL tenant row through loadFailureAlerts', async () => {
  // Import after _isolated-db so the throwaway DATABASE_PATH is in force.
  const { getDb } = await import('../../src/lib/db');
  const db = getDb();

  db.prepare(
    `INSERT INTO bug_tickets
       (id, workspace_id, reporter_department, symptom, severity, client_slug, status,
        reported_at, updated_at)
     VALUES (?, NULL, 'bugs', ?, 'P1 degraded', ?, 'REPORTED', ?, ?)`,
  ).run(
    'BUG-R2-MINE',
    'Route must show this tenant row',
    'client-acorn',
    '2026-10-24 07:00:00',
    '2026-10-24 10:00:00',
  );
  db.prepare(
    `INSERT INTO bug_tickets
       (id, workspace_id, reporter_department, symptom, severity, client_slug, status)
     VALUES (?, NULL, 'bugs', ?, 'P1 degraded', ?, 'REPORTED')`,
  ).run('BUG-R2-THEIRS', 'Another tenant must never appear', 'client-other');

  const mod = await import('../../src/app/workspace/[slug]/exceptions/page');
  const Page = mod.default;

  const element = await Page({ params: Promise.resolve({ slug: 'client-acorn' }) });
  const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);

  assert.match(html, /data-view="exceptions-outcomes"/, 'the view component is the route\'s output');
  assert.match(html, /data-tenant="client-acorn"/, 'the route passes its own tenant to the view');
  assert.match(html, /data-surface="failures" data-state="live"/, 'the real failure adapter answered live');
  assert.match(html, /data-item-id="BUG-R2-MINE"/, 'the adapter read the real bug_tickets row');
  assert.doesNotMatch(html, /BUG-R2-THEIRS/, 'tenancy holds: another client\'s failure is not rendered');
});

/**
 * CRT-002 — the SOP panel's "no longer exists" state must be reachable for a
 * SOFT-DELETED SOP, not only for a hard 404.
 *
 * THE DEFECT. TaskSopPanel (src/components/TaskOverviewPanels.tsx) fetched
 * /api/sops/<task.sop_id> and treated ONLY `res.status === 404` as "the
 * attached playbook is gone". But GET /api/sops/[id] runs
 * `SELECT * FROM sops WHERE id = ? OR slug = ?` — NO deleted_at filter — while
 * DELETE /api/sops/[id] is a SOFT delete (`UPDATE sops SET deleted_at = ...`).
 * A soft-deleted SOP therefore returns 200 with the row, the panel renders the
 * ordinary live link `href="/sops/<id>"`, and the panel's own claimed state
 * ("Attached playbook no longer exists — re-attach below.",
 * data-testid="task-sop-dead") is unreachable for the exact case its comment
 * cites. Meanwhile the Triad banner (checkTriad + isLiveSopId, src/lib/sops.ts)
 * already treats a deleted_at row as missing — the two surfaces disagreed.
 *
 * THE CONTRACT PROVEN HERE (real render, never a restatement):
 *   - 200 + deleted_at set (soft-deleted)  → dead state, NO ordinary link
 *   - 200 + deleted_at null (live)         → ordinary link, NO dead state
 *   - 404 (hard-missing)                   → dead state (pre-existing path)
 *   - 500 (unknown)                        → link kept (unknown is not missing)
 *
 * The predicate the panel now uses is sops.deleted_at on the row the SAME
 * fetch already carries — the identical column and polarity as isLiveSopId()
 * (`!!row && !row.deleted_at`), the liveness predicate the Triad banner uses.
 * isLiveSopId reads SQLite server-side and cannot be imported into a client
 * component; the row it would re-read is already in hand from the GET.
 *
 * Runner: node --import tsx --test tests/unit/crt-002-sop-soft-delete-liveness.test.ts
 * (no DB touched — the fetch is stubbed; the panel module itself never reaches
 * @/lib/db, so no './_isolated-db' import is needed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ── real-DOM harness (jsdom; set before react-dom is imported) ──────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
(globalThis as unknown as { window: unknown }).window = dom.window;
(globalThis as unknown as { document: unknown }).document = dom.window.document;
(globalThis as unknown as { navigator: unknown }).navigator = dom.window.navigator;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ReactModule = typeof import('react');
type PanelModule = typeof import('../../src/components/TaskOverviewPanels');

let React: ReactModule;
let createRoot: (container: unknown) => { render: (el: unknown) => void; unmount: () => void };
let TaskSopPanel: PanelModule['TaskSopPanel'];

test.before(async () => {
  React = await import('react');
  ({ createRoot } = (await import('react-dom/client')) as unknown as {
    createRoot: typeof createRoot;
  });
  ({ TaskSopPanel } = await import('../../src/components/TaskOverviewPanels'));
});

/** One stubbed /api/sops/<id> response. */
interface StubResponse {
  status: number;
  ok: boolean;
  body?: unknown;
}

function stubFetch(res: StubResponse): { calls: string[] } {
  const calls: string[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
    calls.push(String(url));
    return {
      status: res.status,
      ok: res.ok,
      json: async () => res.body,
    };
  };
  return { calls };
}

interface Rendered {
  container: Element;
  deadNode: Element | null;
  anchor: Element | null;
  hitStatuses: number[];
  cleanup: () => void;
}

/** Render the REAL TaskSopPanel with task.sop_id set and a stubbed fetch. */
async function renderWith(res: StubResponse): Promise<Rendered> {
  const hitStatuses: number[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
    assert.match(String(url), /^\/api\/sops\//, 'panel must fetch /api/sops/<id>');
    hitStatuses.push(res.status);
    return { status: res.status, ok: res.ok, json: async () => res.body };
  };

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(TaskSopPanel, {
        task: { id: 'crt2-task', sop_id: 'crt2-sop' } as never,
        onChangeSop: () => {},
      }),
    );
    await new Promise((r) => setTimeout(r, 25));
  });

  return {
    container,
    deadNode: container.querySelector('[data-testid="task-sop-dead"]'),
    anchor: container.querySelector('a[href^="/sops/"]'),
    hitStatuses,
    cleanup: () => {
      root.unmount();
      container.remove();
    },
  };
}

// ── 1. THE DEFECT: soft-deleted row, served 200 ─────────────────────────────
test('1 — soft-deleted SOP (200 + deleted_at) must render the dead state, never a live link', async () => {
  const r = await renderWith({
    status: 200,
    ok: true,
    body: { id: 'crt2-sop', name: 'Retired SOP', deleted_at: '2026-09-01T00:00:00.000Z' },
  });
  try {
    assert.deepEqual(r.hitStatuses, [200], 'precondition: the soft-deleted SOP IS served 200 by GET (no deleted_at filter)');
    assert.ok(r.deadNode, 'soft-deleted SOP must reach the "no longer exists" state — it is missing, not live');
    assert.match(r.deadNode!.textContent ?? '', /no longer exists/);
    assert.equal(r.anchor, null, 'a soft-deleted SOP must NOT render the ordinary live /sops/<id> link');
  } finally {
    r.cleanup();
  }
});

// ── 2. DISCRIMINATION CONTROL: live row, same 200 branch ────────────────────
test('2 — live SOP (200 + deleted_at null) still renders the link and no dead state', async () => {
  const r = await renderWith({
    status: 200,
    ok: true,
    body: { id: 'crt2-sop', name: 'Live SOP', deleted_at: null },
  });
  try {
    assert.deepEqual(r.hitStatuses, [200]);
    assert.equal(r.deadNode, null, 'a live SOP must never claim it no longer exists');
    assert.ok(r.anchor, 'a live SOP must render the link');
    assert.equal(r.anchor!.getAttribute('href'), '/sops/crt2-sop');
    assert.match(r.container.textContent ?? '', /Live SOP/, 'the live SOP title is shown');
  } finally {
    r.cleanup();
  }
});

// ── 3. Hard-missing (the pre-existing 404 path) ─────────────────────────────
test('3 — hard-missing SOP (404) still renders the dead state', async () => {
  const r = await renderWith({ status: 404, ok: false });
  try {
    assert.ok(r.deadNode, '404 must reach the same dead state');
    assert.equal(r.anchor, null);
  } finally {
    r.cleanup();
  }
});

// ── 4. Unknown state is NOT missing (no weakening) ──────────────────────────
test('4 — read failure (500) is unknown, not missing: link kept', async () => {
  const r = await renderWith({ status: 500, ok: false });
  try {
    assert.equal(r.deadNode, null, 'a 5xx is unknown state — it must not be reported as "no longer exists"');
    assert.ok(r.anchor, 'the id stays visible when the read could not be verified');
  } finally {
    r.cleanup();
  }
});

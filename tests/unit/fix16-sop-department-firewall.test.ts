/**
 * FIX-16 — SOP department firewall (Error 11 / Rule R11).
 *
 * BUG: The CC SOP matcher (`suggestSOPsForTask` / `getBestSOPForTask` in
 * src/lib/sops.ts) scores a SOP against a task by keyword overlap + canonical
 * department match — but a keyword-only match has NO department floor. A
 * presentation task titled "New web property launch" scores 0.5 (5+ keyword
 * hits, keyword cap) on a Web Development SOP despite the department mismatch,
 * and a Customer Support SOP can win on a department-less row. Observed on
 * Aug 5: a deck task got "Customer Support: End-of-Day Wrap-Up" and the E2E
 * deck task got "Web Development: New Web Property or Major Feature Launch".
 * Neither is a presentation SOP.
 *
 * FIX: a hard department firewall in the matcher. When the task's department
 * resolves to a NON-EMPTY canonical slug, a candidate SOP is ELIGIBLE only if
 * its own canonical department matches the task's department OR the SOP is
 * department-less (department null/''). A SOP that declares a DIFFERENT
 * department is excluded outright — it can never win on keywords or semantic
 * similarity. (department-less SOPs stay eligible so the Triad Rule floor
 * keeps working.) A presentation task therefore gets a presentation SOP or
 * null — NEVER a Web Dev / Customer Support / any other department's SOP.
 *
 * The firewall lives at the candidate-set layer, so every task-attachment
 * path that goes through the matcher is covered: createTaskCore, the dispatch
 * SOP pull, the tasks PATCH Triad auto-resolve, and GET /api/sops/suggest.
 *
 * QC GATE (from the Gauntlet doc):
 *   Create a presentation task titled "New web property launch"; call
 *   getBestSOPForTask. It must return a presentation SOP or null — NEVER a
 *   Web Development / Customer Support SOP.
 *
 * This suite proves the gate directly at the matcher layer (isolated DB, no
 * network — same technique as sop-semantic-search.test.ts).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalDeptSlug } from '../../src/lib/routing/canonical-slug';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fix16-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;
// No embedding provider — force the keyword path so the firewall is proven
// without network/semantics as a confounder.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_AI_STUDIO_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.SOP_EMBEDDING_PROVIDER;

type DbModule = typeof import('../../src/lib/db');
type SopsModule = typeof import('../../src/lib/sops');

let queryAll: DbModule['queryAll'];
let queryOne: DbModule['queryOne'];
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

let getBestSOPForTask: SopsModule['getBestSOPForTask'];
let suggestSOPsForTaskKeyword: SopsModule['suggestSOPsForTaskKeyword'];

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}`;

/** Insert a SOP row. department=null inserts a DEPARTMENT-LESS SOP. */
function insertSop(
  id: string,
  name: string,
  slug: string,
  department: string | null,
  taskKeywords: string,
): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO sops
       (id, name, slug, description, version, department, task_keywords, steps,
        success_criteria, persona_hints, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 1, ?, ?, ?, NULL, '[]', ?, ?)`,
    [
      id, name, slug, department, taskKeywords,
      JSON.stringify([{ name: 'Step 1', checklist: [] }]),
      now, now,
    ],
  );
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  queryAll = db.queryAll;
  queryOne = db.queryOne;
  run = db.run;
  closeDb = db.closeDb;
  db.getDb(); // run migration chain (seeds starter SOPs too)

  const sops = await import('../../src/lib/sops');
  getBestSOPForTask = sops.getBestSOPForTask;
  suggestSOPsForTaskKeyword = sops.suggestSOPsForTaskKeyword;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── 1. The exact QC-gate scenario ──────────────────────────────────────────────
// Presentation task titled "New web property launch". Seed a web-development trap
// whose keywords overlap heavily (enough to reach the 0.5 keyword cap) and a
// customer-support trap. Pre-fix, the web-dev trap WINS getBestSOPForTask
// (score 0.5 >= threshold 0.5, department mismatch ignored). Post-fix it must
// be excluded → the matcher returns a presentation SOP or null.
test('[FIX-16] presentation task "New web property launch" → presentation SOP or null, NEVER web-dev/customer-support', async () => {
  insertSop(
    'fix16-trap-webdev',
    'Web Development: New Web Property or Major Feature Launch',
    'fix16-web-property',
    'web-development',
    'web,property,launch,feature,site,new,build,deploy,frontend,website',
  );
  insertSop(
    'fix16-trap-support',
    'Customer Support: End-of-Day Wrap-Up',
    'fix16-eod-wrapup',
    'customer-support',
    'support,end-of-day,wrap-up,report,ticket,customer',
  );

  const description =
    'Launch a brand-new web property for the client. Build the new site, deploy the feature, and go live.';
  const best = await getBestSOPForTask({
    title: 'New web property launch',
    description,
    department: 'presentations',
  });

  if (best !== null) {
    const canonDept = canonicalDeptSlug(best.department ?? '');
    assert.ok(
      canonDept === 'presentations' || canonDept === '',
      `[FIX-16] A presentations task must get a PRESENTATION SOP or null, got: "${best.name}" (dept=${best.department ?? 'null'} → ${canonDept})`,
    );
  }
  // Regardless of threshold, it must NOT be one of the seeded cross-dept traps.
  assert.ok(
    best === null || (best.id !== 'fix16-trap-webdev' && best.id !== 'fix16-trap-support'),
    `[FIX-16] presentations task must NEVER attach a web-development / customer-support SOP (got "${best?.name}")`,
  );
});

// ── 2. A web-development task still gets its OWN dept SOP (no regression) ──────
test('[FIX-16] web-development task still matches its own department SOP (no regression)', async () => {
  const best = await getBestSOPForTask({
    title: 'New web property launch',
    description: 'Build and deploy the new client website.',
    department: 'web-development',
  });
  assert.ok(best !== null, '[FIX-16] web-development task must resolve a SOP');
  assert.equal(
    canonicalDeptSlug(best!.department ?? ''),
    'web-development',
    `[FIX-16] web-development task must get a web-development SOP, got "${best!.name}" (dept=${best!.department})`,
  );
});

// ── 3. Keyword-only cross-dept SOP must not surface at ANY limit (hard floor) ──
test('[FIX-16] no cross-dept SOP ever surfaces for a presentations task (limit=5)', () => {
  const results = suggestSOPsForTaskKeyword(
    {
      title: 'New web property launch',
      description: 'Launch a brand-new web property for the client.',
      department: 'presentations',
    },
    5,
  );
  assert.ok(Array.isArray(results), 'must return an array');
  for (const r of results) {
    const dept = r.sop.department ?? null;
    if (dept !== null) {
      assert.equal(
        canonicalDeptSlug(dept),
        'presentations',
        `[FIX-16] a cross-dept SOP must never surface for a presentations task (got "${r.sop.name}", dept=${dept})`,
      );
    }
  }
});

// ── 4. A presentation SOP, when it exists, is preferred for a presentation task ─
test('[FIX-16] a presentations-department SOP is the top pick when present', async () => {
  const sopId = nextId('fix16-pres');
  insertSop(sopId, 'Presentations: Deck Build', 'fix16-deck-build', 'presentations', 'deck,slides,presentation,design');
  const best = await getBestSOPForTask({
    title: 'New web property launch',
    description: 'Create a presentation deck.',
    department: 'presentations',
  });
  if (best) {
    assert.equal(
      canonicalDeptSlug(best.department ?? ''),
      'presentations',
      `[FIX-16] presentations task must prefer the presentations SOP, got "${best.name}" (dept=${best.department})`,
    );
  }
});

// ── 5. Department-less SOPs stay eligible (Triad floor preserved) ─────────────
test('[FIX-16] a department-less SOP is still an eligible fallback for a presentations task', async () => {
  const sopId = nextId('fix16-generic');
  insertSop(sopId, 'Generic Quality Process', 'fix16-generic', null, 'quality,process,checklist,review');
  const results = suggestSOPsForTaskKeyword(
    { title: 'Deck quality review process', description: 'Run the deck through the quality review process.', department: 'presentations' },
    5,
  );
  const ids = results.map((r) => r.sop.id);
  assert.ok(
    ids.includes(sopId),
    `[FIX-16] a department-less SOP must remain an eligible fallback (results: ${ids.join(',')})`,
  );
});

// ── 6. Tasks WITHOUT a department keep the OLD behavior (no floor imposed) ─────
test('[FIX-16] a task with no department is unfiltered (behavior unchanged)', () => {
  const results = suggestSOPsForTaskKeyword(
    { title: 'New web property launch', description: 'Launch a brand-new web property.', department: null, workspace_id: null },
    10,
  );
  assert.ok(Array.isArray(results), 'must return an array');
  const ids = results.map((r) => r.sop.id);
  assert.ok(
    ids.includes('fix16-trap-webdev'),
    `[FIX-16] a department-less task must still see keyword matches across departments (got: ${ids.join(',')})`,
  );
});

// ── 7. workspace_id fallback: a presentation workspace still firewalls ────────
test('[FIX-16] a presentation workspace_id (UI-created path) also firewalls cross-dept SOPs', async () => {
  const best = await getBestSOPForTask({
    title: 'New web property launch',
    description: 'Launch a brand-new web property for the client.',
    department: undefined,
    workspace_id: 'presentations',
  });
  if (best !== null) {
    assert.equal(
      canonicalDeptSlug(best.department ?? ''),
      'presentations',
      `[FIX-16] workspace_id=presentations must still restrict to presentation SOPs, got "${best.name}" (dept=${best.department})`,
    );
  }
  assert.ok(
    best === null || best.id !== 'fix16-trap-webdev',
    '[FIX-16] the web-dev trap must be firewalled even via workspace_id',
  );
});

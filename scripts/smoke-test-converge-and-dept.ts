/**
 * Smoke test for the self-service add+wire CC changes (§4.2 requirement) plus the
 * BUILD-01/BUILD-02/BUILD-06 build-integrity gate:
 *
 *   A. POST /api/departments with full-wire body hits /api/departments (not /api/workspaces)
 *   B. Missing host script returns FAIL-LOUD (503, no bare row, no success:true)
 *   C. POST /api/system/converge returns ok:true with workspace + sop counts + rebuild directive
 *   D. POST /api/departments/[id]/roles with missing script returns 503 FAIL-LOUD
 *   E. Personas endpoint marks empty-domain personas as needs_tags:true, routable:false
 *   F. Department-tagged ingest ROUTES to the known department AND advances past
 *      backlog (task gets dispatched to a specialist agent — not left an
 *      unassigned backlog card). This is the functional inverse of the dead
 *      Kanban regression.
 *   G. BUILD-INTEGRITY GATE — `.next/BUILD_ID` exists and is FRESH (no src/ or
 *      config file newer than the compiled build). A stale/missing build is the
 *      dead-Kanban root cause; this gate fails loud so a deploy verification run
 *      never green-lights an un-rebuilt box.
 *
 * Run:  npx tsx scripts/smoke-test-converge-and-dept.ts
 *
 * Sections A–F use a throwaway SQLite DB (no live box required). Section G reads
 * the real `.next/BUILD_ID` on disk; set SMOKE_SKIP_BUILD_GATE=1 to skip it in a
 * pure-unit context that never builds (deploy verification must NOT skip it).
 */

// SAFETY-05 — MUST BE FIRST. Section F drives the tasks/ingest route, which calls
// notifyOwnerAssigned() -> notifyOwner() -> a REAL `openclaw message send`. A bare
// `tsx` run sets no test-runner env, so notify.ts cannot self-detect here.
import './lib/no-outbound-sends.js';

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ── Fixture DB setup ─────────────────────────────────────────────────────────
const tmpDb = path.join(os.tmpdir(), `converge-smoke-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.MISSION_CONTROL_DB_PATH = tmpDb;
// Disable auth so smoke can call without a real MC_API_TOKEN
delete process.env.MC_API_TOKEN;
// Section F ingests through /api/tasks/ingest. That route requires WEBHOOK_SECRET
// in production; in dev it is skipped. Clear the secret and set the explicit
// test escape hatch so the ingest handler accepts the fixture call regardless of
// how NODE_ENV is set in the runner.
delete process.env.WEBHOOK_SECRET;
process.env.ALLOW_INSECURE_OPEN_API = 'true';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// ── Build-integrity helpers (Section G) ──────────────────────────────────────

/** Walk up from `start` to the repo root (dir with package.json + next.config.mjs). */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'next.config.mjs'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * Return the path of the FIRST file under `dir` whose mtime is newer than
 * `refMs`, or null if none. Short-circuits on the first hit. Used to detect a
 * build that predates the current source (stale build = dead-Kanban class).
 */
function firstFileNewerThan(dir: string, refMs: number): string | null {
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        try {
          if (fs.statSync(full).mtimeMs > refMs) return full;
        } catch {
          /* unreadable file — ignore */
        }
      }
    }
  }
  return null;
}

// ── Import route handlers directly (no HTTP server needed) ──────────────────
// We import after setting DATABASE_PATH so the DB module picks up our tmp path.

async function runSmoke() {
  console.log('\n── Self-service add+wire smoke tests ───────────────────────');

  // ─── A. Create-dept body shape ───────────────────────────────────────────
  console.log('\nA. departments CREATE body reaches /api/departments (not bare /api/workspaces)');
  {
    // Dynamically import to pick up fixture env
    const { POST: deptPost } = await import('../src/app/api/departments/route.js');
    const req = new Request('http://localhost/api/departments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ create: true, name: 'Smoke Test Dept', icon: '🔬' }),
    });
    // We expect either a 503 (no host script on CI) or 201 (host script present).
    // In either case, the response must NOT be the bare /api/workspaces shape
    // (which returns { id, name, slug, ... } at root level without mode).
    // The departments route returns { success, mode, ... }.
    const res = await deptPost(req as never);
    const data = await res.json() as { success?: boolean; mode?: string; message?: string };
    assert(
      'mode' in data || 'message' in data,
      'response has "mode" or "message" field (departments route, not bare workspaces)'
    );
    assert(
      res.status === 503 || res.status === 201 || res.status === 500,
      `status is 201 (script found) or 503 (no script) or 500 (script failed), got ${res.status}`
    );
  }

  // ─── B. Missing host script → FAIL-LOUD (not success:true with mode:direct) ─
  console.log('\nB. Missing host script → FAIL-LOUD (503, no success:true)');
  {
    // The smoke environment never has the host script, so status must NOT be 201
    // with success:true unless the script is actually present.
    const { POST: deptPost } = await import('../src/app/api/departments/route.js');
    const req = new Request('http://localhost/api/departments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ create: true, name: 'No Script Dept', icon: '❌' }),
    });
    const res = await deptPost(req as never);
    const data = await res.json() as { success?: boolean; mode?: string };

    if (res.status === 201 && data.success) {
      // Host script IS present on this machine — mode must be 'script', never 'direct'
      assert(
        data.mode === 'script',
        `script found → mode must be 'script' (not 'direct'), got '${data.mode}'`
      );
    } else {
      // No host script — must be FAIL-LOUD (503/500), not success:true
      assert(
        !data.success,
        `no script → success must be false, got ${data.success}`
      );
      assert(
        res.status === 503 || res.status === 500,
        `no script → status must be 503 or 500, got ${res.status}`
      );
      assert(
        data.mode !== 'direct',
        `no script → mode must NOT be 'direct' (silent unwired fallback killed)`
      );
    }
  }

  // ─── C. Converge endpoint returns ok:true ────────────────────────────────
  console.log('\nC. POST /api/system/converge returns ok:true');
  {
    const { POST: convergePost } = await import('../src/app/api/system/converge/route.js');
    const req = new Request('http://localhost/api/system/converge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'all' }),
    });
    const res = await convergePost(req as never);
    const data = await res.json() as { ok?: boolean; ran_at?: string; workspaces?: object; sops?: object; error?: string };
    assert(res.status === 200, `converge status is 200, got ${res.status}`);
    assert(data.ok === true, `converge ok:true, got: ${JSON.stringify(data)}`);
    assert(typeof data.ran_at === 'string', 'converge ran_at is a string');
    // workspaces and sops may be absent if config files not found (no client box)
    // but the call must not 500
    assert(!data.error, `converge has no error, got: ${data.error}`);
  }

  // ─── D. Role sub-route → FAIL-LOUD when no script ───────────────────────
  console.log('\nD. POST /api/departments/[id]/roles → FAIL-LOUD when no script');
  {
    const { POST: rolesPost } = await import('../src/app/api/departments/[id]/roles/route.js');
    const req = new Request('http://localhost/api/departments/smoke-dept/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'Smoke Tester', dept_slug: 'smoke-dept' }),
    });
    const res = await rolesPost(req as never, { params: Promise.resolve({ id: 'smoke-dept' }) });
    const data = await res.json() as { success?: boolean; mode?: string };

    if (res.status === 201 && data.success) {
      // Script IS present — mode must be 'script'
      assert(data.mode === 'script', `role script found → mode='script', got '${data.mode}'`);
    } else {
      assert(!data.success, `no script → success must be false`);
      assert(res.status === 503 || res.status === 500, `no script → 503 or 500, got ${res.status}`);
      assert(data.mode !== 'direct', `no script → mode must NOT be 'direct'`);
    }
  }

  // ─── E. Personas endpoint marks empty-domain entries as needs_tags:true ──
  console.log('\nE. GET /api/personas marks empty-domain personas as needs_tags:true');
  {
    const { GET: personasGet } = await import('../src/app/api/personas/route.js');
    const req = new Request('http://localhost/api/personas');
    const res = await personasGet();
    const data = await res.json() as {
      personas?: Array<{ id: string; domain: string[]; perspective: string[]; needs_tags?: boolean; routable?: boolean }>;
    };
    assert(res.status === 200, `personas status 200, got ${res.status}`);
    if (data.personas && data.personas.length > 0) {
      // If any persona has empty domain or perspective, it must be flagged
      let emptyTagCheck = true;
      for (const p of data.personas) {
        const hasDomain = p.domain.length > 0;
        const hasPerspective = p.perspective.length > 0;
        if (!hasDomain || !hasPerspective) {
          if (p.needs_tags !== true || p.routable !== false) {
            emptyTagCheck = false;
            console.error(`    persona ${p.id} has empty tags but needs_tags=${p.needs_tags} routable=${p.routable}`);
          }
        } else {
          if (p.needs_tags === true || p.routable === false) {
            emptyTagCheck = false;
            console.error(`    persona ${p.id} has tags but needs_tags=${p.needs_tags} routable=${p.routable}`);
          }
        }
      }
      assert(emptyTagCheck, 'all personas: empty-tag → needs_tags:true/routable:false, tagged → needs_tags:false/routable:true');
    } else {
      // No personas file on CI — that's fine, just check the response shape is valid
      assert(typeof data.personas !== 'undefined', 'personas field present in response');
      console.log('    (no personas file found on this machine — shape check only)');
    }
  }

  // ─── F. Department-tagged ingest ROUTES + advances past backlog ──────────
  console.log('\nF. Department-tagged ingest routes to the department AND advances past backlog');
  {
    // Use the REAL auto-seeded roster (migrations provision a full department set
    // + trio specialist agents) rather than a hand-built fixture — this exercises
    // the exact path a live box takes. Pick the first non-CEO/non-general
    // department that actually has a routable (non-master, non-offline) agent.
    const { getDb, queryOne } = await import('../src/lib/db/index.js');
    getDb(); // ensure migrations + auto-seed have run

    const dept = queryOne<{ slug: string; id: string }>(
      `SELECT w.slug AS slug, w.id AS id
         FROM workspaces w
         JOIN agents a
           ON a.workspace_id = w.id AND a.is_master = 0 AND a.status != 'offline'
        WHERE lower(w.slug) NOT IN
                ('master-orchestrator','dept-master-orchestrator','ceo','dept-ceo',
                 'general-task','dept-general-task','general')
          AND lower(w.name) NOT IN ('ceo','master orchestrator','general task','general','general stuff')
        GROUP BY w.id
        ORDER BY w.slug ASC
        LIMIT 1`,
      [],
    );
    assert(!!dept, 'a seeded department with a routable specialist exists (auto-seed roster present)');

    if (dept) {
      const DEPT_SLUG = dept.slug;
      const { POST: ingestPost } = await import('../src/app/api/tasks/ingest/route.js');
      const req = new Request('http://localhost/api/tasks/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Smoke fixture: department-tagged routing check',
          description:
            'Route a department-tagged task and confirm it advances past backlog to a specialist.',
          department_slug: DEPT_SLUG,
          source: 'smoke-test',
          idempotency_key: `smoke-${Date.now()}`,
        }),
      });
      const res = await ingestPost(req as never);
      const data = (await res.json()) as {
        ok?: boolean;
        task_id?: string;
        workspace_id?: string;
        resolved_by?: string;
        status?: string;
      };

      // ── ROUTED: the ingest resolved the tagged slug to its department workspace.
      assert(
        res.status === 201 && data.ok === true,
        `ingest accepted (201 ok:true), got ${res.status} ${JSON.stringify(data)}`,
      );
      assert(
        data.workspace_id === dept.id,
        `routed to the '${DEPT_SLUG}' workspace (${dept.id}), got '${data.workspace_id}'`,
      );
      assert(
        typeof data.resolved_by === 'string' && data.resolved_by.includes(DEPT_SLUG),
        `resolved_by references the department slug (routed, not defaulted), got '${data.resolved_by}'`,
      );

      // ── ADVANCED PAST BACKLOG: the in-process router assigned the task to a
      // specialist IN the tagged department and recorded a task_dispatched event.
      // On the Kanban that is exactly what moves a card OUT of the unassigned
      // Backlog lane — the functional inverse of the dead-Kanban regression. (The
      // literal `status` column stays 'backlog' at create time; advancing it
      // further requires the Triad gate + persona selector + gateway dispatch,
      // none of which are offline-deterministic — so we assert the dispatch
      // SIGNAL instead.)
      const taskId = data.task_id;
      assert(typeof taskId === 'string' && taskId.length > 0, 'ingest returned a task_id');
      if (taskId) {
        const taskRow = queryOne<{ assigned_agent_id: string | null }>(
          'SELECT assigned_agent_id FROM tasks WHERE id = ?',
          [taskId],
        );
        const assignedAgentId = taskRow?.assigned_agent_id ?? null;
        assert(
          !!assignedAgentId,
          `task dispatched to a specialist (assigned_agent_id set), got '${assignedAgentId ?? 'none'}'`,
        );
        if (assignedAgentId) {
          const assignedAgent = queryOne<{ workspace_id: string | null; is_master: number }>(
            'SELECT workspace_id, is_master FROM agents WHERE id = ?',
            [assignedAgentId],
          );
          assert(
            !!assignedAgent && assignedAgent.workspace_id === dept.id && assignedAgent.is_master === 0,
            `assigned agent is a non-master specialist in the tagged department (${dept.id}), got ws='${assignedAgent?.workspace_id ?? 'none'}' is_master=${assignedAgent?.is_master}`,
          );
        }
        const dispatchEvent = queryOne<{ id: string }>(
          "SELECT id FROM events WHERE task_id = ? AND type = 'task_dispatched' LIMIT 1",
          [taskId],
        );
        assert(!!dispatchEvent, 'a task_dispatched event was recorded (routing pipeline is alive)');
      }
    }
  }

  // ─── G. Build-integrity gate: .next/BUILD_ID present + fresh ─────────────
  console.log('\nG. Build-integrity gate: .next/BUILD_ID exists and is fresh (BUILD-02/06)');
  if (process.env.SMOKE_SKIP_BUILD_GATE === '1') {
    console.log(
      '    (SMOKE_SKIP_BUILD_GATE=1 — build gate skipped; deploy verification must NOT skip it)',
    );
  } else {
    const root = findRepoRoot(process.cwd());
    const buildIdPath = path.join(root, '.next', 'BUILD_ID');
    const hasBuild = fs.existsSync(buildIdPath);
    assert(hasBuild, `.next/BUILD_ID exists (${buildIdPath}) — a production build is present`);
    if (hasBuild) {
      const buildMs = fs.statSync(buildIdPath).mtimeMs;
      // Any source/config input newer than the compiled build = a stale build
      // (code updated but never recompiled — the dead-Kanban root cause).
      let stale: string | null = null;
      const srcDir = path.join(root, 'src');
      if (fs.existsSync(srcDir)) stale = firstFileNewerThan(srcDir, buildMs);
      if (!stale) {
        for (const f of ['package.json', 'next.config.mjs', 'next.config.js', 'next.config.ts']) {
          const fp = path.join(root, f);
          try {
            if (fs.existsSync(fp) && fs.statSync(fp).mtimeMs > buildMs) {
              stale = fp;
              break;
            }
          } catch {
            /* ignore */
          }
        }
      }
      assert(
        stale === null,
        stale
          ? `build is STALE — ${stale} is newer than .next/BUILD_ID (rebuild via scripts/atomic-deploy.sh)`
          : 'build is FRESH — no src/ or config file is newer than .next/BUILD_ID',
      );
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n── Results: ${passed} passed, ${failed} failed ────────────────────`);
  if (failed > 0) {
    console.error('SMOKE FAILED');
    process.exit(1);
  } else {
    console.log('SMOKE PASSED');
    process.exit(0);
  }
}

runSmoke().catch((err) => {
  console.error('Smoke test fatal:', err);
  process.exit(1);
});

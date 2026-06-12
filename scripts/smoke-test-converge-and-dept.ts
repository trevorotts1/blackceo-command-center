/**
 * Smoke test for the self-service add+wire CC changes (§4.2 requirement):
 *
 *   A. POST /api/departments with full-wire body hits /api/departments (not /api/workspaces)
 *   B. Missing host script returns FAIL-LOUD (503, no bare row, no success:true)
 *   C. POST /api/system/converge returns ok:true with workspace + sop counts
 *   D. POST /api/departments/[id]/roles with missing script returns 503 FAIL-LOUD
 *   E. Personas endpoint marks empty-domain personas as needs_tags:true, routable:false
 *
 * Run:  npx tsx scripts/smoke-test-converge-and-dept.ts
 *
 * Uses a throwaway SQLite DB (no live box required).
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ── Fixture DB setup ─────────────────────────────────────────────────────────
const tmpDb = path.join(os.tmpdir(), `converge-smoke-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.MISSION_CONTROL_DB_PATH = tmpDb;
// Disable auth so smoke can call without a real MC_API_TOKEN
delete process.env.MC_API_TOKEN;

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

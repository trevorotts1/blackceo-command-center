/**
 * QR-014 — the exported `isOpenClawResponse` identity predicate.
 *
 * DEFECT A (REVS-012 F2 / REVI-014 F2, same shape): HEA-001 added the Control
 * UI markup branch to src/lib/probes/openclaw-gateway.ts and marked the
 * function `export` "for tests" (doc comment, line 53) — but the promised
 * suite was never written. At the repaired tip, `git grep -n
 * isOpenClawResponse rr/w5-opfix-commit-20260926` returned exactly TWO lines:
 * the definition (line 55) and the single call site inside `probeUrl` (line
 * 190). `git cat-file -e` on this file's path failed rc=128. So this suite
 * realizes the artifact the export already declared.
 *
 * WHY THE TEST AND NOT UN-EXPORTING. HEA-001's false negative is what made the
 * export load-bearing: a live installed gateway answers a plain HTTP GET at `/`
 * with the Control UI shell (HTTP 200, `data-openclaw-*` attributes, the
 * "OpenClaw Control" title) and presents NEITHER a WS-port status NOR an
 * identity-bearing JSON body — so a real, running gateway read as a port
 * squatter. That is a false NEGATIVE on a live box. The regression surface is
 * exactly the string-shape matching this predicate does, and the two sibling
 * suites (tests/unit/hea-003-pgrep-tunnel-identity.test.ts,
 * tests/unit/qr008-cli-probe-path-lookup.test.ts) both pin their export the
 * same way: drive the REAL exported function.
 *
 * STANDING ADJUDICATION — PINNED, NOT RE-OPENED. A security lens raised that
 * this predicate never reads `status` on the markup branch, so
 * `isOpenClawResponse(500, <OpenClaw markup>)` returns true. That was
 * adjudicated NOT DEFECT on the record: the function answers IDENTITY ("is
 * OpenClaw the thing answering on this port"), never HEALTH. The caller
 * `probeUrl` passes the real status through (`status: res.status`, surfaced as
 * `detail.httpProbeStatus` on each probe branch) — the health signal is not
 * lost, it simply does not live in this predicate. The test below PINS that
 * adjudicated direction so a future "fix" in either direction cannot silently
 * reopen it. Do NOT "fix" status handling here.
 *
 * What this suite pins (branches of the exported function, in evaluation order):
 *   1. markup branch            — /data-openclaw-[a-z-]+/i OR /<title>\s*OpenClaw/i -> true
 *   2. WS-port status branch    — OPENCLAW_WS_PORT_STATUSES = {426, 400, 101}      -> true
 *   3. JSON identity-field loop — field in {gateway, product, service, name} whose
 *                                 string value contains "openclaw"                 -> true
 *   4. version-shape branch     — JSON `version` matching /^\d{4}\.\d+\.\d+/      -> true
 *   5. fall-through             — everything else, including JSON.parse throwing -> false
 *
 * Every fixture below is a string a real probe could meet on a real box — a
 * real Control UI shell, real gateway status bodies, and real responses from
 * ordinary HTTP servers that squat the port. No one-token strawmen.
 *
 * Run: node --import tsx --test tests/unit/openclaw-gateway-identity.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isOpenClawResponse } from '../../src/lib/probes/openclaw-gateway';

/**
 * The installed gateway's Control UI shell as `/` serves it. Copied in the
 * shape the doc comment at the top of openclaw-gateway.ts describes: the
 * `data-openclaw-*` mount attributes plus the "OpenClaw Control" title. A
 * real shell is a full HTML document; the probe only needs the strings.
 */
const CONTROL_UI_SHELL = `<!doctype html>
<html lang="en" data-openclaw-app="control-ui" data-openclaw-version="2026.5.22">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw Control</title>
  </head>
  <body>
    <div id="root" data-openclaw-root></div>
    <script type="module" src="/assets/index-4f2a1c.js"></script>
  </body>
</html>`;

/** What an ordinary HTTP server squats the port with: a full, valid page. */
const SQUATTER_HTML = `<!DOCTYPE html>
<html>
  <head><title>Welcome to nginx!</title></head>
  <body>
    <h1>Welcome to nginx!</h1>
    <p>If you see this page, the nginx web server is successfully installed and working.</p>
  </body>
</html>`;

/** A stray Node dev server on the configured port — page mentions nothing of ours. */
const SQUATTER_DEV_SERVER_HTML = `<!DOCTYPE html>
<html>
  <head><title>Vite + React + TS</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

// ── HEA-001 false negative: the Control UI shell is an identity signal ────────

test('HEA-001: the Control UI HTML shell (200) is OpenClaw, not a squatter', () => {
  // This is the false negative HEA-001 fixed. Before the markup branch, a live
  // gateway serving this shell over plain HTTP read as `offline` / port-squatter
  // because it emits neither a WS-port status nor an identity-bearing JSON body.
  assert.equal(isOpenClawResponse(200, CONTROL_UI_SHELL), true);
});

// ── WS-port status branch ────────────────────────────────────────────────────

test('WS-port statuses 426 / 400 / 101 are identity signals on their own', () => {
  // Generic HTTP servers do not emit these for a plain GET. Body is empty here
  // because the real probe's wsPortResult read returns whatever the socket
  // sends — commonly nothing on 426/101.
  assert.equal(isOpenClawResponse(426, ''), true, '426 Upgrade Required');
  assert.equal(isOpenClawResponse(400, ''), true, '400 Bad Request on the WS port');
  assert.equal(isOpenClawResponse(101, ''), true, '101 Switching Protocols');
});

// ── JSON identity-field branch ───────────────────────────────────────────────

test('JSON body with an OpenClaw identity field is OpenClaw', () => {
  // The four accepted field names are gateway / product / service / name, and
  // the value must carry "openclaw" (case-insensitive) — this is the shape a
  // real /api/status body has.
  assert.equal(
    isOpenClawResponse(200, '{"gateway":"openclaw","version":"2026.5.22","uptime":18342}'),
    true,
    'gateway field',
  );
  assert.equal(
    isOpenClawResponse(200, '{"product":"OpenClaw Gateway","status":"live"}'),
    true,
    'product field, mixed case',
  );
  assert.equal(
    isOpenClawResponse(200, '{"service":"openclaw-gateway.service","pid":4711}'),
    true,
    'service field, value is a superset',
  );
  assert.equal(
    isOpenClawResponse(200, '{"name":"OpenClaw","channels":["telegram","discord"]}'),
    true,
    'name field',
  );
});

// ── version-shape branch ─────────────────────────────────────────────────────

test('JSON body with an OpenClaw-shaped version string is OpenClaw', () => {
  // "2026.5.22" — four-digit leading segment. Sufficiently specific to be
  // identity-grade; ordinary servers do not version this way.
  assert.equal(isOpenClawResponse(200, '{"version":"2026.5.22"}'), true);
  assert.equal(
    isOpenClawResponse(200, '{"ok":true,"status":"live","version":"2026.5.22","pid":4711}'),
    true,
    'the real /health body once version is added',
  );
});

// ── THE ADJUDICATED CASE — status is NOT this predicate's business ────────────

test('ADJUDICATED: OpenClaw markup at status 500 still returns true (identity, not health)', () => {
  // DELIBERATE, and pinned so a future pass cannot silently reverse it.
  //
  // Standing adjudication on record: this function answers IDENTITY — "is
  // OpenClaw the thing answering on this port" — never HEALTH. The markup
  // branch therefore never reads `status`. The caller `probeUrl` passes the
  // real status through (`status: res.status`) and each probe branch surfaces
  // it as `detail.httpProbeStatus`, so a 500 from a live gateway is reported
  // as a live gateway returning 500 — the health signal is preserved at the
  // call site, which is the layer that owns it.
  //
  // Flipping this to `false` would hide a real gateway behind a squatter
  // verdict on any box whose Control UI is up but erroring — the exact
  // false-negative class HEA-001 fixed, just at a different status code.
  assert.equal(isOpenClawResponse(500, CONTROL_UI_SHELL), true);
});

// ── Near misses: close to identity, but not identity ─────────────────────────

test('near-miss JSON bodies are NOT OpenClaw', () => {
  // Identity field present, but its value says nothing about OpenClaw — this
  // is what an unrelated service that happens to use `name`/`service` returns.
  assert.equal(
    isOpenClawResponse(200, '{"name":"clawde-dashboard","service":"metrics","status":"ok"}'),
    false,
    'identity field names present, none carrying "openclaw"',
  );
  assert.equal(
    isOpenClawResponse(200, '{"gateway":"nginx","product":"reverse-proxy","version":"1.25.3"}'),
    false,
    'a proxy reporting on itself',
  );
  // Version present but NOT OpenClaw-shaped (leading segment is not 4 digits),
  // so it does not earn the version branch.
  assert.equal(
    isOpenClawResponse(200, '{"version":"1.4.2","build":"20260101"}'),
    false,
    'semver-ish version, not the 4-digit OpenClaw shape',
  );
  assert.equal(
    isOpenClawResponse(200, '{"version":"v2026.5.22","name":"dashboard"}'),
    false,
    'prefixed version tag fails the anchored 4-digit test',
  );
});

// ── Generic squatter controls ────────────────────────────────────────────────

test('generic squatter responses are NOT OpenClaw', () => {
  assert.equal(
    isOpenClawResponse(200, SQUATTER_HTML),
    false,
    'plain non-OpenClaw HTML at 200',
  );
  assert.equal(
    isOpenClawResponse(200, SQUATTER_DEV_SERVER_HTML),
    false,
    'stray dev server on the port',
  );
  // The bare pair the gateway's /health returns without identity fields — an
  // unrelated service answering /health with the same well-known shape.
  assert.equal(
    isOpenClawResponse(200, '{"ok":true,"status":"live"}'),
    false,
    'plain non-identity JSON',
  );
  assert.equal(
    isOpenClawResponse(200, '{"uptime":18342,"pid":4711,"hostname":"mac-mini.local"}'),
    false,
    'runtime stat JSON with no identity field',
  );
});

// ── Garbage body on a non-WS status ──────────────────────────────────────────

test('non-JSON garbage on a non-WS status falls through to false', () => {
  // JSON.parse throws -> swallowed -> fall-through false. A port squatter that
  // answers with a text error page must not read as OpenClaw.
  assert.equal(
    isOpenClawResponse(200, 'Not Found: the requested resource does not exist on this server.'),
    false,
    'text error body at 200',
  );
  assert.equal(isOpenClawResponse(403, ''), false, '403 with empty body');
  assert.equal(
    isOpenClawResponse(
      404,
      '<error><code>NoSuchKey</code><message>The specified key does not exist.</message></error>',
    ),
    false,
    'XML error body at 404',
  );
  assert.equal(isOpenClawResponse(0, ''), false, 'unreachable: status 0, no body');
});

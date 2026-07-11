// ---------------------------------------------------------------------------
// FIX-RESCUE-09 — return-leg (client-box) delivery VERIFIER + gate.
//
// PROBLEM (master plan FIX-RESCUE-09, P2): the VPS return-leg is wired LIVE but
// was NEVER verified — every `type:"vps"` entry in the receiver's return-box
// allowlist is stamped "UNTESTED 2026-06-26", and there is live SSH-timeout
// evidence. Firing a remote `docker exec` against a multi-tenant client host
// that has never been proven reachable/targeted correctly is a mistarget /
// commingling blast-radius risk (wrong container, wrong host, hung SSH).
//
// FIX (this module — pure logic + a JSON pass/fail ledger, ZERO client names):
//   1. Per-box loopback SMOKE TEST — send a no-op `openclaw agent --message
//      "ping"` down the EXACT allowlist entry, via the receiver's OWN
//      buildDeliverCommand (injected), so a PASS proves the identical SSH ->
//      docker-exec -> openclaw path a real answer would take. Record pass/fail.
//   2. GATE `type:"vps"` delivery behind per-box `verified:true`.
//   3. Unverified VPS boxes FALL BACK to Telegram-group-only delivery — never
//      SSH. (Mac-tunnel boxes are NOT gated by default; opt in with
//      RESCUE_RETURN_REQUIRE_ALL_VERIFIED=1.)
//
// WHY A SEPARATE MODULE: the receiver carries the real client return-leg
// allowlist (hostnames, containers, IPs) and must never be pulled into a public
// repo. This module is allowlist-AGNOSTIC — the receiver passes its allowlist
// and its buildDeliverCommand IN at call time — so the tracked logic + tests
// stay 100% client-name-free. The pass/fail ledger keys ARE client box aliases,
// so it lives in the gitignored runtime state dir and is NEVER committed.
//
// WIRING (in rescue-receiver.mjs) — three touch points:
//   import * as returnVerify from "./lib/rescue-return-verifier.mjs";
//
//   // (a) GATE — inside deliverToClientBox(), BEFORE spawning ssh:
//   const decision = returnVerify.isReturnDeliveryAllowed(
//     box, RETURN_BOX_ALLOWLIST[box], returnVerify.loadState());
//   if (!decision.allow) {
//     log(`RETURN gate box=${box} -> ${decision.transport} (${decision.reason}) ticket=${ticketId}`);
//     // fall back to Telegram-group-only — NEVER ssh:
//     postTelegramAlarm(
//       `[RR return fallback] box=${box} unverified return-leg; delivering in-group instead of SSH.\n${deliverText}`,
//       FIXER_GROUP_CHAT_ID, FIXER_THREAD_ID);
//     return;
//   }
//
//   // (b) SMOKE-TEST admin path — a --verify-return[=vps] CLI flag (or endpoint)
//   //     that runs the loopback tests and writes the ledger:
//   await returnVerify.runAllSmokeTests({
//     allowlist: RETURN_BOX_ALLOWLIST, buildDeliverCommand, vpsOnly: true });
//
//   // (c) export from the receiver for this module's own CLI (guard the server
//   //     start behind the main check so importing does not bind the port):
//   export { RETURN_BOX_ALLOWLIST, buildDeliverCommand };
// ---------------------------------------------------------------------------

import { spawn as _spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The no-op message the smoke test delivers. Recognizable in the target agent's
// log, harmless to receive. Override with RESCUE_RETURN_PING_MESSAGE.
export const PING_MESSAGE = process.env.RESCUE_RETURN_PING_MESSAGE || "[rr-return-smoke] ping";

// SIGKILL wall for a single smoke test (ms). A real return-leg turn can be slow,
// but a *ping* that is going to succeed answers fast; a hung SSH must not wedge
// the sweep. Override with RESCUE_RETURN_SMOKE_TIMEOUT_MS.
export const SMOKE_TIMEOUT_MS = intEnv("RESCUE_RETURN_SMOKE_TIMEOUT_MS", 120000);

// Opt-in: gate EVERY box (Mac-tunnel included), not just type:"vps". Default off
// — FIX-RESCUE-09 scopes the gate to the VPS docker-exec blast radius.
export const REQUIRE_ALL_VERIFIED = /^(1|true|yes)$/i.test(
  String(process.env.RESCUE_RETURN_REQUIRE_ALL_VERIFIED || ""));

function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return v > 0 ? v : fallback;
}

function log(msg) {
  try {
    process.stderr.write(`[rr-return-verify] ${msg}\n`);
  } catch (_) {
    /* ignore */
  }
}

// --- ledger path (override with RESCUE_RETURN_VERIFY_STATE) -----------------
// Resolved lazily so a test (or the operator) can point at a scratch file by
// setting the env var before the first load/save.
export function resolveStatePath(opts = {}) {
  return (
    opts.statePath ||
    process.env.RESCUE_RETURN_VERIFY_STATE ||
    fileURLToPath(new URL("../../state/rescue-return-verify.json", import.meta.url))
  );
}

// True for a VPS / docker-exec allowlist entry (the gated blast-radius path).
export function isVpsEntry(entry) {
  return !!(entry && entry.type === "vps");
}

// Load the pass/fail ledger. Missing/corrupt file => empty ledger (fail-safe:
// an empty ledger means "nothing verified", so VPS boxes fall back to Telegram
// rather than SSH — the SAFE default).
export function loadState(opts = {}) {
  const p = resolveStatePath(opts);
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.boxes && typeof parsed.boxes === "object"
      ? parsed
      : { version: 1, boxes: {} };
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      log(`ledger unreadable (${err.message}); treating as empty (fail-safe: VPS -> Telegram)`);
    }
    return { version: 1, boxes: {} };
  }
}

export function saveState(state, opts = {}) {
  const p = resolveStatePath(opts);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
    return true;
  } catch (err) {
    log(`ledger save failed (${err.message})`);
    return false;
  }
}

// The verification record for a box, or null if never tested.
export function getBoxVerification(box, state) {
  if (!state || !state.boxes) return null;
  return state.boxes[box] || null;
}

// ---------------------------------------------------------------------------
// THE GATE. Given a box, its allowlist entry, and the ledger, decide whether the
// receiver may SSH — or must fall back to Telegram-group-only delivery.
// Returns { allow, transport:"ssh"|"telegram-group", reason, verifiedAt }.
// ---------------------------------------------------------------------------
export function isReturnDeliveryAllowed(box, entry, state, opts = {}) {
  const requireAll = opts.requireAllVerified != null ? !!opts.requireAllVerified : REQUIRE_ALL_VERIFIED;

  if (!entry) {
    return { allow: false, transport: "telegram-group", reason: "box not in allowlist", verifiedAt: null };
  }

  const rec = getBoxVerification(box, state);
  const verified = !!(rec && rec.verified === true);
  const verifiedAt = (rec && rec.testedAt) || null;

  const gated = isVpsEntry(entry) || requireAll;

  if (!gated) {
    // Mac-tunnel path: not gated by FIX-RESCUE-09 (per-client CF Access alias,
    // single-tenant — outside the VPS docker-exec blast radius).
    return { allow: true, transport: "ssh", reason: "mac-tunnel path (not gated by FIX-RESCUE-09)", verifiedAt };
  }

  if (verified) {
    return { allow: true, transport: "ssh", reason: "return-leg verified (smoke test passed)", verifiedAt };
  }

  const why = rec
    ? `return-leg smoke test not passed (last: ${rec.verified === false ? "FAIL" : "unknown"}${rec.exitCode != null ? ` exit=${rec.exitCode}` : ""})`
    : "return-leg never verified";
  return {
    allow: false,
    transport: "telegram-group",
    reason: `${isVpsEntry(entry) ? "VPS" : "box"} unverified — FIX-RESCUE-09 blocks SSH (${why})`,
    verifiedAt,
  };
}

// ---------------------------------------------------------------------------
// SMOKE TEST. Build the delivery command for a no-op "ping" via the receiver's
// OWN builder, so the test exercises the byte-identical SSH/docker-exec path.
// Returns the command descriptor, or null if the box is not allowlisted.
// ---------------------------------------------------------------------------
export function buildSmokeTestCommand(box, entry, buildDeliverCommand, opts = {}) {
  if (typeof buildDeliverCommand !== "function") {
    throw new TypeError("buildSmokeTestCommand requires the receiver's buildDeliverCommand(box, agent, text)");
  }
  const agent = (entry && entry.agent) || "main";
  const message = opts.pingMessage || PING_MESSAGE;
  // Use the EXACT same builder the real return leg uses — same allowlist lookup,
  // same b64 encoding, same ssh/docker-exec argv. A PASS therefore proves the
  // real path, not an approximation.
  return buildDeliverCommand(box, agent, message);
}

// Run ONE smoke test. Fail-SAFE: any spawn error, non-zero exit, or timeout =>
// verified:false. Resolves (never rejects) with a result record.
//   deps: { buildDeliverCommand (required), spawnFn?, timeoutMs?, pingMessage? }
export function runSmokeTest(box, entry, deps = {}) {
  const spawnFn = deps.spawnFn || _spawn;
  const timeoutMs = deps.timeoutMs || SMOKE_TIMEOUT_MS;
  const startedAt = Date.now();
  const base = () => ({
    box,
    transport: isVpsEntry(entry) ? "vps" : "mac-tunnel",
    testedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    pingMessage: deps.pingMessage || PING_MESSAGE,
  });

  return new Promise((resolve) => {
    let cmd;
    try {
      cmd = buildSmokeTestCommand(box, entry, deps.buildDeliverCommand, { pingMessage: deps.pingMessage });
    } catch (err) {
      resolve({ ...base(), verified: false, exitCode: null, signal: null, error: `build failed: ${err.message}`, stderrTail: "" });
      return;
    }
    if (!cmd || !Array.isArray(cmd.sshArgs)) {
      resolve({ ...base(), verified: false, exitCode: null, signal: null, error: "box not allowlisted / no command", stderrTail: "" });
      return;
    }

    let child;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      resolve(r);
    };

    let child_ok = true;
    const wall = setTimeout(() => {
      // Record the TIMEOUT reason first so the `close` that kill() triggers is
      // ignored by the settled-guard and cannot masquerade as a plain exit.
      done({ ...base(), verified: false, exitCode: null, signal: "SIGKILL", error: `timeout after ${timeoutMs}ms`, stderrTail: errBuf.slice(-400) });
      try { if (child) child.kill("SIGKILL"); } catch (_) { /* ignore */ }
    }, timeoutMs);

    let outBuf = "";
    let errBuf = "";
    try {
      child = spawnFn("ssh", cmd.sshArgs, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      child_ok = false;
      done({ ...base(), verified: false, exitCode: null, signal: null, error: `spawn failed: ${err.message}`, stderrTail: "" });
    }
    if (!child_ok) return;

    if (child.stdout) child.stdout.on("data", (b) => { outBuf += b.toString(); });
    if (child.stderr) child.stderr.on("data", (b) => { errBuf += b.toString(); });
    child.on("error", (err) => {
      done({ ...base(), verified: false, exitCode: null, signal: null, error: `child error: ${err.message}`, stderrTail: errBuf.slice(-400) });
    });
    child.on("close", (code, signal) => {
      done({
        ...base(),
        verified: code === 0,
        exitCode: code,
        signal: signal || null,
        error: code === 0 ? null : `exit code ${code}${signal ? ` signal ${signal}` : ""}`,
        stderrTail: errBuf.slice(-400),
        stdoutTail: outBuf.slice(-200),
      });
    });
  });
}

// Persist ONE smoke-test result into the ledger. Returns the stored record.
export function recordSmokeResult(box, result, opts = {}) {
  const state = opts.state || loadState(opts);
  if (!state.boxes) state.boxes = {};
  const prev = state.boxes[box] || {};
  const rec = {
    verified: !!result.verified,
    transport: result.transport,
    exitCode: result.exitCode != null ? result.exitCode : null,
    signal: result.signal || null,
    testedAt: result.testedAt || new Date().toISOString(),
    durationMs: result.durationMs != null ? result.durationMs : null,
    error: result.error || null,
    stderrTail: result.stderrTail || "",
    // Preserve the first-ever verification timestamp for auditing.
    firstVerifiedAt: result.verified ? (prev.firstVerifiedAt || result.testedAt || new Date().toISOString()) : (prev.firstVerifiedAt || null),
    lastPassAt: result.verified ? (result.testedAt || new Date().toISOString()) : (prev.lastPassAt || null),
    testCount: (prev.testCount || 0) + 1,
  };
  state.boxes[box] = rec;
  if (opts.noSave !== true) saveState(state, opts);
  return rec;
}

// Run + persist one box. Convenience wrapper.
export async function runAndRecord(box, entry, deps = {}, opts = {}) {
  const result = await runSmokeTest(box, entry, deps);
  const rec = recordSmokeResult(box, result, opts);
  log(`smoke box=${box} verified=${rec.verified}${rec.exitCode != null ? ` exit=${rec.exitCode}` : ""}${rec.error ? ` (${rec.error})` : ""}`);
  return { box, result, record: rec };
}

// Manual operator override (e.g. verified out-of-band). meta is merged for audit.
export function setVerified(box, verified, opts = {}, meta = {}) {
  const state = opts.state || loadState(opts);
  if (!state.boxes) state.boxes = {};
  const prev = state.boxes[box] || {};
  const now = new Date().toISOString();
  state.boxes[box] = {
    ...prev,
    verified: !!verified,
    testedAt: now,
    error: verified ? null : (meta.reason || prev.error || "manually marked unverified"),
    manual: true,
    manualBy: meta.actor || "operator",
    manualReason: meta.reason || null,
    firstVerifiedAt: verified ? (prev.firstVerifiedAt || now) : (prev.firstVerifiedAt || null),
    lastPassAt: verified ? now : (prev.lastPassAt || null),
    testCount: prev.testCount || 0,
  };
  if (opts.noSave !== true) saveState(state, opts);
  return state.boxes[box];
}

// ---------------------------------------------------------------------------
// Sweep every allowlist box (serially, so a fleet of hung SSH targets cannot be
// launched in parallel). vpsOnly:true (default) tests only the gated blast-radius
// entries. Writes the ledger once at the end. Returns a summary + per-box rows.
// ---------------------------------------------------------------------------
export async function runAllSmokeTests(params = {}) {
  const { allowlist, buildDeliverCommand } = params;
  if (!allowlist || typeof allowlist !== "object") {
    throw new TypeError("runAllSmokeTests requires { allowlist }");
  }
  if (typeof buildDeliverCommand !== "function") {
    throw new TypeError("runAllSmokeTests requires { buildDeliverCommand }");
  }
  const vpsOnly = params.vpsOnly !== false; // default true
  const opts = params.opts || {};
  const deps = {
    buildDeliverCommand,
    spawnFn: params.spawnFn,
    timeoutMs: params.timeoutMs,
    pingMessage: params.pingMessage,
  };

  const state = loadState(opts);
  const rows = [];
  let pass = 0;
  let fail = 0;
  for (const [box, entry] of Object.entries(allowlist)) {
    if (vpsOnly && !isVpsEntry(entry)) continue;
    if (params.only && !params.only.includes(box)) continue;
    // eslint-disable-next-line no-await-in-loop -- intentional serial sweep
    const result = await runSmokeTest(box, entry, deps);
    const rec = recordSmokeResult(box, result, { ...opts, state, noSave: true });
    if (rec.verified) pass++; else fail++;
    rows.push({ box, verified: rec.verified, exitCode: rec.exitCode, error: rec.error });
    log(`smoke box=${box} verified=${rec.verified}${rec.exitCode != null ? ` exit=${rec.exitCode}` : ""}`);
  }
  saveState(state, opts);
  return { total: rows.length, pass, fail, vpsOnly, rows };
}

// Operator status table (safe to print on the operator console — client aliases
// are operator-visible; this text is never delivered to a client).
export function formatStatusTable(state, allowlist) {
  const boxes = (state && state.boxes) || {};
  const keys = allowlist ? Object.keys(allowlist) : Object.keys(boxes);
  const lines = ["box                                    verified  transport      last-test"];
  for (const box of keys) {
    const entry = allowlist ? allowlist[box] : null;
    const rec = boxes[box];
    const transport = entry ? (isVpsEntry(entry) ? "vps" : "mac-tunnel") : (rec && rec.transport) || "?";
    const v = rec ? (rec.verified ? "PASS" : "FAIL") : "—";
    const when = (rec && rec.testedAt) || "never";
    lines.push(`${box.padEnd(38)} ${v.padEnd(8)} ${String(transport).padEnd(13)} ${when}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI. Runs against the receiver's LIVE allowlist + builder, imported from the
// module named by RESCUE_RECEIVER_MODULE (which must `export { RETURN_BOX_ALLOWLIST,
// buildDeliverCommand }` and guard its server start behind the main check).
//   node rescue-return-verifier.mjs --run [--all]     run smoke tests + write ledger
//   node rescue-return-verifier.mjs --status          print the ledger table
//   node rescue-return-verifier.mjs --mark <box> ok|no  manual override
// ---------------------------------------------------------------------------
async function main(argv) {
  const args = argv.slice(2);
  const has = (f) => args.includes(f);

  if (has("--status")) {
    const state = loadState();
    let allowlist = null;
    try { allowlist = (await loadReceiver()).RETURN_BOX_ALLOWLIST; } catch (_) { /* status works without it */ }
    process.stdout.write(formatStatusTable(state, allowlist) + "\n");
    return 0;
  }

  if (has("--mark")) {
    const box = args[args.indexOf("--mark") + 1];
    const val = args[args.indexOf("--mark") + 2];
    if (!box || !val) { process.stderr.write("usage: --mark <box> ok|no\n"); return 2; }
    const rec = setVerified(box, /^(ok|yes|true|1|pass)$/i.test(val), {}, { actor: "operator-cli", reason: "manual --mark" });
    process.stdout.write(`marked ${box}: verified=${rec.verified}\n`);
    return 0;
  }

  if (has("--run")) {
    const { RETURN_BOX_ALLOWLIST, buildDeliverCommand } = await loadReceiver();
    const summary = await runAllSmokeTests({
      allowlist: RETURN_BOX_ALLOWLIST,
      buildDeliverCommand,
      vpsOnly: !has("--all"),
    });
    process.stdout.write(`return-leg smoke sweep: ${summary.pass}/${summary.total} passed (fail=${summary.fail}, vpsOnly=${summary.vpsOnly})\n`);
    process.stdout.write(formatStatusTable(loadState(), RETURN_BOX_ALLOWLIST) + "\n");
    return summary.fail === 0 ? 0 : 1;
  }

  process.stderr.write("usage: rescue-return-verifier.mjs [--run [--all] | --status | --mark <box> ok|no]\n");
  return 2;
}

async function loadReceiver() {
  const mod = process.env.RESCUE_RECEIVER_MODULE;
  if (!mod) {
    throw new Error("set RESCUE_RECEIVER_MODULE to the receiver module path (must export RETURN_BOX_ALLOWLIST + buildDeliverCommand)");
  }
  const m = await import(mod);
  if (!m.RETURN_BOX_ALLOWLIST || typeof m.buildDeliverCommand !== "function") {
    throw new Error("receiver module must export { RETURN_BOX_ALLOWLIST, buildDeliverCommand }");
  }
  return m;
}

// Run the CLI only when executed directly (never on import — importing this
// module must have no side effects so the receiver and tests can use it freely).
if (fileURLToPath(import.meta.url) === (process.argv[1] || "")) {
  main(process.argv).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`[rr-return-verify] CLI error: ${err.message}\n`);
    process.exit(1);
  });
}

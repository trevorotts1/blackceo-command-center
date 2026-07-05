// Tests for the return-leg verifier + gate (FIX-RESCUE-09).
// Run: node --test fleet-heartbeat/scripts/lib/rescue-return-verifier.test.mjs
//
// No network, no real SSH: buildDeliverCommand and spawn are BOTH injected, and
// the ledger is written to a throwaway temp file. Client-name-free (fake boxes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import {
  isVpsEntry,
  isReturnDeliveryAllowed,
  buildSmokeTestCommand,
  runSmokeTest,
  recordSmokeResult,
  runAndRecord,
  runAllSmokeTests,
  setVerified,
  loadState,
  saveState,
  getBoxVerification,
  formatStatusTable,
  PING_MESSAGE,
} from "./rescue-return-verifier.mjs";

// --- fixtures --------------------------------------------------------------

const VPS_ENTRY = { type: "vps", sshHost: "root@10.0.0.1", container: "oc-fake-1", agent: "main" };
const MAC_ENTRY = { sshAlias: "fake-mac-box", agent: "main", shell: "zsh" };
const ALLOWLIST = {
  "fake-mac-a": MAC_ENTRY,
  "fake-vps-a": VPS_ENTRY,
  "fake-vps-b": { type: "vps", sshHost: "root@10.0.0.2", container: "oc-fake-2", agent: "main" },
};

// Mirrors the receiver's builder contract: returns { sshArgs } or null.
function fakeBuildDeliverCommand(box, agent, text) {
  const entry = ALLOWLIST[box];
  if (!entry) return null;
  const b64 = Buffer.from(text, "utf8").toString("base64");
  if (entry.type === "vps") {
    return { type: "vps", sshHost: entry.sshHost, container: entry.container, agent, sshArgs: ["-T", entry.sshHost, `docker...${b64}`] };
  }
  return { sshAlias: entry.sshAlias, shell: entry.shell, agent, sshArgs: ["-T", entry.sshAlias, `zsh -lc ...${b64}`] };
}

// A spawn stub that fires `close` with the given exit code on the next tick.
function makeSpawn({ code = 0, signal = null, stderr = "", stdout = "", throwOn = null } = {}) {
  const calls = [];
  const fn = (bin, args) => {
    calls.push({ bin, args });
    if (throwOn) { const e = new Error(throwOn); throw e; }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", code, signal);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

// A spawn stub that never fires close (to exercise the timeout wall).
function makeHangingSpawn() {
  let killed = false;
  const fn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; child.emit("close", null, "SIGKILL"); };
    return child;
  };
  fn.wasKilled = () => killed;
  return fn;
}

function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), "rr-return-verify-"));
  return { statePath: join(dir, "state.json"), dir };
}

// --- isVpsEntry ------------------------------------------------------------

test("isVpsEntry distinguishes vps from mac entries", () => {
  assert.equal(isVpsEntry(VPS_ENTRY), true);
  assert.equal(isVpsEntry(MAC_ENTRY), false);
  assert.equal(isVpsEntry(null), false);
});

// --- the GATE --------------------------------------------------------------

test("GATE: unverified VPS box is blocked and falls back to Telegram group, never SSH", () => {
  const d = isReturnDeliveryAllowed("fake-vps-a", VPS_ENTRY, { boxes: {} });
  assert.equal(d.allow, false);
  assert.equal(d.transport, "telegram-group");
  assert.match(d.reason, /FIX-RESCUE-09 blocks SSH/);
});

test("GATE: VERIFIED VPS box is allowed over SSH", () => {
  const state = { boxes: { "fake-vps-a": { verified: true, testedAt: "2026-07-05T00:00:00Z" } } };
  const d = isReturnDeliveryAllowed("fake-vps-a", VPS_ENTRY, state);
  assert.equal(d.allow, true);
  assert.equal(d.transport, "ssh");
  assert.equal(d.verifiedAt, "2026-07-05T00:00:00Z");
});

test("GATE: Mac-tunnel box is NOT gated by default (allowed even when unverified)", () => {
  const d = isReturnDeliveryAllowed("fake-mac-a", MAC_ENTRY, { boxes: {} });
  assert.equal(d.allow, true);
  assert.equal(d.transport, "ssh");
  assert.match(d.reason, /mac-tunnel/);
});

test("GATE: requireAllVerified opt-in ALSO gates an unverified Mac box", () => {
  const d = isReturnDeliveryAllowed("fake-mac-a", MAC_ENTRY, { boxes: {} }, { requireAllVerified: true });
  assert.equal(d.allow, false);
  assert.equal(d.transport, "telegram-group");
});

test("GATE: a failed prior smoke test keeps a VPS box blocked", () => {
  const state = { boxes: { "fake-vps-a": { verified: false, exitCode: 255, testedAt: "x" } } };
  const d = isReturnDeliveryAllowed("fake-vps-a", VPS_ENTRY, state);
  assert.equal(d.allow, false);
  assert.equal(d.transport, "telegram-group");
  assert.match(d.reason, /exit=255|FAIL/);
});

test("GATE: unknown box (no allowlist entry) is blocked", () => {
  const d = isReturnDeliveryAllowed("nope", null, { boxes: {} });
  assert.equal(d.allow, false);
  assert.equal(d.transport, "telegram-group");
});

// --- buildSmokeTestCommand -------------------------------------------------

test("buildSmokeTestCommand delivers the no-op ping via the injected builder", () => {
  const cmd = buildSmokeTestCommand("fake-vps-a", VPS_ENTRY, fakeBuildDeliverCommand);
  assert.ok(cmd);
  assert.equal(cmd.type, "vps");
  // The command carries the base64 of the ping message (proves it used the ping).
  const expectB64 = Buffer.from(PING_MESSAGE, "utf8").toString("base64");
  assert.ok(cmd.sshArgs.some((a) => String(a).includes(expectB64)));
});

test("buildSmokeTestCommand returns null for a non-allowlisted box", () => {
  const cmd = buildSmokeTestCommand("ghost", undefined, fakeBuildDeliverCommand);
  assert.equal(cmd, null);
});

test("buildSmokeTestCommand throws if no builder is injected", () => {
  assert.throws(() => buildSmokeTestCommand("fake-vps-a", VPS_ENTRY, null), /buildDeliverCommand/);
});

// --- runSmokeTest ----------------------------------------------------------

test("runSmokeTest: exit 0 => verified true", async () => {
  const r = await runSmokeTest("fake-vps-a", VPS_ENTRY, {
    buildDeliverCommand: fakeBuildDeliverCommand,
    spawnFn: makeSpawn({ code: 0 }),
  });
  assert.equal(r.verified, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.transport, "vps");
});

test("runSmokeTest: non-zero exit => verified false with stderr tail", async () => {
  const r = await runSmokeTest("fake-vps-a", VPS_ENTRY, {
    buildDeliverCommand: fakeBuildDeliverCommand,
    spawnFn: makeSpawn({ code: 255, stderr: "ssh: connect timed out" }),
  });
  assert.equal(r.verified, false);
  assert.equal(r.exitCode, 255);
  assert.match(r.stderrTail, /connect timed out/);
});

test("runSmokeTest: spawn throw => verified false (fail-safe)", async () => {
  const r = await runSmokeTest("fake-vps-a", VPS_ENTRY, {
    buildDeliverCommand: fakeBuildDeliverCommand,
    spawnFn: makeSpawn({ throwOn: "ENOENT ssh" }),
  });
  assert.equal(r.verified, false);
  assert.match(r.error, /spawn failed/);
});

test("runSmokeTest: non-allowlisted box => verified false, no spawn", async () => {
  const spawnFn = makeSpawn({ code: 0 });
  const r = await runSmokeTest("ghost", undefined, { buildDeliverCommand: fakeBuildDeliverCommand, spawnFn });
  assert.equal(r.verified, false);
  assert.equal(spawnFn.calls.length, 0);
});

test("runSmokeTest: hanging child is SIGKILLed at the wall => verified false", async () => {
  const spawnFn = makeHangingSpawn();
  const r = await runSmokeTest("fake-vps-a", VPS_ENTRY, {
    buildDeliverCommand: fakeBuildDeliverCommand,
    spawnFn,
    timeoutMs: 20,
  });
  assert.equal(r.verified, false);
  assert.match(r.error, /timeout/);
  assert.equal(spawnFn.wasKilled(), true);
});

// --- ledger persistence ----------------------------------------------------

test("recordSmokeResult persists, increments testCount, stamps firstVerifiedAt on pass", () => {
  const { statePath, dir } = tmpState();
  try {
    const r1 = recordSmokeResult("fake-vps-a", { verified: true, transport: "vps", exitCode: 0, testedAt: "2026-07-05T01:00:00Z" }, { statePath });
    assert.equal(r1.verified, true);
    assert.equal(r1.testCount, 1);
    assert.equal(r1.firstVerifiedAt, "2026-07-05T01:00:00Z");

    const r2 = recordSmokeResult("fake-vps-a", { verified: false, transport: "vps", exitCode: 1, testedAt: "2026-07-05T02:00:00Z" }, { statePath });
    assert.equal(r2.verified, false);
    assert.equal(r2.testCount, 2);
    // firstVerifiedAt / lastPassAt preserved from the earlier pass.
    assert.equal(r2.firstVerifiedAt, "2026-07-05T01:00:00Z");
    assert.equal(r2.lastPassAt, "2026-07-05T01:00:00Z");

    // survives a reload
    const state = loadState({ statePath });
    assert.equal(getBoxVerification("fake-vps-a", state).testCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadState is fail-safe on a missing file (empty ledger => VPS falls back)", () => {
  const state = loadState({ statePath: join(tmpdir(), "does-not-exist-" + Date.now() + ".json") });
  assert.deepEqual(state.boxes, {});
  // and the gate treats empty ledger as unverified
  const d = isReturnDeliveryAllowed("fake-vps-a", VPS_ENTRY, state);
  assert.equal(d.allow, false);
});

test("setVerified writes a manual override", () => {
  const { statePath, dir } = tmpState();
  try {
    const rec = setVerified("fake-vps-b", true, { statePath }, { actor: "operator", reason: "proven out-of-band" });
    assert.equal(rec.verified, true);
    assert.equal(rec.manual, true);
    const d = isReturnDeliveryAllowed("fake-vps-b", VPS_ENTRY, loadState({ statePath }));
    assert.equal(d.allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- runAndRecord + runAllSmokeTests --------------------------------------

test("runAndRecord runs one box and writes the ledger", async () => {
  const { statePath, dir } = tmpState();
  try {
    const out = await runAndRecord("fake-vps-a", VPS_ENTRY, {
      buildDeliverCommand: fakeBuildDeliverCommand,
      spawnFn: makeSpawn({ code: 0 }),
    }, { statePath });
    assert.equal(out.record.verified, true);
    assert.ok(existsSync(statePath));
    assert.equal(getBoxVerification("fake-vps-a", loadState({ statePath })).verified, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAllSmokeTests vpsOnly (default) skips Mac boxes and counts pass/fail", async () => {
  const { statePath, dir } = tmpState();
  try {
    const summary = await runAllSmokeTests({
      allowlist: ALLOWLIST,
      buildDeliverCommand: fakeBuildDeliverCommand,
      spawnFn: makeSpawn({ code: 0 }),
      opts: { statePath },
    });
    // only the 2 VPS boxes, not the Mac one
    assert.equal(summary.total, 2);
    assert.equal(summary.pass, 2);
    assert.equal(summary.vpsOnly, true);
    const state = loadState({ statePath });
    assert.ok(getBoxVerification("fake-vps-a", state));
    assert.ok(getBoxVerification("fake-vps-b", state));
    assert.equal(getBoxVerification("fake-mac-a", state), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAllSmokeTests --all includes Mac boxes", async () => {
  const { statePath, dir } = tmpState();
  try {
    const summary = await runAllSmokeTests({
      allowlist: ALLOWLIST,
      buildDeliverCommand: fakeBuildDeliverCommand,
      spawnFn: makeSpawn({ code: 0 }),
      vpsOnly: false,
      opts: { statePath },
    });
    assert.equal(summary.total, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAllSmokeTests records failures too (a failing sweep => fail count)", async () => {
  const { statePath, dir } = tmpState();
  try {
    const summary = await runAllSmokeTests({
      allowlist: ALLOWLIST,
      buildDeliverCommand: fakeBuildDeliverCommand,
      spawnFn: makeSpawn({ code: 1, stderr: "boom" }),
      opts: { statePath },
    });
    assert.equal(summary.fail, 2);
    assert.equal(summary.pass, 0);
    // and those boxes remain BLOCKED at the gate
    const d = isReturnDeliveryAllowed("fake-vps-a", VPS_ENTRY, loadState({ statePath }));
    assert.equal(d.allow, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAllSmokeTests throws without a builder", async () => {
  await assert.rejects(
    runAllSmokeTests({ allowlist: ALLOWLIST }),
    /buildDeliverCommand/,
  );
});

// --- formatStatusTable -----------------------------------------------------

test("formatStatusTable renders PASS/FAIL/— rows", () => {
  const state = { boxes: { "fake-vps-a": { verified: true, transport: "vps", testedAt: "t" } } };
  const txt = formatStatusTable(state, ALLOWLIST);
  assert.match(txt, /fake-vps-a/);
  assert.match(txt, /PASS/);
  assert.match(txt, /fake-vps-b/); // present in allowlist, never tested => —
});

// --- ledger round-trips cleanly -------------------------------------------

test("saveState + loadState round-trip", () => {
  const { statePath, dir } = tmpState();
  try {
    saveState({ version: 1, boxes: { x: { verified: true } } }, { statePath });
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(raw.boxes.x.verified, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

#!/usr/bin/env node
// Offline unit tests for the rescue-receiver fixes (no port bind, no SSH, no
// tokens). Run: node tests/test-rescue-receiver.mjs
//   FIX-RESCUE-05  classifyTier medium tier + per-tier timeout ladder
//   FIX-RESCUE-09  isBoxVerified return-leg verification gate
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

process.env.RESCUE_RECEIVER_NO_LISTEN = "1";
const tmp = mkdtempSync(path.join(os.tmpdir(), "rr-test-"));
process.env.RESCUE_RETURN_VERIFIED_STORE = path.join(tmp, "return-box-verified.json");

const mod = await import("../rescue-receiver.mjs");
const { classifyTier, isBoxVerified, RETURN_BOX_ALLOWLIST } = mod;

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   - ${name}`); }
  else { console.error(`  FAIL - ${name}`); failures++; }
}

console.log("FIX-RESCUE-05: classifyTier medium tier + timeout ladder");
const coach = classifyTier("Kofi's agent keeps giving weird answers, how do I coach it?");
check("coach/how-to -> medium tier", coach.tier === "medium");
check("medium uses deepseek-v4-flash:cloud", coach.model === "ollama/deepseek-v4-flash:cloud");
check("medium thinking low", coach.thinking === "low");
check("medium timeout 240", coach.timeoutSecs === 240);

const plain = classifyTier("what is the best way to add a contact");
check("plain how-to -> medium", plain.tier === "medium");

const destructive = classifyTier("please rm -rf the volume and rotate the api key");
check("destructive -> hard", destructive.tier === "hard");
check("hard model null (agent primary)", destructive.model === null);
check("hard timeout 540", destructive.timeoutSecs === 540);

const structured = classifyTier("the container exited and won't come back");
check("known class -> structured", structured.tier === "structured");
check("structured timeout 180", structured.timeoutSecs === 180);

const light = classifyTier("[routing test] ping");
check("routing test -> light", light.tier === "light");
check("light timeout 120", light.timeoutSecs === 120);

const severe = classifyTier("production down across the whole fleet, urgent");
check("severe/fleet-scale -> hard", severe.tier === "hard");

// Timeout-ladder invariant: for EVERY tier, agent wall (t+30) < queue cap (t+60).
for (const msg of ["how do i", "[routing test]", "container exited", "rm -rf", "whole fleet down urgent"]) {
  const o = classifyTier(msg);
  const wall = o.timeoutSecs + 30;
  const cap = o.timeoutSecs + 60;
  check(`ladder invariant wall<cap for tier=${o.tier}`, wall < cap);
}

console.log("FIX-RESCUE-09: return-leg verification gate");
check("Mac-tunnel box verified (proven path)", isBoxVerified("rescue-kofi-bryant") === true);
check("unverified VPS box NOT verified", isBoxVerified("vps-corey") === false);
check("unknown box NOT verified", isBoxVerified("nope-not-a-box") === false);
check("every VPS entry defaults verified:false", Object.entries(RETURN_BOX_ALLOWLIST)
  .filter(([, v]) => v.type === "vps").every(([, v]) => v.verified === false));

// Sidecar store flips a VPS box to verified (what --smoke-test writes on pass).
writeFileSync(process.env.RESCUE_RETURN_VERIFIED_STORE,
  JSON.stringify({ "vps-corey": { verified: true, ts: "2026-07-05T00:00:00Z" } }) + "\n");
check("VPS box verified once sidecar records a pass", isBoxVerified("vps-corey") === true);

rmSync(tmp, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} test(s) FAILED`); process.exit(1); }
console.log("\nAll rescue-receiver tests passed.");

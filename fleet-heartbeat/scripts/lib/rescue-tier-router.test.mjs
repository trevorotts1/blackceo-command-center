// Tests for the rescue tier router (FIX-RESCUE-05).
// Run: node --test fleet-heartbeat/scripts/lib/rescue-tier-router.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTier,
  deriveQueueTimeout,
  agentWallFor,
  AGENT_TIMEOUT_LIGHT,
  AGENT_TIMEOUT_STRUCTURED,
  AGENT_TIMEOUT_MEDIUM,
  AGENT_TIMEOUT_HARD,
  QUEUE_JOB_TIMEOUT,
} from "./rescue-tier-router.mjs";

test("common coach/default ticket routes to MEDIUM (not HARD)", () => {
  const r = classifyTier("The coach-client-agent for the box is not nudging onboarding, can you push it");
  assert.equal(r.tier, "medium");
  assert.equal(r.model, "ollama/deepseek-v4-flash:cloud");
  assert.equal(r.thinking, "low");
  assert.equal(r.agentTimeout, AGENT_TIMEOUT_MEDIUM);
});

test("how-to question routes to MEDIUM", () => {
  const r = classifyTier("how do i restart the gateway on my box");
  assert.equal(r.tier, "medium");
});

test("destructive/credential keyword forces HARD (agent primary)", () => {
  const r = classifyTier("please rotate the api key and rm -rf the volume");
  assert.equal(r.tier, "hard");
  assert.equal(r.model, null);
  assert.equal(r.thinking, "high");
  assert.equal(r.agentTimeout, AGENT_TIMEOUT_HARD);
});

test("remediate.sh failure class routes to STRUCTURED", () => {
  const r = classifyTier("the container exited with code 1 overnight");
  assert.equal(r.tier, "structured");
  assert.equal(r.agentTimeout, AGENT_TIMEOUT_STRUCTURED);
});

test("routing-test / synthetic routes to LIGHT", () => {
  const r = classifyTier("[routing test] please ack");
  assert.equal(r.tier, "light");
  assert.equal(r.agentTimeout, AGENT_TIMEOUT_LIGHT);
});

test("per-tier agent walls are ordered light <= structured <= medium < hard", () => {
  assert.ok(AGENT_TIMEOUT_LIGHT <= AGENT_TIMEOUT_STRUCTURED);
  assert.ok(AGENT_TIMEOUT_STRUCTURED <= AGENT_TIMEOUT_MEDIUM);
  assert.ok(AGENT_TIMEOUT_MEDIUM < AGENT_TIMEOUT_HARD);
});

test("INVARIANT: non-fix queue cap sits strictly above the tier's agent wall", () => {
  for (const msg of [
    "coach the agent please", // medium
    "[routing test] ack", // light
    "container exited", // structured
    "rotate credential now", // hard
  ]) {
    const opts = classifyTier(msg);
    const wall = agentWallFor(opts);
    const cap = deriveQueueTimeout(opts, { mode: "coach-client-agent" });
    assert.ok(cap > wall, `queue cap ${cap} must exceed agent wall ${wall} for "${msg}"`);
  }
});

test("medium tier yields the spec's 240/300 wall/queue pairing", () => {
  const opts = classifyTier("coach the client agent"); // medium, agentTimeout 210
  assert.equal(agentWallFor(opts), 240); // 210 + 30 grace
  assert.equal(deriveQueueTimeout(opts, { mode: "coach-client-agent" }), 300); // 240 + 60 margin
});

test("fix-it-ourselves preserves the long flat queue floor", () => {
  const opts = classifyTier("container exited"); // structured, short wall
  const cap = deriveQueueTimeout(opts, { mode: "fix-it-ourselves" });
  assert.ok(cap >= QUEUE_JOB_TIMEOUT, `fix-it queue cap ${cap} must not drop below floor ${QUEUE_JOB_TIMEOUT}`);
});

test("deriveQueueTimeout accepts a bare mode string too", () => {
  const opts = classifyTier("coach the client agent");
  assert.equal(deriveQueueTimeout(opts, "coach-client-agent"), 300);
});

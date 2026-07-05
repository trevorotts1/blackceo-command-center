# FIX-RESCUE-05 — real medium tier + per-tier walls + queue-cap-above-wall

**Priority:** P2 · **Master plan:** `MASTER-fix-plan-2026-07-05.md` line 168

## Problem
Default routing sent the MOST COMMON tickets (`coach-client-agent` / how-to) to the
slowest/most expensive model: `classifyTier` defaulted `tier:"hard"` →
`kimi-k2.6:cloud@high`, which blew both the ~570s agent wall and the 600s queue cap
and paged a human. Live evidence: a ticket was abandoned at **602.2s**.

## Fix
1. **A real MEDIUM tier** — coach/how-to → `ollama/deepseek-v4-flash:cloud@low`.
   The classifier default flips from `hard` to `medium`; only the
   destructive/credential guardrail still forces `hard` (agent-primary kimi).
2. **Per-tier agent walls** (`--timeout`): light 180s, structured 200s, medium 210s;
   hard keeps 540s. All env-overridable.
3. **Queue cap strictly > agent wall** — the per-job serial-queue cap is derived as
   `agentWall + QUEUE_MARGIN` (agentWall = `agentTimeout + 30`), so the agent's own
   graceful timeout fires FIRST instead of the brutal queue hard-cap. Medium yields
   the spec's **240/300** wall/queue pairing. `fix-it-ourselves` jobs keep the flat
   `QUEUE_JOB_TIMEOUT` floor so a legit long structured remediation is not abandoned.

## Where the logic lives
All routing/timeout logic is in the client-data-free module
**`lib/rescue-tier-router.mjs`** (unit-tested by `lib/rescue-tier-router.test.mjs`,
`node --test`). It is a standalone module precisely so it can live in the public
repo and be tested WITHOUT importing `rescue-receiver.mjs`, which carries the
client return-leg allowlist (names, IPs, containers) and must never be committed here.

## Receiver wiring (apply to the live, un-versioned `rescue-receiver.mjs`)
Replace the receiver's inline `classifyTier`, the flat `AGENT_TIMEOUT` usage in
`runAgent`, and the flat `QUEUE_JOB_TIMEOUT` in the queue with imports from the module:

```js
import {
  classifyTier,
  deriveQueueTimeout,
  AGENT_TIMEOUT,        // back-compat / hard-tier default
} from "./lib/rescue-tier-router.mjs";
```

- **`runAgent(message, opts)`** — use the per-tier wall:
  ```js
  const agentTimeout = parseInt(opts.agentTimeout, 10) > 0 ? parseInt(opts.agentTimeout, 10) : AGENT_TIMEOUT;
  // ... "--timeout", String(agentTimeout) ...
  // SIGKILL wall: setTimeout(..., (agentTimeout + 30) * 1000)
  ```
- **Timeout page** in `runAgentAndReport` — compute `wallSecs` from `agentOpts.agentTimeout`
  (fallback `AGENT_TIMEOUT`), not the global.
- **Async enqueue site** — derive the per-job cap and pass it in the queue meta:
  ```js
  const queueTimeout = deriveQueueTimeout(agentOpts, fixMode);
  enqueueFixJob(() => runAgentAndReport(...), { ticketId, extras: queueExtras, queueTimeout });
  ```
- **`_drainQueue` / `handleQueueTimeout`** — use `meta.queueTimeout` (fallback
  `QUEUE_JOB_TIMEOUT`) for the guard timer and all log/alarm/answer text.

`classifyFixMode` is unchanged (it picks the ACTION, independent of the model tier).

## Verification
`node --test fleet-heartbeat/scripts/lib/rescue-tier-router.test.mjs` — 10/10 pass:
common coach→medium, how-to→medium, destructive→hard, container→structured,
routing-test→light, wall ordering, queue-cap-above-wall invariant across all tiers,
the 240/300 medium pairing, and the fix-it-ourselves long-floor preservation.

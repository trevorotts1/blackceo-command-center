# FIX-RESCUE-09 — Return-Leg Delivery Verification + Gate

Gates the **VPS / docker-exec return leg** behind a per-box loopback smoke test.

## Problem (master plan FIX-RESCUE-09, P2)

The return leg — the path the receiver uses to SSH into a client box and run
`openclaw agent` to deliver a rescue answer — is wired **LIVE** but was **never
verified**. Every `type:"vps"` entry in the receiver's return-box allowlist is
stamped `UNTESTED 2026-06-26`, and there is live SSH-timeout evidence. Firing a
remote `docker exec` at a **multi-tenant** client host that has never been proven
reachable/correctly-targeted is a **mistarget / commingling blast-radius** risk:
wrong container, wrong host, or a hung SSH that wedges the fixer.

## Fix

1. **Per-box loopback smoke test** — deliver a no-op `openclaw agent --message
   "ping"` down the **exact** allowlist entry, using the receiver's **own**
   `buildDeliverCommand`, so a PASS proves the byte-identical
   `ssh → docker exec → openclaw` path a real answer would take. Record pass/fail.
2. **Gate `type:"vps"` delivery behind per-box `verified:true`.**
3. Unverified VPS boxes **fall back to Telegram-group-only** delivery — **never
   SSH**. Mac-tunnel boxes (single-tenant, per-client CF Access alias) are **not**
   gated by default; opt in fleet-wide with `RESCUE_RETURN_REQUIRE_ALL_VERIFIED=1`.

## Components

| File | Role |
|---|---|
| `lib/rescue-return-verifier.mjs` | Pure logic + JSON pass/fail ledger: the gate (`isReturnDeliveryAllowed`), the smoke test (`runSmokeTest` / `runAllSmokeTests`), the ledger (`loadState`/`recordSmokeResult`/`setVerified`), and a CLI. **Allowlist-agnostic and 100% client-name-free** — the receiver passes its allowlist + builder in at call time. |
| `lib/rescue-return-verifier.test.mjs` | 25 unit tests. Injected `spawn` + `buildDeliverCommand`, throwaway temp ledger — no network, no real SSH. |

## Why a separate module

The receiver carries the real return-leg allowlist (client hostnames, containers,
IPs) and **must never enter a public repo**. This module never imports the
receiver; the receiver injects its allowlist and builder. The pass/fail ledger
keys **are** client box aliases, so the ledger lives in the **gitignored** runtime
state dir (`fleet-heartbeat/state/rescue-return-verify.json`) and is **never
committed** — same discipline as the durable ticket store (FIX-RESCUE-07).

## Ledger

`fleet-heartbeat/state/rescue-return-verify.json` (override
`RESCUE_RETURN_VERIFY_STATE`). Per box: `verified`, `transport`, `exitCode`,
`signal`, `testedAt`, `durationMs`, `error`, `stderrTail`, `firstVerifiedAt`,
`lastPassAt`, `testCount`. **Fail-safe:** a missing/corrupt ledger reads as empty
→ every VPS box is treated as unverified → Telegram fallback (never an unproven
SSH).

## Wiring into `rescue-receiver.mjs`

```js
import * as returnVerify from "./lib/rescue-return-verifier.mjs";

// (a) THE GATE — inside deliverToClientBox(), BEFORE spawning ssh:
const decision = returnVerify.isReturnDeliveryAllowed(
  box, RETURN_BOX_ALLOWLIST[box], returnVerify.loadState());
if (!decision.allow) {
  log(`RETURN gate box=${box} -> ${decision.transport} (${decision.reason}) ticket=${ticketId}`);
  postTelegramAlarm(
    `[RR return fallback] box=${box} unverified return-leg; delivering in-group instead of SSH.\n${deliverText}`,
    FIXER_GROUP_CHAT_ID, FIXER_THREAD_ID);
  return; // NEVER ssh an unverified VPS box
}
// ... existing SSH spawn ...

// (b) SMOKE-TEST admin path — a `--verify-return[=vps]` flag/endpoint:
await returnVerify.runAllSmokeTests({
  allowlist: RETURN_BOX_ALLOWLIST, buildDeliverCommand, vpsOnly: true });

// (c) export for the verifier CLI (guard the server start behind the main check
//     so importing the receiver does not bind the port):
export { RETURN_BOX_ALLOWLIST, buildDeliverCommand };
```

## Operating

```sh
# run the smoke sweep (VPS boxes only) and write the ledger:
RESCUE_RECEIVER_MODULE=./rescue-receiver.mjs \
  node lib/rescue-return-verifier.mjs --run
# include Mac-tunnel boxes too:
RESCUE_RECEIVER_MODULE=./rescue-receiver.mjs \
  node lib/rescue-return-verifier.mjs --run --all
# show the ledger:
node lib/rescue-return-verifier.mjs --status
# manual override once proven out-of-band:
node lib/rescue-return-verifier.mjs --mark <box> ok
```

Re-run the sweep after any box move / key rotation / container rename. Until a box
passes, its rescue answers still reach the client — just via the Telegram group
thread, never an unproven SSH.

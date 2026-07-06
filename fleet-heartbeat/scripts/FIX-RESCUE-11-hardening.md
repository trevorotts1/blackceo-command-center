# FIX-RESCUE-11 — receiver / relay / poller hardening bundle

**Priority:** P3 · **Area:** Rescue Rangers · **Wave:** 1
**Depends on:** FIX-RESCUE-07 (durable store) · FIX-RESCUE-04 (credential move)

Four independent hardening fixes.

## (i) Cross-restart double-answer — durable answer guard

**Problem:** the receiver deduped already-answered tickets with a
**process-local `_answeredTickets` Set**. That Set is empty after every restart,
and the receiver was crash-looping (FIX-RESCUE-01) — so the same ticket could be
answered twice (double Telegram post) across restarts.

**Fix:** `lib/rescue-answered-guard.mjs` makes "already answered?" durable.
`wasAnswered(ticketId)` / `claimAnswer(ticketId)`:
1. **PRIMARY** — consult the durable ticket store: a ticket whose `answer` is set,
   or whose status is past active handling (IN_PROGRESS/RESOLVED/CLOSED/
   ESCALATED/NEEDS_HUMAN), has already been acted on → skip.
2. **FALLBACK** — when the durable store is unavailable, use a small **on-disk
   JSON set** of claimed ids under the git-ignored state dir
   (`RESCUE_ANSWERED_DB`, default `state/rescue-answered-tickets.json`),
   self-pruned to a 7-day window so it can never grow unbounded.

**Wiring (private deploy):** in `rescue-receiver.mjs`, replace the
`_answeredTickets.has(id)` guard with `await claimAnswer(id)` (returns `false`
if already answered → skip the post; `true` → proceed).

## (ii) Constant-time auth compare

**Problem:** the relay's inbound auth compared the presented secret with plain
equality / Set membership — an early-exit, length-dependent comparison that leaks
timing.

**Fix:** hash both sides to a fixed 32-byte SHA-256 digest and compare with
`crypto.timingSafeEqual` (always length-safe; leaks neither length nor the
first-differing-byte position). Shipped twice, mirrored:
- `lib/rescue-constant-time-compare.mjs` — `constantTimeEqual()` / `authHeaderOk()`
  (fails closed when no secret is configured) for any Node caller.
- `relay-auth-constant-time-snippet.js` — `rescueConstantTimeEqual()` /
  `rescueAuthOk()` for the n8n Code node. The expected secret comes from an n8n
  **credential / `$env`** (FIX-RESCUE-04), never a hardcoded literal.

## (iii) Rename `Auth Check (soft)` → `Auth Check (enforced)`

**Problem:** the n8n node named "Auth Check (soft)" already returns a hard 403 —
the name understated the enforced behavior.

**Fix (private n8n instance):** rename the node to **`Auth Check (enforced)`** and
replace its comparison body with the constant-time compare from (ii). No
committed workflow JSON (it carries secrets/client data — FIX-RESCUE-04 purged
and git-ignored the exports); the change is applied in the live n8n editor.

## (iv) Poller distinguishes transport vs HTTP vs no-tickets

**Problem:** the poller exited **0 silently** on any curl hiccup or python parse
error, so "no tickets waiting" (healthy) was indistinguishable from a transport
failure, an HTTP 5xx/403, or a malformed body — a broken relay looked idle.

**Fix:** `lib/rescue-poll-fetch.sh` — `rr_poll_fetch <url>` separates the two
independent signals: the **curl exit code** and the **HTTP status code**. Body →
`$RR_POLL_BODY_FILE`, status → `$RR_POLL_HTTP_CODE` (set in the caller's shell so
a command-substitution subshell can't swallow it). Return classes:
`0` OK (2xx, body may be an empty "no tickets" payload), `2` TRANSPORT (curl
failed), `3` HTTP (non-2xx). The caller then parses the body and can tell an
empty-but-valid response from a PARSE error, and log/page each class distinctly.

**Wiring (private deploy):** in `rescue-rangers-poller.sh`, source the lib and
call it in the current shell (not `$(...)`), branching on `$?` and
`$RR_POLL_HTTP_CODE` per the header usage block.

## Verification

- `node --test scripts/lib/rescue-constant-time-compare.test.mjs` — match/mismatch,
  unequal-length no-throw, nullish fail-closed, no-secret deny.
- `node --test scripts/lib/rescue-answered-guard.test.mjs` — durable status is
  authoritative; disk fallback dedups before the store has the ticket; no-id lets
  the answer proceed.
- `node --test scripts/lib/rescue-relay-snippets.test.mjs` — the relay auth
  snippet (constant-time + fail-closed).
- `bash scripts/lib/rescue-poll-fetch.test.sh` (13 assertions, fake curl on PATH)
  — the OK / TRANSPORT / HTTP classes, 204 empty-but-ok, and the auto body file.

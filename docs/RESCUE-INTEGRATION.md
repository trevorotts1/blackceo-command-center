# Rescue Rangers — Command Center integration contract

**RR-017 reference doc.** What the Command Center's rescue integration IS and IS
NOT. The authoritative dependency/ownership manifest lives in the **private**
`blackceo-fleet-ops` repository at `rescue/contract-manifest.json`; the
public-safe client contract lives in the onboarding repository at
`23-ai-workforce-blueprint/templates/role-library/rescue-rangers/contract/PUBLIC-CLIENT-CONTRACT.md`.
This repo carries the integration surface only.

## What the Command Center owns here

- **Read-only dashboard** — `/rescue` renders the operator's rescue view from
  `src/lib/rescue/*` (`db.ts` opens the receiver-side SQLite store
  **read-only**, `{ readonly: true, fileMustExist: true }`; absence renders the
  empty state, never an error; freshness comes from `MAX(updated_at)`, never a
  file mtime, because the store runs WAL).
- **Nothing else.** The Command Center creates no ticket schema, writes no
  ticket state, runs no rescue sweep, and holds no rescue credential.

## The tombstone is load-bearing — do not remove it

`fleet-heartbeat/scripts/lib/rescue-ticket-store.mjs` is a **deliberate
tombstone**: the public copy was frozen at FIX-RESCUE-13 and silently reverted
the live FIX-RESCUE-14/15/16 escalation-cap fixes on checkout, so the path was
removed. It throws on import on purpose. **Never restore the old blob from this
repository's history and never replace the tombstone with a "real" copy** — the
canonical module lives only in the private Fleet Ops repo and the operator
machine's untracked tree.

## Board availability is asynchronous — never a gate

Per the Rescue contract (D12): boarding is a VIEW. A Command Center outage
delays visibility, never the rescue itself. No rescue code may treat a board
write as a precondition for working a ticket.

## Legacy path labels (RR-017 caller inventory)

| Path | Classification | CC-side rule |
|---|---|---|
| Public tombstone + `src/lib/rescue` read-only dashboard + receiver/poller/watchdog scripts | **active** | stays as-is; no private code may be copied into this public repo |
| Old Relay webhook `/webhook/rescue-rangers` | **retired** | receiver/poller/propagate defaults now point at canonical `rr-v2-intake` (env overrides preserved for single-writer rollback); any deployment still pointing at the retired path is a false-pass trap (see `rr-reconcile.sh` check 5) |
| Python SQLite ledger (`rescue_ledger.py` / `rescue_cc_board.py`) | **compatibility-only** | never ships in this repo; never runs against production ticket state |

## External-rescue execution boundary (points at RR-018)

Current CC ingest/tasks guard against a second fixer being launched. Until
RR-018/019 land the supported external-rescue execution contract and board
projector, nothing in this repo may auto-dispatch rescue work from ingest.
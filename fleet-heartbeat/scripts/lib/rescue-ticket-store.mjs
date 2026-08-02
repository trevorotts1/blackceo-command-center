// rescue-ticket-store.mjs — DELIBERATELY REMOVED FROM THIS PUBLIC REPOSITORY
// ===========================================================================
// THIS IS A TOMBSTONE. It is not the module. Importing it throws on purpose.
//
// WHAT USED TO BE HERE
// --------------------
// The durable SQLite ticket store behind the operator-side rescue escalation
// relay: RR- ticket minting, the lifecycle state machine, semantic dedup, and
// the per-identity 25/day escalation cap.
//
// WHY IT IS GONE (2026-08-01)
// ---------------------------
// This public repository tracked a copy of that module that was frozen at
// FIX-RESCUE-13. The running copy on the operator machine had since taken
// FIX-RESCUE-14, -15 and -16, which fix, among other things, a defect where a
// rotating machine-generated identity (a container id that changes on every
// container recreation) minted a brand-new daily budget each time and therefore
// silently reset the daily escalation cap to zero. The brake released itself at
// exactly the moment it was most needed.
//
// The two copies could not be reconciled by simply updating this one:
//
//   1. The running module is NOT sourced from git on the operator machine. Its
//      whole directory is excluded there via .git/info/exclude, so it is
//      untracked AND ignored. Git refuses to clobber an untracked file on
//      checkout ("would be overwritten by checkout"), but it silently
//      overwrites an IGNORED one. Any `git checkout main`, `git pull`, or
//      `git reset --hard` against this repository therefore wrote the stale
//      FIX-RESCUE-13 blob over the live module with no prompt, no conflict and
//      no output. That is the same silent-revert failure class that produced a
//      week-long production incident, and shipping a fresher blob here would
//      have left the mechanism fully intact and merely reset its clock.
//
//   2. Later revisions of the module carried real fleet identifiers as
//      regression fixtures. Nothing that carries a customer identifier may be
//      pushed to a public remote, and a git push is not reversible.
//
// Removing the path closes the mechanism instead of postponing it: a path that
// does not exist here can never be restored over the live module.
//
// WHERE THE REAL FILE LIVES
// -------------------------
//   * Canonical published copy: the PRIVATE repository `blackceo-fleet-ops`,
//     same path, `fleet-heartbeat/scripts/lib/rescue-ticket-store.mjs`.
//   * Running copy / true head: the operator machine's own untracked
//     `fleet-heartbeat/scripts/lib/` directory. It can be ahead of the private
//     repository. Diff against the private repo before assuming either is
//     current.
//
// Its unit test, `rescue-ticket-store.test.mjs`, was removed from this
// repository at the same time and for the same reasons. No CI in this
// repository referenced either file (`npm run test:unit` globs
// `tests/unit/*.test.ts` only), so nothing here regressed.
//
// IF YOU LANDED HERE FROM A RESTORE
// ---------------------------------
// You are restoring an operator-only component from the wrong source. Do NOT
// delete this tombstone and do NOT resurrect the old blob from this repo's
// history — that blob is the version with the defect. Fetch the module from the
// private repository above.
//
// This module is imported only by `lib/rescue-receiver-store-hook.mjs`, which is
// imported only by `scripts/rescue-receiver.mjs`, which by its own header "Runs
// ON the operator Mac, bound to loopback 127.0.0.1:8799 ONLY". Nothing outside
// the operator machine loads this file, so this tombstone cannot break a
// deployment elsewhere.
//
// The throw below is intentional and load-bearing. A rescue path that fails to
// start is noisy and gets noticed in minutes; a rescue path whose rate-limit
// brake has silently reset is invisible for as long as it takes someone to read
// the source. Between the two, fail loudly.
// ===========================================================================

throw new Error(
  "rescue-ticket-store.mjs is not published in this repository. This file is a " +
    "tombstone. The public copy was frozen at FIX-RESCUE-13 and silently reverted " +
    "the live FIX-RESCUE-14/15/16 escalation-cap fixes on any checkout, so the path " +
    "was removed. Fetch the module from the private blackceo-fleet-ops repository at " +
    "fleet-heartbeat/scripts/lib/rescue-ticket-store.mjs, or from the operator " +
    "machine's own untracked fleet-heartbeat/scripts/lib/ directory. Do not restore " +
    "the old blob from this repository's history."
);

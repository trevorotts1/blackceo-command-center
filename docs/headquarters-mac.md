# Headquarters on the Mac target — install and owner entry

Audience: the operator installing Headquarters on a native Mac Mini box, and the
prover consuming the Q12 local path/auth/readiness contract.

Scope: this document describes only what exists in this repository and what
`scripts/install/mac-mini-bootstrap.sh` actually does. It does not describe the
Docker target (see the onboarding repo's Docker guide) and it does not authorize
any fleet rollout. No provider, key or model configuration is created or changed
by anything described here.

Source of the rules below: SPEC.md rev 4 S10 (two targets, install/upgrade and
failure, rollback) and S6 (the Headquarters table set), the deployment-target
contract `evidence/contracts/targets.md` (P05), and the frozen TypeScript
contracts `src/lib/hq/types.ts` (P01).

## 1. What the installer does

`scripts/install/mac-mini-bootstrap.sh` is unchanged in its install model. It
still: installs brew formulae and npm globals, writes the canonical PM2
`ecosystem.config.cjs` into `~/projects/command-center`, registers PM2 for
launchd, and ends with the repair gate `scripts/repair-command-center.sh`
(better-sqlite3 rebuild + migrations + SOP seed + routing self-verify).

Headquarters adds exactly one step, **step 10 — capability and persistence
preflight**, which runs after the repair gate on purpose: on a fresh box the
schema migrations only run inside the repair gate, so a check placed before it
would disable Headquarters on every new install with nothing to re-enable it.

Step 10:

1. Ensures the existing Mac persistence roots exist — `~/clawd/scratch/` and
   `~/.mission-control/identity` — the locations `src/lib/platform.ts` already
   resolves on `mac-mini` (workspace scratch, bridge device identity). Because
   they live in the operator's home they survive reboots and re-installs.
2. Resolves the database path (`DATABASE_PATH` when exported, else the path the
   canonical ecosystem pins for this install dir) and **prints the resolved
   absolute path**.
3. Checks the LIVE schema, not the `_migrations` ledger, for the S6 Headquarters
   table set: `hq_activity`, `hq_activity_state`, `hq_activity_receipts`,
   `hq_run_bindings`, `hq_chat_sessions`, `hq_chat_turns`,
   `hq_owner_login_uses`. Reading the ledger would repeat the "falsely healed"
   defect `scripts/cc-schema-health.ts` exists to catch.
4. Writes the availability flag additively (see §2).
5. Prints a one-line summary: persistence, database path, capability, flag action.

No new service, no new container, no new daemon, no key touched. The exact
outbox file path is deliberately **not** named here — it is owned by the
telemetry unit; this script only guarantees the persistent roots it lives under.

## 2. The availability flag

`HEADQUARTERS_ENABLED` (SPEC S10) is the operational fallback that answers "is
Headquarters available on THIS box", computed from the live schema:

| Live schema | Flag written | Meaning |
|---|---|---|
| all S6 tables present | `HEADQUARTERS_ENABLED=1` | Headquarters available |
| any table missing | `HEADQUARTERS_ENABLED=0` | writes stay blocked; reason printed |
| DB absent | `HEADQUARTERS_ENABLED=0` (reason `database-absent`) | migrations have not run yet |
| DB present but unreadable | `HEADQUARTERS_ENABLED=0` (reason `database-unreadable`) | probe could not read it — stated, never guessed |
| probe binary absent | `HEADQUARTERS_ENABLED=0` (reason `sqlite3-cli-absent`) | UNDETERMINED, said out loud |

Rules the script obeys while writing it:

- **Additive only.** If `.env.local` in the install dir already carries
  `HEADQUARTERS_ENABLED`, the operator's value is preserved and the script says
  so. Only an absent key is appended. Nothing else in the file is reordered or
  rewritten — so no `.bak` is needed.
- **Fail-closed availability, never a broken install.** A schema-less box still
  installs completely; it just has Headquarters disabled with a descriptive
  status. Per SPEC S10 a startup schema failure blocks Headquarters writes and
  reports failed health — it must not present a deceptive empty office.
- **Not an authorization.** The flag is an operational switch. It is not a
  customer activation approval and it is not a consent to deploy anywhere.
- Re-running the bootstrap after the reserved Headquarters migration lands does
  not rewrite an existing flag line — it prints `operator value preserved`. So a
  box that was disabled stays disabled until a human sets
  `HEADQUARTERS_ENABLED=1` in `.env.local` once the schema is present. That is
  deliberate: availability is an operational decision, and the installer is not
  allowed to flip it behind the operator's back.

## 3. Owner entry on a Mac

Owner entry reuses the existing identity path; this installer creates none of
it:

- On the server side the owner's browser uses the box's existing configured
  secure customer origin (Cloudflare Access where configured). Headquarters is
  served directly by the customer's own installation — a shared tenant-board
  request is refused, and the Mac still hosts its own server.
- A completed-company owner on a fresh browser is issued a private
  `/owner-login#ticket=<capability>` link by the owner-login unit's host command
  (`scripts/mint-owner-login.ts`, built by that unit — it does not exist in this
  checkout yet). Once it lands, read its own header for its exact flags and
  **do not invent command arguments**. The link is a bearer capability until it
  expires: it is returned to the operator running the command, is never
  automatically sent, published or logged, and no public issue endpoint exists.
- `/owner-login` contains no company data before authentication, and the exact
  configured HTTPS origin is required — a plain-HTTP or unknown origin is a
  setup error, never a Secure-cookie bypass.

None of these files are created by this bootstrap: no second identity service,
no interview re-enrollment, no change to the configured edge Access policy.

## 4. Health and readiness

- `GET /api/health` and `GET /api/health/deep` are the readiness surfaces.
  "Port is open" is not readiness: health must prove serving build plus
  migration/capture/auth readiness (SPEC S10).
- `scripts/cc-health-check.sh` is the single definition of green
  (0 green / 1 red / 3 UNKNOWN — never roll back on 3), with
  `scripts/repair-command-center.sh` as the repair gate behind it.
- With the flag at `0`, the box is available and healthy with Headquarters
  disabled, and the setup status says why. That is the intended state, not a
  failure to paper over.

## 5. Persistence across restart and upgrade

| What | Where (Mac) | Survives |
|---|---|---|
| HQ rows (activity, chat, bindings, receipts, nonces) | the resolved `DATABASE_PATH` (`mission-control.db` in the install dir) | pm2 restart, reboot, code update |
| Outbox | existing tenant workspace `hq-telemetry/outbox` under `~/clawd/` | restart, reboot, code update |
| Pending-join store | `hq-telemetry/correlation/` under `~/clawd/` | restart, reboot, code update |
| Bridge device identity | `~/.mission-control/identity` (override: `BCC_DEVICE_IDENTITY_DIR`) | restart, reboot, code update |
| Workspace scratch | `~/clawd/scratch/` | restart, reboot, code update |

Code updates go through the existing updater/atomic-deploy path (`update.sh` →
`scripts/atomic-deploy.sh`, or the onboarding repo's `--update-only` path), which
builds beside the live tree and promotes it; the process manager stays PM2 with
the canonical `blackceo-command-center` app and `scripts/cc-start.sh` as the only
launcher. Backups: the existing deploy helpers can create them, but a backup
taken on a live operator or client box requires explicit operator authorization
first — this document authorizes none, and names no backup path.

**Rollback** switches to the previous tested code while retaining additive rows
and every message written since the upgrade. Restoring a stale database backup to
"undo" an upgrade would erase those writes; a database restore is a separately
authorized recovery operation with write reconciliation, and is never automatic.

## 6. Q12 evidence contract for the Mac target (T06)

The Mac prover consumes the frozen input contract in
`evidence/contracts/targets.md` §7. Practical points for this box shape:

1. **Pin the install dir explicitly.** On the operator Mac the live checkout and
   `~/projects/command-center` (a data-only directory) are two different things.
   Pass `--app-dir` or `CC_APP_DIR`; never rely on the ambiguous default.
2. **Record the installed version + the boot script before starting.** The
   bootstrap never clones and never pulls — it configures whatever checkout
   already sits at the pinned install dir, so record the code revision it was
   run against. Code versions are delivered by the existing updater
   (`update.sh` → `scripts/atomic-deploy.sh`), which is also where a rollback
   point comes from; a box that has never run an `update.sh` cycle has none
   yet. Read the helpers' own headers before invoking them.
3. **Do not fight the live listener.** `scripts/cc-start.sh` frees port 4000 by
   killing the orphan listener. A disposable fixture must use a non-4000
   `CC_PORT` with `CC_PORT_OVERRIDE_ACK=1`, or stop the live CC first.
4. **Record the resolved absolute `DATABASE_PATH`** as actually resolved
   (step 10 prints it). Never infer isolation from a filename or env var.
5. **Prove persistence across a restart** for each row of the table in §5, and
   prove a populated upgrade plus an old-code rollback retaining messages
   written after the upgrade.
6. **No customer provider or key changes**; inspect diffs and config values
   without printing secret values.
7. If the fixture cannot run, report BLOCKED with the test evidence still
   needed — do not infer the result from static code.

## 7. Verification of this unit

`tests/unit/hq/B31/mac-bootstrap-hq.test.sh` extracts the real `hq_*` functions
from the installer by sed range (never a copy) and drives them against temp
fixtures: capability detection per table-missing case, the unreadable-DB and
absent-CLI paths, additive flag writes (fresh file, existing operator value,
idempotent re-run), persistence preflight, and a negative control proving the
probe goes red when a required table is dropped. Run:

```bash
bash tests/unit/hq/B31/mac-bootstrap-hq.test.sh
```

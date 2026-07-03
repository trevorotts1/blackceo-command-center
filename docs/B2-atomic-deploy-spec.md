# B.2 — Atomic Self-Verifying Deploy + Auto-Rollback

**Status:** Implemented and shipped on `main`. `scripts/atomic-deploy.sh` fully implements this spec (all five phases below), with dependencies `scripts/cc-health-check.sh` and `scripts/weekly-cleanup.sh` present; QC gate 10.1 (`scripts/qc-cc.sh`) and `tests/unit/b2-atomic-deploy.test.ts` assert it is no longer a stub.

---

## Overview

`scripts/atomic-deploy.sh` is the canonical deploy entry-point for the BlackCEO Command Center. It enforces an atomic build-swap cycle with integrated health verification and automatic rollback on failure. A deploy that cannot pass its own health check never stays deployed.

---

## Specification

### Phase 1 — Pre-flight

1. **Disk gate (B.4):** Check available disk space. If free space is under **5 GB**, run the cleanup routine first. If still under 5 GB after cleanup, abort with a clear error. Never attempt a build on a disk that cannot hold a second `.next` copy.
2. **Database backup:** Snapshot the current database before touching any build artifacts.
3. **Rollback artifact:** Copy the current `.next` directory to `.next.rollback` (overwriting any prior rollback snapshot). This is the restore target if the new build fails health check.
4. **PM2 hygiene:** Kill any pm2 process for this product that is NOT the canonical process name. No orphaned processes may interfere with the swap.

### Phase 2 — Build to a Temp Directory

5. Run `npm run build` targeting a **temporary output directory** (not the live `.next`). A clean `exit 0` from the build is required to proceed.
6. If the build exits non-zero: abort immediately, leave `.next` untouched, report the build error, and exit non-zero. The rollback artifact is not needed (old build is still live).

### Phase 3 — Atomic Swap

7. Replace the live `.next` with the freshly-built temp directory in a **single atomic rename/move** — there must be no window where the running server is serving a partially-swapped or mismatched set of files.

### Phase 4 — Restart + Health Verification

8. **Restart the server** immediately onto the fresh build (pm2 restart / equivalent).
9. **Run `scripts/cc-health-check.sh`** and capture its JSON output.
10. Evaluate the health-check result:
    - **Green (exit 0):** Deploy is complete. Emit a success receipt.
    - **Any non-green (exit non-zero or JSON reports failure):** Proceed to Phase 5.

### Phase 5 — Auto-Rollback (triggered by non-green health check)

11. **Restore `.next.rollback`** back to `.next` atomically.
12. **Restart the server** onto the restored build.
13. **Re-run `scripts/cc-health-check.sh`** to confirm the rollback is healthy.
14. **Report loudly:** emit a rollback receipt containing:
    - Timestamp
    - Reason (the failing health-check JSON from step 9)
    - Rollback health-check result (from step 13)
    - Exit non-zero so callers and CI know the deploy failed.

---

## Invariants

| Invariant | Description |
|-----------|-------------|
| Never partial | The swap is a single atomic operation. The server never serves a mix of old and new files. |
| Never unverified | Every deploy is followed by a health check. No exceptions. |
| Never silent rollback | A rollback always produces a receipt with the failing health-check JSON. |
| Never disk-blind | Disk gate runs before any build artifacts are written. |
| Rollback always tested | The rollback itself is health-checked before the script exits. |

---

## Dependencies

- `scripts/cc-health-check.sh` (B.1) — must be on `main` before this script is activated.
- `scripts/weekly-cleanup.sh` — used by the disk gate cleanup step.
- pm2 — canonical process manager assumed.

---

## Files

| Path | Purpose |
|------|---------|
| `scripts/atomic-deploy.sh` | Implementation (this spec's target) |
| `scripts/cc-health-check.sh` | Health verification called by this script (B.1) |
| `docs/B2-atomic-deploy-spec.md` | This specification |

---

*Originally added as a scaffold commit on branch `feat/b2-atomic-deploy`. The full implementation has since landed on `main` — `scripts/atomic-deploy.sh` is the live deploy entry-point.*

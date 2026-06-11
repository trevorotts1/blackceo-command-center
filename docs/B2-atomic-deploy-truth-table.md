# B.2 Atomic Deploy — Exit-Code Truth Table

All enumerated outcomes for `scripts/atomic-deploy.sh`. Every row corresponds to
a named fixture test in `tests/unit/b2-atomic-deploy.test.ts`.

---

## Primary truth table

| # | Scenario | Build exit | Health exit | Expected script exit | Rollback fires? | Notes |
|---|----------|-----------|------------|---------------------|-----------------|-------|
| 1 | Good deploy: build succeeds, health green | 0 | 0 | **0** — success | No | Success receipt emitted with health JSON. New BUILD_ID installed in `.next`. |
| 2 | Broken build: npm exits non-zero, live `.next` exists | non-zero | N/A | **2** — pre-flight abort | No | Old `.next` untouched. No swap, no rollback needed. Old BUILD_ID unchanged. |
| 3 | Build ok, health exits 1 (definitive NOT GREEN) | 0 | 1 | **1** — rollback executed | Yes | `.next.rollback` restored → `.next`. Rollback itself health-checked. Both deploy + rollback health JSONs in receipt. |
| 4 | Build ok, health exits 3 (UNKNOWN) on all retries | 0 | 3 | **3** — UNKNOWN, no rollback | No | Retry loop exhausted. New build stays live. Operator must investigate. Per spec: never rollback on exit 3. |
| 5 | Disk below threshold after cleanup | N/A | N/A | **2** — pre-flight abort | No | Disk gate fires before any build artifacts are written. Operator message includes GB figures. |

---

## Edge-case rows

| # | Scenario | Build exit | Health exit | Expected script exit | Notes |
|---|----------|-----------|------------|---------------------|-------|
| 6 | Build succeeds; BUILD_ID mtime **== BUILD_START_TS** (same wall-clock second) | 0 | 0 | **0** — success | The mtime guard uses `<` (strictly less than), so a BUILD_ID written in the same second as `BUILD_START_TS` is accepted as fresh. Using `<=` would reject this as a "stale artefact" — a false-fail on M-series Macs and any fast CI runner where npm writes the file in << 1 ms. See fixture test "Spec Verify (f)". |
| 7 | Build succeeds; BUILD_ID mtime **< BUILD_START_TS** (strictly older) | 0 | N/A | **2** — stale artefact | The BUILD_ID in BUILD_TMP predates the build invocation — it was carried over from the Phase 1c `.next.rollback` snapshot copy, not produced by this build. Treated as build failure. |
| 8 | NEXT_DIST_DIR ignored by Next.js version + npm exits non-zero + mtime guard passes | non-zero | N/A | **2** — pre-flight abort; **`.next` intact** | The script moved `APP_DIR/.next` into `BUILD_TMP` before detecting the npm failure. Without the data-loss fix, deleting `BUILD_TMP` would leave `APP_DIR/.next` missing — breaking the live server while reporting "old build untouched". With the fix: `APP_DIR/.next` is restored from `.next.rollback` before `BUILD_TMP` is deleted. See fixture test "Spec Verify (g)". |
| 9 | Health check exits 2 (usage/config error from cc-health-check.sh itself) | 0 | 2 | **1** — rollback executed | Exit 2 from the health check is remapped to exit 1 (conservative: treat as definitive not-green). A correctly deployed but misconfigured health-check invocation can therefore roll back a good deploy. Spec: "any non-green triggers rollback." |

---

## Invariants cross-reference

| Invariant | Enforced by |
|-----------|-------------|
| Never partial swap | Phase 3: two `mv` calls — park old `.next`, rename BUILD_TMP in. No window where `.next` is absent on the same filesystem. |
| Never unverified | Phase 4b: `cc-health-check.sh` called unconditionally after every swap + restart. |
| Never silent fail | Every non-green exit path emits a loud receipt with health JSON to stderr. |
| Never disk-blind | Phase 1a: disk gate runs before `npm run build`; cleanup attempted first. |
| Rollback verified | Phase 5 rollback path re-runs `cc-health-check.sh` on the restored build before exiting 1. |
| Never rollback on exit 3 | Phase 5: `elif [[ $HEALTH_EXIT -eq 3 ]]` block explicitly placed before the rollback `else` branch. |
| Old build untouched on exit 2 | Phase 2: swap never occurs unless npm exits 0 AND mtime guard passes. NEXT_DIST_DIR bypass path restores `.next` from `.next.rollback` if npm fails after the move. |

---

*Maintained alongside `scripts/atomic-deploy.sh`. Update this table when any new exit path is added.*

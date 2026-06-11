# B.1 Verification Truth Table

**Spec for:** `scripts/cc-health-check.sh` (PR #78) + `/api/health/deep` (§5 guidance)
**Purpose:** enumerate every state the health-check must classify correctly.
A wrong verdict on any row blocks the check from passing its own gate.
A new edge case becomes a new row, not new code to defend against vibes.

Guidance ref: DUCK-PIPELINE-GUIDANCE.md §5.2
PR owning the check implementation: #78 (feat/b1-cc-health-check)

---

## How to read this table

| Column | Meaning |
|--------|---------|
| **State** | What is true about the running installation |
| **Expected overall verdict** | PASS / FAIL / UNKNOWN (not FAIL) |
| **Expected failing check** | The named sub-check that triggers the non-PASS verdict |
| **Must NOT cause FAIL** | A side-condition that must be true simultaneously |
| **Source** | The incident, PR, or guidance finding that surfaces this row |

`UNKNOWN` = the check cannot determine health but MUST NOT return FAIL; the
check exits with a distinct "indeterminate" code so the caller can distinguish
"known bad" from "cannot tell". This matters for the adversarial gate: a check
that returns FAIL on an ambiguous state gives false-positive HALT decisions.

---

## Row set

| # | State | Expected overall verdict | Expected failing check | Must NOT cause FAIL | Source |
|---|-------|--------------------------|----------------------|---------------------|--------|
| 1 | `config/company-config.json` absent AND DB `companies` row is empty or placeholder (name="Default"/"Command Center" etc.) | FAIL | company-config: file missing AND no branded DB row | Does NOT apply when DB has a real branded name (see Row 1b) | NARROWED from original Row 1 (Round-2 fix #3): original "config absent → FAIL" was a dead-letter — the implementation correctly passes when the DB has a real branded name (Row 1b). Row 1 now covers only empty/placeholder DB names when config is also absent. The 'DB absent' sub-case is superseded by Row 6 (DB absent → UNKNOWN, not FAIL); Row 1 must not enumerate 'absent' as a FAIL trigger. |
| 1b | `config/company-config.json` absent AND DB `companies` row has a real branded name (API-onboarded install) | PASS | — | Must NOT FAIL just because no config file | Round-2 fix #3: API-onboarded installs are valid; config file absence alone is not misconfigured. The deep-checks.ts code path at the "config absent + branded DB" branch implements this correctly. |
| 2 | `config/company-config.json` present but empty (`{}`) | FAIL | company-config: all required keys absent | — | Partial-config rule (guidance §5.2): empty ≠ valid |
| 3 | `config/company-config.json` present with all required keys populated | PASS | — | — | Happy path |
| 4 | DB `companies` row = Default row only (name="Command Center" / "Default") | FAIL | branding: company is unbranded placeholder | — | Addendum B findings; Default row blocks wave gate |
| 5 | DB `companies` row branded (real client name, non-placeholder) | PASS | — | — | Happy path |
| 6 | DB `companies` row absent entirely (fresh install, never onboarded) | UNKNOWN | branding: no company row | Must NOT return FAIL | Fresh install is not a broken install; B.1 must not block bootstrapping |
| 7 | DB `companies` row present but `name` column empty string | FAIL | branding: company name is empty | — | Empty string is as bad as absent. IMPLEMENTATION NOTE: query must select ALL rows (`SELECT name FROM companies ORDER BY id LIMIT 1`) without filtering on `name != ''`; empty-string detection is done in application code after retrieval. |
| 8 | HTML page `<title>` extractable and contains client brand name | PASS (branding check component) | — | — | B.1 branding verification |
| 9 | HTML page `<title>` is "Command Center" / generic placeholder | FAIL | branding: HTML title is unbranded | — | Default React title = not deployed for client |
| 10 | HTML page not reachable (server not up yet) | UNKNOWN | connectivity: server unreachable | Must NOT return FAIL | Server may be starting; B.2 deploy calls B.1 before pm2 is fully up |
| 11 | Asset manifest (`_next/BUILD_ID` or asset-manifest.json) present and all referenced assets exist on disk | PASS | — | — | Asset integrity check (guidance §5.1) |
| 12 | Asset manifest stale — manifest exists but references assets that are missing from disk | FAIL | asset-integrity: missing build assets | — | Partial deploy / interrupted build leaves manifest inconsistent |
| 13 | Asset manifest fresh — built within the last 24h (`mtime` check) | PASS | — | Manifest age alone does not FAIL; only missing assets fail | An old but complete build is valid |
| 14 | `pm2 list` shows CC app process running, correct cwd, status=online | PASS | — | — | Happy path pm2 state |
| 15 | `pm2 list` shows CC app in `errored` or `stopped` state (zombie) | FAIL | pm2: CC app not running | — | Zombie pm2 incident (B.1 findings) |
| 16a | `pm2 list` shows CC app running but `pm_cwd` is null/empty | FAIL | pm2: null cwd — cwd not set in pm2_env (always wrong) | — | null cwd = pm2 lost track of the working directory |
| 16b | `pm2 list` shows CC app running, `pm_cwd` is non-null, but does NOT match `--canonical-dir` | FAIL | pm2: wrong cwd — app started from wrong directory | — | Round-2 fix #1: previous code only checked `null_cwd_count`, never checked `cwd_ok=false`. A wrong-but-non-null cwd with --canonical-dir set exits 0 GREEN in the old code. Fix: extract `cwd_ok` and add `elif cwd_ok != true → FAIL`. |
| 17 | `pm2 list` shows CC app running with correct cwd (pinned) | PASS | — | — | cwd-pinned happy path |
| 18 | `pm2 list` shows zero apps (pm2 never started) | FAIL | pm2: no processes managed by pm2 | — | Clean-but-unstarted install is still broken for clients |
| 19 | `pm2 list` shows a non-CC app crash-looping (e.g. an openclaw daemon) | PASS | — | Must NOT fail just because another app is errored | B.1 scope is CC only; other-app failures are noise |
| 20 | `DATABASE_PATH` env var set and points to an existing writable SQLite file | PASS | — | — | Happy path DB config |
| 21 | `DATABASE_PATH` env var unset (falls back to `process.cwd()/mission-control.db`) | PASS | — | Default path is valid; unset ≠ misconfigured | `src/lib/db/index.ts` line 19: `DB_PATH` resolution |
| 22 | `DATABASE_PATH` set but file does not exist and directory is not writable | FAIL | db: DATABASE_PATH not writable | — | SQLite will fail to create the file; server crash on first query |
| 23 | Disk free space ≥ 500 MB on the CC partition | PASS | — | — | Happy path disk |
| 24 | Disk free space < 500 MB on the CC partition | FAIL | disk: low disk space | — | Low-disk incident caused silent write failures and task loss |
| 25 | Cloudflare tunnel active — outbound `curl` to CC public URL returns 200 | PASS | — | — | CF tunnel happy path |
| 26 | Cloudflare tunnel active but returns 301/302 redirect (CF misconfigured) | FAIL | cf: redirect loop — public URL redirects instead of serving app | — | CF-redirect incident; redirect means the tunnel is up but routed wrong |
| 27 | Cloudflare tunnel absent / CF daemon not running | UNKNOWN | cf: tunnel unreachable | Must NOT return FAIL | Tunnel may be intentionally disabled (direct-IP install); absence alone is not a break |
| 28 | SQLite DB locked (`SQLITE_BUSY` on test query) | UNKNOWN | db: sqlite locked — cannot read | Must NOT return FAIL | Transient lock during heavy write; not a broken install. Guidance: "sqlite locked (UNKNOWN not fail)" |
| 28b | `/api/health/deep` returns HTTP 5xx (route crashed before producing JSON) | UNKNOWN | probe: HTTP 5xx from deep endpoint | Must NOT return FAIL | Round-2 fix #2: route.ts comment mandates "500 = internal error, treat as indeterminate by caller". Old code exited 1 RED on any non-200. Fix: 5xx branch exits 3 UNKNOWN. |
| 29 | Migrations current — `db_version` / `migrations` table shows all migrations applied | PASS | — | — | Happy path migrations |
| 30 | Migrations behind — at least one pending migration not yet applied | FAIL | db: pending migrations | — | Stale schema causes API 500s on new columns |
| 31 | `NEXT_PUBLIC_APP_URL` set to a non-localhost URL AND `CC_PUBLIC_URL` set to a matching hostname | PASS | — | — | Happy path URL config. **REDO #1 precondition added:** Row 31 PASS requires `CC_PUBLIC_URL` to be set so the check can verify consistency. Without it, non-localhost URLs return FAIL (Row 32). |
| 32 | `NEXT_PUBLIC_APP_URL` set to a non-localhost URL AND `CC_PUBLIC_URL` unset (cannot verify) OR `CC_PUBLIC_URL` set to a different hostname OR `CC_PUBLIC_URL` truthy but not a valid URL | FAIL | config: NEXT_PUBLIC_APP_URL unverifiable or mismatch — SSE and webhooks will fail | — | **REDO #1 fix:** old code fell through to `pass=true` for any valid non-localhost URL when `CC_PUBLIC_URL` was unset. A wrong tunnel URL (e.g. copied from another client) would pass silently. Fix: non-localhost + `CC_PUBLIC_URL` unset → FAIL (cannot verify). Non-localhost + `CC_PUBLIC_URL` different host → FAIL (confirmed mismatch). **REDO #2 fix:** Row 32 false-green when `CC_PUBLIC_URL` is truthy but NOT a valid URL (e.g. `'not-a-valid-url'`, `'   '`, `'http://'`, `'://nodomain'`). Old code: catch{} at the `new URL(publicUrlHint)` call swallowed the TypeError; `!publicUrlHint` guard at line 562 did not fire (publicUrlHint is truthy); function fell through to `pass=true`. Fix: set `publicUrlHintInvalid=true` in the catch{}; widen the FAIL guard to `if (!isLocalhost && (!publicUrlHint \|\| publicUrlHintInvalid))`. vitest row: `NEXT_PUBLIC_APP_URL=non-localhost + CC_PUBLIC_URL='not-a-valid-url'` → `pass=false`, `indeterminate` not true. |
| 33 | CF Access policy misconfigured — public URL returns HTTP 200 + CF Access challenge HTML (not a redirect, not the real app) | UNKNOWN | cf: CF Access challenge intercepting public requests — local probe passes, clients blocked | Must NOT return FAIL; local probe at 127.0.0.1:PORT bypasses CF Access and sees the real app (correct), so the local-probe PASS is accurate for the local check; the public-URL probe detects the CF challenge body and returns UNKNOWN | Distinct from row 26 (redirect) and row 27 (tunnel absent). CF Access returns 200 + HTML challenge, not a 3xx. Only detectable via public-URL probe (CC_PUBLIC_URL). If CC_PUBLIC_URL is unset, this scenario is a documented gap (see row 27 handling). |
| 34 | `pm2 list` shows 2 or more CC apps matching the CC port (zombie duplicate — e.g. a stale pm2 entry from a previous deploy is still alive alongside the current one) | FAIL | pm2: duplicate CC apps (app\_count > 1) | — | Zombie duplicate incident: a second pm2 app on the same port causes non-deterministic request handling and crash-loop masking. cc-health-check.sh line 87 (`PM2_COUNT -gt 1`) covers this; truth table row added to document the named state. |
| 35 | Disk free space reported ≥ 500 MB but the check path resolves to a separate large-capacity mount (`/data`); the actual CC filesystem partition has < 500 MB free | FAIL | disk: wrong-mount false-green — check path resolves to separate mount | — | **Sheila incident root cause**: /data is a large bind-mount; `process.cwd()` and `DATABASE_PATH` dir resolve to `/data` on a misconfigured box, reporting abundant free space on the wrong partition. **REDO #1 addition**: `DATABASE_PATH=/data/mission-control.db` variant — `path.dirname()` resolves to `/data` directly (not via heuristic), bypassing the original guard. Fix: `resolveCheckPath()` has an explicit `WRONG_MOUNT_PREFIXES` guard; when `DATABASE_PATH` dir starts with `/data`, falls back to `process.cwd()`. Three vitest tests prove the guard: (a) no DATABASE_PATH, (b) DATABASE_PATH in CC partition (not /data), (c) DATABASE_PATH=/data/... — all return FAIL, `result.path` never starts with `/data`. |
| 36 | `config/company-config.json` present with a valid `companyName` AND DB `companies` row is entirely absent (not empty, not placeholder — no row exists at all) | PASS | — | — | Config-present + DB-row-absent is a valid state when the CC app has not yet run its first seed (e.g. fresh deploy, seed deferred). The implementation falls through all guards: `configExists=true`, `configName` is set, `dbRowAbsent=true` — returns PASS based on the config file alone. This is the correct verdict; a valid config file is sufficient to declare the company configured. Row documents the expected PASS so reviewers do not mistake the `dbRowAbsent=true` fall-through for a bug. |
| 38 | CC app running on Node 18 (no `fs.statfsSync`); disk headroom check attempted | UNKNOWN | disk: cannot determine disk free space on Node 18 (indeterminate) | Must NOT return PASS based on `os.freemem()` (RAM bytes, wrong metric) | **REDO #1 false-green fix**: on Node 18 the old `diskReader.readFreeBytes` fell back to `os.freemem()` (available RAM). Any machine with >500 MB free RAM passed the check regardless of actual disk space. Fix: `diskReader.readFreeBytes` throws when `statfsSync` is absent; `checkDiskHeadroom()` catches the throw → returns `indeterminate=true` (UNKNOWN). vitest proves: stubbed `statfsSync`-absent path throws, result is UNKNOWN (never pass). |
| 37 | `config/company-config.json` PRESENT with a PLACEHOLDER `companyName` (e.g. `"Command Center"`) AND DB `companies` row is ABSENT (no row exists, `dbName=null`) | FAIL | company_branding: config has placeholder companyName + no DB row | — | **Round-3 fix #7**: previously `isPlaceholder()` was only evaluated when `dbName !== null`. When `dbRowAbsent=true`, the guard never fired and the function fell through to `pass=true` — false-green. Fix: when `configExists=true` AND `dbRowAbsent=true`, check `isPlaceholder(configName)` and FAIL immediately. A placeholder config name is never a valid company identity regardless of DB state. Complements Row 36 (valid name + absent row = PASS) and Row 4 (placeholder DB name = FAIL); this row covers the gap where BOTH config has a placeholder AND the DB has no row to catch it. |

---

## Severity classification

| Tier | Verdict | Gate behavior |
|------|---------|---------------|
| **Wrong verdict** on any row | Blocks | Hard FAIL — implementation must be fixed before merge |
| **Missing row** for a real edge case | Blocks | Add the row AND implement the check |
| **Style / log wording** | Note only | Does not block |

---

## TODO rows (future PRs to add checks for)

| State | Proposed verdict | Notes |
|-------|-----------------|-------|
| OpenClaw gateway unreachable (no response on `OPENCLAW_GATEWAY_URL`) | UNKNOWN | Gateway may be intentionally offline; not a CC break |
| Persona selector Python script missing / wrong version | FAIL | Required for routing; absence causes every task to use `auto` persona without logging |
| `NODE_ENV=production` not set in pm2 env | WARN (note, not fail) | Performance issue not a correctness break |

---

## Relationship to the duck CI test (§1)

The duck CI test (PR `feat/duck-ci-test`) is the **third Wave 5 gate requirement**
alongside B.1 (this table + `cc-health-check.sh`) and B.2 (atomic deploy).
A B.1 PASS does not guarantee the duck pipeline works; the duck test is
structurally independent and must pass on every PR.

Row 4 (Default row) and Row 16 (cwd drift) are the two rows most directly
connected to the duck failures documented in DUCK-PIPELINE-GUIDANCE.md §0:
the duck ran on Sheila's box while the health check was passing a wrong verdict.

---

*Row count: 42 enumerated rows (rows 1, 1b, 2–15, 16a, 16b, 17–28, 28b, 29–38 = 42 distinct entries) + 3 TODO rows.*
*Last updated: 2026-06-10. Redo-1 additions: Row 1 'absent' sub-case removed (superseded by Row 6 UNKNOWN — only empty/placeholder sub-cases remain as FAIL triggers); Rows 34–36 added (zombie duplicate CC apps, Sheila wrong-mount disk false-green, config-present+DB-absent PASS). Round-2 row-level fixes: 1 (narrowed), 1b (new), 16 (split into 16a/16b), 28b (5xx UNKNOWN). REDO #2: Row 35 vitest coverage added (2 tests in deep-health.test.ts — wrong-mount false-green guard proven adversarially). Round-3 fix: Row 37 added (config present with placeholder companyName + DB row absent = FAIL); closes false-green where isPlaceholder() was only evaluated when dbName !== null. REDO #1 (final) fixes: Row 31 precondition added (CC_PUBLIC_URL required for non-localhost PASS); Row 32 expanded (non-localhost + CC_PUBLIC_URL unset → FAIL, not silent PASS); Row 35 DATABASE_PATH=/data/... variant documented (resolveCheckPath WRONG_MOUNT_PREFIXES guard closes the bypass); Row 38 added (Node 18 statfsSync-absent disk UNKNOWN). 5 new vitest tests (59 total). REDO #2 (Row 32 false-green — truthy-but-invalid CC_PUBLIC_URL): Row 32 truth-table entry updated to enumerate the truthy-but-invalid CC_PUBLIC_URL trigger; `publicUrlHintInvalid` flag added in deep-checks.ts catch{}; FAIL guard widened to `(!publicUrlHint || publicUrlHintInvalid)`; 4 new vitest sub-cases ('not-a-valid-url', whitespace-only, 'http://', variant guards) proving pass=false AND indeterminate not true. Owner: B.1 PR (#78+Round-2+Redo-1+REDO-2+Round-3+REDO-1-final+REDO-2-Row32) writer.*

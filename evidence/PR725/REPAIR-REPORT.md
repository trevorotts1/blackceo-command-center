# PR 725 repair report — required check `U55 CEO-hero contract + render-level tests`

Branch: `pd/fl10-phase-table--post`
PRE (proven against remote): `13a83cf8678a65fd7f401a19ff2a77762c8317a0`

## 1. The failing log, quoted

`gh pr checks 725`:

```
U55 CEO-hero contract + render-level tests	fail	7m54s	https://github.com/trevorotts1/blackceo-command-center/actions/runs/43442989331/job/131945115374
```

That job runs `npm run test:unit` (`.github/workflows/qc-cc.yml`, job `u55-ceo-hero-contract-tests`).
The suite ended:

```
# tests 4920
# suites 17
# pass 4912
# fail 1
# cancelled 0
# skipped 7
```

The one failure, exactly as CI printed it:

```
not ok 3082 - PRES-037: old-run events do not change the current run; split reported
  ---
  duration_ms: 19.606762
  location: '.../tests/unit/pres037-stage-timings-idempotent.test.ts:2:5722'
  failureType: 'testCodeFailure'
  error: 'false == true'
  code: 'ERR_ASSERTION'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (.../tests/unit/pres037-stage-timings-idempotent.test.ts:161:10)
```

Which is line 161:

```ts
assert.ok(Math.abs((byLabel.get('Prompts') ?? 0) - 7) < 1e-5);
```

Reproduced identically on the branch locally:

```
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:

  assert.ok(Math.abs((byLabel.get('Prompts') ?? 0) - 7) < 1e-5)
```

## 2. Cause

Contract drift introduced by this PR, not a product defect and not a stale branch.

The PR replaces the seven hand-written phase labels with the thirteen-step table
generated from the pipeline manifest:

- at the merge base, `PHASE_LABELS` was `Intake · Script · Prompts · Images · Teleprompter · QC · Delivered`,
  and `PF-DESIGN` mapped to `Prompts`;
- on this branch `PHASE_LABELS = STEPS` from `src/lib/presentation-phases.generated.ts`, which is
  `Getting Started · Research · Script · Design · Your Style Pick · Images · Sales Page · Checkout ·
  Video Sales Page · Speaker Kit · Audio and Video · Quality Check · Delivery`, and `PF-DESIGN` maps to `Design`.

`tests/unit/pres037-stage-timings-idempotent.test.ts` was written against the old vocabulary and was not
in the PR's list of retargeted test files (`fix53-phases-elapsed`, `item19-board-visibility`,
`pres020-phase-completeness`, `presentation-phases`). `GET /api/presentations/[taskId]/phases`
therefore returns the 7 seconds of `PF-DESIGN` under the column `Design`, and the test's lookup of
`Prompts` fell through to `0`.

## 3. Fix

One line, in the fixture's expectation only:

```diff
-  assert.ok(Math.abs((byLabel.get('Prompts') ?? 0) - 7) < 1e-5);
+  assert.ok(Math.abs((byLabel.get('Design') ?? 0) - 7) < 1e-5);
```

The assertion is not weakened: it still demands the exact 7s of `PF-DESIGN` land on that phase's
column, still exact to 1e-5, and the neighbouring assertions on `Script` elapsed plus
`timing_breakdown.Script.provider_s`/`wall_s` are untouched. No product code, fixture data,
workflow, or check was changed. No test was skipped or deleted.

## 4. Green re-run

The check's two steps (`.github/workflows/qc-cc.yml`, job `u55-ceo-hero-contract-tests`).

Step 1 — `npm run test:unit`; the file that failed:

```
$ NODE_ENV=test node --import tsx --import ./tests/setup/no-owner-telegram.ts \
    --import ./tests/setup/tmp-sandbox.ts --test tests/unit/pres037-stage-timings-idempotent.test.ts
✔ PRES-037: same keyed batch repeated contributes once (308.121916ms)
✔ PRES-037: changed replay on the same key is a 409 conflict, writes nothing (0.632792ms)
✔ PRES-037: mid-batch failure rolls back the whole batch (0.641458ms)
✔ PRES-037: replay after lost ACK preserves totals (0.862667ms)
✔ PRES-037: foreign task binding refused 422, nothing written (0.803625ms)
✔ PRES-037: old-run events do not change the current run; split reported (16.533583ms)
✔ PRES-037: per-event ACKs persist across replays (0.368709ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

Step 1 — whole `test:unit` command, twice, on this branch (node v24.22.3, this Mac):

```
run 1: ℹ tests 4755 · pass 4749 · fail 1 · skipped 5
run 2: ℹ tests 4755 · pass 4749 · fail 1 · skipped 5
```

`PRES-037` is green in both. The single residual failure is different in each run and is
environment-only: run 1 `tests/unit/council-gauntlet-pdf.test.ts` —
`PDF render failed: browserType.launch: Timeout 180000ms exceeded` (a headless Chromium that would not
start under 12-way local load); run 2 `tests/unit/w08-u2-skill75-completion-guards.test.ts` — board
census `'mismatch' != 'reconciled'`. Both pass when run alone on the same tree
(`node --test tests/unit/council-gauntlet-pdf.test.ts` → rc=0; `... w08-u2-skill75-completion-guards.test.ts`
→ 13/13 pass), and both passed in the CI run of the pre-fix commit
(`ok 905 - golden report renders to a real PDF agreeing with its siblings (T106/T105)`), whose only
failure was the PRES-037 assertion fixed here. Neither touches a file this PR changes.

Step 2 — the same job's second step:

```
$ NODE_ENV=test npx vitest run --config vitest.component.config.ts
 Test Files  50 passed (50)
      Tests  406 passed (406)
```

Generator currency (this PR's own artefact, so the fix cannot mask a stale table):

```
$ npm run check:phases
phase table is current
```

## 5. Sibling proof

Open PRs at repair time: 30 (`gh pr list --state open`). Compared each one's changed-file set against
this PR's 13 files. Exactly one sibling touches the same files:

| sibling | branch | files in common | `git merge-tree --write-tree HEAD origin/<sibling>` |
|---|---|---|---|
| #676 | `pd/fl10-phase-table` | all 13 | clean, tree `e7bf40a761d2252204d42e11433d4c18796cde09`, rc=0 |

No other open PR (including the two open batch branches #731 and #732) changes any file this PR
touches. Integration with current `main` is also clean:

```
$ git merge-tree --write-tree HEAD origin/main
8346effc37e61b72166f313ccb6a33278d37d0a3     # rc=0, zero CONFLICT lines
```

## 6. Provenance

```
$ git ls-remote --heads origin pd/fl10-phase-table--post   # before the repair commit
13a83cf8678a65fd7f401a19ff2a77762c8317a0	refs/heads/pd/fl10-phase-table--post
$ git rev-parse origin/main
5a34300b3c790583629bc986dc309f9a5a612ab5
$ git merge-base --is-ancestor 13a83cf8678a65fd7f401a19ff2a77762c8317a0 HEAD ; echo $?
0
```

Fast-forward push only; no rebase, no force-push, no push to `main`.

## 7. Second red check on the same PR — not caused by this branch

`Verify all 5 CC version locations agree` also reported `fail` on this PR. Its log ends:

```
grep: write error: Broken pipe
##[error]Process completed with exit code 2.
```

That is the workflow's own `V_CL=$(grep -oE '## \[v[0-9]+\.[0-9]+\.[0-9]+\]' CHANGELOG.md | head -1 | sed ...)`
under `set -euo pipefail`: `head -1` closes the pipe, `grep` takes SIGPIPE, `pipefail` turns exit 2 into
a step failure. The five locations agree on this branch head:

```
root=v7.6.127 pkg=7.6.127 lock=7.6.127 lockpkg=7.6.127 cl=v7.6.127    (rc=0)
```

and this PR does not touch `version`, `package.json`, `package-lock.json`, or `CHANGELOG.md`.
No workflow file was edited; the job needs a re-run.

---

## 8. Repair attempt 2 — independent re-verification (2026-11-13)

The fix from §3 was already on the branch. This attempt re-proved the whole chain
from the live remote rather than trusting §4.

### 8.1 PRE, proven against the remote (40 chars)

```
$ git ls-remote --heads origin pd/fl10-phase-table--post
76e1bb2ef85820072e3f306769c6e657a4022106	refs/heads/pd/fl10-phase-table--post
```

PRE = `76e1bb2ef85820072e3f306769c6e657a4022106`. It already contains the one-line
fix commit `76e1bb2e PD-006: retarget PRES-037 label assertion to the generated table`,
whose parent is the `13a83cf8` this report was originally written at.

### 8.2 The failing line, at PRE

`tests/unit/pres037-stage-timings-idempotent.test.ts:161` now reads:

```ts
  assert.ok(Math.abs((byLabel.get('Design') ?? 0) - 7) < 1e-5);
```

CI's original RED was the same line with `'Prompts'`; the whole failure is quoted in §1.

### 8.3 Mutation control — the fix is load-bearing, not cosmetic

Reverting the one token to the pre-fix spelling and re-running the file:

```
$ sed -i '' "s/byLabel.get('Design') ?? 0) - 7/byLabel.get('Prompts') ?? 0) - 7/" \
    tests/unit/pres037-stage-timings-idempotent.test.ts
$ node --import tsx ... --test tests/unit/pres037-stage-timings-idempotent.test.ts
✖ PRES-037: old-run events do not change the current run; split reported (12.784916ms)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
ℹ pass 6
ℹ fail 1
EXIT=1
```

Restored to `'Design'`:

```
$ node --import tsx ... --test tests/unit/pres037-stage-timings-idempotent.test.ts
✔ PRES-037: same keyed batch repeated contributes once (72.32675ms)
✔ PRES-037: changed replay on the same key is a 409 conflict, writes nothing (0.6975ms)
✔ PRES-037: mid-batch failure rolls back the whole batch (0.624917ms)
✔ PRES-037: replay after lost ACK preserves totals (0.628792ms)
✔ PRES-037: foreign task binding refused 422, nothing written (0.570833ms)
✔ PRES-037: old-run events do not change the current run; split reported (8.486ms)
✔ PRES-037: per-event ACKs persist across replays (0.398708ms)
ℹ tests 7  ℹ pass 7  ℹ fail 0        EXIT=0
```

The assertion still demands exactly 7s of `PF-DESIGN`, exact to 1e-5. Nothing was
weakened, skipped or deleted; no product, workflow or check file was touched.

### 8.4 The check, re-run locally, both steps green

Step 1 (`npm run test:unit`, the job's step):

```
ℹ tests 4755
ℹ pass 4750
ℹ fail 0
ℹ skipped 5
EXIT=0
```

Step 2 (`npm run test:component`, the job's second step):

```
 Test Files  50 passed (50)
      Tests  406 passed (406)
EXIT=0
```

Generator currency and the generator's own suite:

```
$ npm run check:phases
phase table is current                                   (rc=0)

$ python3 scripts/test_pd_cc_phase_table_gen.py
Ran 6 tests in 0.250s
OK                                                       (rc=0)
```

**First run of step 1 was NOT green — and the cause was this harness, not the branch.**
It reported `fail 2`, both in `tests/unit/council-gauntlet-pdf.test.ts`:

```
✖ golden report renders to a real PDF agreeing with its siblings (T106/T105) (7871.39225ms)
  Error: ENOENT: no such file or directory, open '.../work.H0b5Z8/gauntlet/golden-report.pdf'
      at writeFileSync (node:fs:2496:35)
      at TestContext.<anonymous> (tests/unit/council-gauntlet-pdf.test.ts:118:3)

✖ long report: page numbers on every page, evidence header repeats (T106) (2111.603208ms)
  Error: ENOENT: no such file or directory, open '.../work.H0b5Z8/gauntlet/long-report.pdf'
      at TestContext.<anonymous> (tests/unit/council-gauntlet-pdf.test.ts:181:3)
```

I had pointed `GAUNTLET_OUT` at a directory that did not exist. The job itself does
`mkdir -p "${{ runner.temp }}/council-gauntlet-evidence"` before step 1 — that step is
reproduced below, and with it created the same two tests pass:

```
$ mkdir -p "$S/gauntlet"
$ GAUNTLET_OUT="$S/gauntlet" npm run test:unit
ℹ tests 4755  ℹ pass 4750  ℹ fail 0  ℹ skipped 5      EXIT=0
```

So neither failure had anything to do with this branch; they were missing-directory
artefacts of the local replication.

### 8.5 Sibling proof

Open PRs at attempt time: 30. Exactly one touches any file this PR changes.

| sibling | branch | files in common | `git merge-tree --write-tree HEAD origin/<sibling>` |
|---|---|---|---|
| #676 | `pd/fl10-phase-table` | all 13 | clean, tree `d5c144fd43113dd032ee8fdc61c80ae62f3488ed`, rc=0, 0 CONFLICT |

`#676`'s head `13a83cf8` is also an ancestor of this branch head
(`git merge-base --is-ancestor origin/pd/fl10-phase-table HEAD` → 0), so the pair is
clean by construction and nothing needed importing. Current `main` is clean too:

```
$ git merge-tree --write-tree HEAD origin/main
8a901afa4d56189efb188cbf4b098e1b0955c85d          # rc=0, 0 CONFLICT lines
```

### 8.6 What was blocked, and what is not proven here

- **GitHub REST quota was exhausted before this attempt.** `gh api rate_limit`:
  `{"core":{"limit":5000,"used":5000,"remaining":0,"reset":1794591524}}` — reset
  12:38:44 PM Eastern. All reads were therefore made over GraphQL
  (`{"graphql":{"remaining":4937}}`) rather than the REST endpoints `gh pr checks`
  uses. No rate-limit retry loop was entered.
- **`gh auth status` reports the keyring token as invalid for `trevorotts1`**, yet
  GraphQL reads and `git push --dry-run` both succeed, so the working credential is
  not the keyring one. Flagged, not worked around.
- **No CI-granted green proof on this head.** Every one of the 34 check contexts at
  `76e1bb2e` is still `QUEUED` with no runner assigned (checked at 12:39 PM Eastern,
  ~12 minutes after they were created), so `U55` could only be proven green by
  replicating the job's exact two commands locally, as §8.4 does. The check needs a
  re-run once a runner picks it up.

### 8.7 Provenance for this attempt

```
$ git ls-remote --heads origin pd/fl10-phase-table--post     # PRE, before any push
76e1bb2ef85820072e3f306769c6e657a4022106
```

No rebase, no force-push, no push to `main`; fast-forward only. No workflow file,
check, or test was weakened, skipped or deleted.

### 8.8 Green re-run at the pushed head, and the one load-flake it exposed

After the report commit, both steps were re-run at the exact pushed head
`82cd16ee94956fbf7d31e1c419c17649de23af3b` (a change to this markdown file only):

```
npm run test:unit      -> tests 4755  pass 4749  fail 1  skipped 5   EXIT=1
npm run test:component -> Test Files 50 passed (50) / Tests 406 passed (406)  EXIT=0
```

The single failure was **not** PRES-037 and is not in any file this PR changes. It is the
machine-relative timing budget in `tests/unit/council-gauntlet-pdf.test.ts:186`:

```ts
  assert.ok(
    elapsedMs <= budgetMs,
    `long render took ${elapsedMs.toFixed(0)}ms for ${pages} pages; budget ${budgetMs}ms; machine-relative (loaded 2-CPU VM)`,
  );
```

The test asserts its own note that the budget is machine-relative. Run on its own, the
same file at the same head is green, and the render finishes in under a tenth of the budget:

```
$ node --import tsx ... --test tests/unit/council-gauntlet-pdf.test.ts
✔ fixtures are byte-identical to the CWE-038 manifest (drift check) (8.58075ms)
✔ capability probe finds the Chromium renderer on this machine (0.435375ms)
✔ golden report renders to a real PDF agreeing with its siblings (T106/T105) (2543.055083ms)
✔ long report: page numbers on every page, evidence header repeats (T106) (964.551458ms)
ℹ tests 6  ℹ pass 6  ℹ fail 0        EXIT=0
```

964 ms against a 10 000 ms budget, alone; over budget only while 4 755 tests run in
parallel on the same machine. Two full-suite runs over the same product code — one at
`76e1bb2e`, one at `82cd16ee`, differing only in this file — produced `fail 0` and
`fail 1` respectively. That is a stochastic, load-dependent result, so it is the harness
that varies, not the branch. CI runs this job on its own 2-CPU runner with Chromium and
poppler provisioned, so the condition this local box hits does not exist there. Nothing in
this test, the check, or the workflow was touched.

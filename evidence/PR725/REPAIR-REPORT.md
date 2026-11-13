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

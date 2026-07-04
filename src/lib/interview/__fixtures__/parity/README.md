# Seam ↔ Python parity fixture (Wave 5 / P3-7)

This directory pins the **shared fixture** and the **golden outputs** that prove the
TypeScript interview seam (`src/lib/interview/seam.ts`) is byte-identical to the
onboarding Python enforcers. It closes the drift risk from the Wave 5 plan:

> P0-1 computes decision coverage / decline classification. If it reimplements
> `canonical_decline.py`'s provenance + `norm()` rules in TS and the Python later
> changes, the UI gate and the build gate diverge.

## Files

| File | Role |
|------|------|
| `input.json` | The **authored** shared input fixture (norm strings, expected-set cases, decline/coverage build-states). Read by BOTH the Python generator and the TS test. |
| `golden.json` | The **pinned** expected outputs, **derived from the real Python**. Do NOT hand-edit — regenerate. |
| `README.md` | This file. |

The test that consumes them: `src/lib/interview/__tests__/seam-parity.test.ts`
(wired into `vitest.config.ts` → runs via `npm run test:vitest`).

## Mirrored surfaces

| TS (seam.ts) | Python (openclaw-onboarding `23-ai-workforce-blueprint/scripts/`) |
|--------------|-------------------------------------------------------------------|
| `norm()` | `canonical_decline.norm` / `department-floor._norm` |
| `computeExpectedDecisionIds()` | `build-workforce._expected_decision_ids` |
| `computeDecisionCoverage()` (missing / covered) | `canonical_decline.decision_coverage` |
| `computeDecisionCoverage()` (declined / rejections) | `canonical_decline.canonical_decline_set` / `decline_rejections` |
| `noUnprovenancedDeclines()` | `canonical_decline.decline_rejections == []` |
| `golden.canonical` (fed to `computeExpectedDecisionIds`) | `list-canonical-departments.py --json` (the LIVE floor the seam shells to) |

## Regenerating the golden (when the Python changes)

```bash
# from the command-center repo root
scripts/regen-seam-parity-golden.sh /path/to/openclaw-onboarding
# (omit the path to auto-clone a fresh read-only copy)
```

`regen-seam-parity-golden.sh` **always exports a throwaway `HOME`** before touching
the Python. This is mandatory: `build-workforce.py` / `department-floor.py` resolve
their state as `/data`-else-`$HOME` and **ignore any workspace override**, so running
them against the operator's real `HOME` can corrupt `~/.openclaw` / `~/.clawdbot` /
`~/clawd`. The wrapper refuses to run unless `HOME` is a temp dir with none of those
present. After regenerating, review `git diff golden.json` — a change there is the
signal to update the UI gate alongside the enforcer — then run `npm run test:vitest`.

## Scope / known out-of-scope

The fixture exercises the **web-seam production path only**: every decision is the
OBJECT form `record-dept-decision.sh` writes (`decision`/`source`/`decidedAt`/`decidedBy`),
plus a bare-string `"no"` **without** `ownerDeclineConfirmed` (which both sides reject).

The Telegram-legacy honoring paths in `canonical_decline.analyze` —
`ownerDeclineConfirmed:true` promoting bare strings, and a flat `declinedDepartments[]`
list — are intentionally **not** exercised: the web seam only ever writes object-form
decisions, so those paths are not part of the seam's parity contract. Invalid decision
verbs (anything outside `yes`/`no`/`later`) are likewise out of scope — the script only
writes the three valid verbs.

# FIX-24 QC EVIDENCE — model-catalog truth (Error 13 / T-24)

**FIX:** CC `model_registry` row + operator catalog name the live fleet id
`deepseek-v4-flash:0731-cloud`; the string `0713` appears nowhere in the catalog.

**QC gate (Gauntlet doc FIX-24 row):** Read the CC `model_registry` row +
operator catalog for the presentation dept (python sqlite/targeted read) |
Row == `deepseek-v4-flash:0731-cloud`; the string `0713` appears nowhere in the
catalog | Evidence: the registry row + a python search of the catalog showing 0
hits for `0713` | Pre-push: re-read the registry row after merge.

---

## 1. The live CC `model_registry` row (operator box, read-only)

Command: python sqlite read of `<operator-box>/command-center/data/mission-control.db`

```
(698, 'ollama-cloud/deepseek-v4-flash:0731-cloud', 'deepseek-v4-flash:0731-cloud', 'ollama-cloud', 'deepseek', 'active', '["text","streaming","reasoning","tool_use","long_context"]', 1048576)
```

- model_id: `ollama-cloud/deepseek-v4-flash:0731-cloud`
- normalized (provider-prefix-stripped): `deepseek-v4-flash:0731-cloud`  ==  live fleet id
- status: active; context window: 1048576 (1M)
- The row was registered by `scripts/remediate/ensure-fleet-primary-model.ts --apply`
  (idempotent boot-seed upsert; see the boot-seed wiring in `src/lib/studio/generators.ts`
  `seedRegistryIfEmpty()`).

## 2. The string `0713` appears NOWHERE in the catalog

**Onboarding repo (the operator catalog + standing instructions), python scan of 6610 files:**
```
=== ONB: 0713 non-hash hits = 0; files scanned = 6610; bytes = 169363753 ===
```
Zero `0713` hits anywhere in the catalog or standing instructions.

**CC repo `model_registry` table (python sqlite):**
```
SELECT COUNT(*) FROM model_registry WHERE model_id LIKE '%0713%'  ->  0
```

**CC repo source scan (python, 1435 files):** the only `0713` occurrences are
inside the FIX-24 test file's deliberate phantom assertions/control and the
`ensureFleetPrimaryModel` docstring that describes the phantom the guard
rejects — i.e. test code and fix documentation, NOT catalog content. No catalog
row, no standing-instruction text names `0713`.

**Role-library catalog manifest (`_index.json`):** 0 non-hash `0713`/`0731`.

## 3. The retired build is no longer the presentations model

- CC `isOllamaCloudModel()` previously checked `id.includes(':cloud')`, which
  silently REJECTED `deepseek-v4-flash:0731-cloud` (the live build). Now accepts
  the `-cloud` suffix + legacy `:cloud` tag (src/lib/qc-scorer.ts).
- CC rescue tier router model pins (`fleet-heartbeat/scripts/lib/rescue-tier-router.mjs`)
  now route light/structured/medium tiers to `ollama/deepseek-v4-flash:0731-cloud`.
- Onboarding catalog: 26 standing-instruction files now name
  `deepseek-v4-flash:0731-cloud` instead of the retired `:cloud` build
  (model_selector.py lineups, role-library docs, skill-38 templates/scripts,
  deprecated-models.json, generate-role-library.py, HEARTBEAT.md).

## 4. Tests

- `tests/unit/fix24-model-catalog-truth.test.ts` — 8/8 pass:
  presentations model resolves to 0731-cloud; `0713` absent from catalog;
  resolveSettings picks the 0731 row for a presentation task; connector
  normalizes to the live id; control scan detects a seeded phantom;
  boot-seed registers the live id idempotently; `isOllamaCloudModel` accepts
  the live build.
- Related CC suites 42/42 pass (fix15, p1-05, qc-judge, u62 via vitest 11/11,
  rescue-tier-router 10/10).
- Onboarding `tests/unit/model-selector-capability-class.test.py` 19/19 pass;
  `model_selector.py --self-test` all 14 assertions PASSED + 440-role index
  coverage 100%.

## Commits

- CC: `a9a3827` (branch `gl3/fix-fix24-cc`)
- Onboarding: `7ae19211` (branch `gl3/fix-fix24-onb`)

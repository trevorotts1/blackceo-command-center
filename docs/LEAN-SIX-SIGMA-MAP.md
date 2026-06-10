# Lean Six Sigma (LSS) Alignment Map

**PRD 2.14 — BlackCEO Command Center**

This document maps each DMAIC stage to the concrete mechanisms implemented in
this repository, plus an explicit gap list with implementation status.

---

## DMAIC → System Mechanisms

### Define — Establish standards and targets before work begins

The "Define" gate is where ZHC clients establish what "good" means for each
department before any task or agent is dispatched.

| Mechanism | Where in the system |
|---|---|
| 30-question onboarding interview (Skill 23) | Produces role-doc Tier-1 KPI targets seeded into `kpi_snapshots` |
| Role-doc Tier-1 targets | `kpi_snapshots.target` — the graded "good enough" boundary for KPI attainment |
| SOP library per department | `sops` table; each task carries `sop_id` for standard-work traceability |
| QC pass threshold (8.5/10 gate) | `QC_PASS_THRESHOLD` in `qc-scorer.ts` — the operationally defined defect boundary |

**LSS linkage:** Define = the voice of the customer (owner) translated into
measurable operational targets. The onboarding interview IS the Define phase.
Without seeded KPI targets, `kpiAttainment` returns `null` with a specific
"No role-doc KPI targets seeded yet" detail — the insufficient-data state
makes the missing Define step visible to the operator.

---

### Measure — Capture data on process performance

The "Measure" stage is where real data is collected continuously with no
fabricated or seeded placeholder values.

| Mechanism | Where in the system |
|---|---|
| `grading.ts` — `computeDepartmentGrade` | Four DB-grounded inputs per department |
| Throughput | `tasks.status='done'` vs `created_at` in rolling window |
| QC Pass Rate | `task_qc_results` (LLM-scored only; heuristic excluded per PRD 2.4) |
| SOP Coverage | `events` (task_dispatched) joined to `tasks.sop_id` |
| KPI Attainment | `kpi_snapshots` latest value vs target |
| **Defect rate** (PRD 2.14) | Complement of QC pass rate: `(failed LLM rows / total LLM rows) × 100` |
| **Rework rate** (PRD 2.14) | `DISTINCT task_id WHERE MAX(attempt) > 1` / total QC'd tasks |
| **Stale loops killed** (PRD 2.14) | Tasks blocked at QC reroute cap (`status='blocked'`, `qc_reroute_attempts >= 3`) |

**Insufficient-data discipline (HARD RULE):** Every computed metric returns
`score: null` below its minimum sample floor — never 0, never a fabricated
number. `null` renders as "no data" in the UI. This ensures the dashboard
never misleads with fake signal.

---

### Analyze — Surface root causes and patterns

| Mechanism | Where in the system |
|---|---|
| Per-dept grade + failing input | `computeCompanyHealth` → `worstTrending` (up to 3 depts with lowest delta) |
| SOP learning loop | `src/lib/sop-learning.ts` + nightly cron — clusters un-SOP'd completed tasks |
| General task recurrence | `src/lib/jobs/general-task-recurrence.ts` — Sunday sweep; dept-creation recommendations |
| QC review sweep | `src/lib/jobs/qc-review-sweep.ts` — catches tasks left in `review` without scoring |
| Defect / rework rates per dept | `computeDefectRate`, `computeReworkRate` in `grading.ts` — surfaced alongside grade |

---

### Improve — Close the loop and reduce defects

| Mechanism | Where in the system |
|---|---|
| QC reroute loop | `qc-scorer.ts`: LLM-fail → `[QC-FAIL]` → task returned to backlog with gap notes |
| Self-healing SOPs (PRD 2.12) | `src/lib/jobs/sop-authoring-loop.ts` — authoring triggered at dispatch when no SOP |
| SOP proposals queue | `/sops/proposals` — human-gated; each proposal QC-stamped before approval |
| Recommendations table | `recommendations` — surfaced on Performance board; CEO-visible action items |
| CEO delegation sweep | `ceo-delegation-sweep.ts` — routes orphaned tasks to the correct department |

---

### Control — Maintain the gains and detect regression

| Mechanism | Where in the system |
|---|---|
| 8.5 QC gate (always-on) | `QC_PASS_THRESHOLD` constant; every completed task scored on the `review` path |
| 3-attempt block guard | `QC_MAX_REROUTES=3`: tasks that can't pass after 3 reroutes are `[QC-BLOCKED]` |
| **Monthly control review** (PRD 2.14) | `src/lib/jobs/lss-control-review.ts` — 1st of month, 08:00 ET |
| Control review artifacts | Row in `lss_control_reviews`; `[LSS-CONTROL-REVIEW]` event in Live Feed; |
| | `recommendations` upsert when company grade drops month-over-month |
| `lss_control_reviews` table | Auditable monthly history of company/dept LSS state |

---

## Gap List

Every item below is marked with its implementation status and the reason for
any waiver. "Implemented" means code ships in this PR and tests verify it.
"Waived" items have been explicitly evaluated and excluded with documented
reasons — they are not deferred or forgotten.

| Gap / Requirement | Status | Evidence / Reason |
|---|---|---|
| Defect rate per department | `[IMPLEMENTED]` | `computeDefectRate` in `grading.ts`; surfaced in `DepartmentGradeCards`; tested T1–T2 |
| Rework rate per department | `[IMPLEMENTED]` | `computeReworkRate` in `grading.ts`; surfaced in `DepartmentGradeCards`; tested T3–T4 |
| Stale-loops-killed waste metric | `[IMPLEMENTED]` | `computeStaleLoopsKilled` in `grading.ts`; always an integer; tested T4–T5 |
| Tokens-per-task waste metric | `[WAIVED — bridge emits no per-task token counts]` | `provider_usage` is account-aggregate; fabricating a per-dept number would violate the no-lies rule. `tokensPerTask` returns `null` with an explanatory detail string. When `task_activities.metadata` carries token counts, the probe activates automatically (tested T6). Active waste proxy = `staleLoopsKilled`. |
| Monthly control review mechanism | `[IMPLEMENTED]` | `lss-control-review.ts`; registered in `scheduler.ts`; `lss_control_reviews` table; Live Feed event + recommendations drop; tested T9 |
| SPC control charts / Cp / Cpk indices | `[WAIVED — gold-plating]` | Not justified by the PRD audit scope. Would require a time-series model beyond the current rolling-window architecture. |
| Sigma-level computation | `[WAIVED — gold-plating]` | Requires process sigma table (DPMO → sigma) and per-process opportunity count definition. Not justified by audit. |
| Defect/rework as graded inputs (weighted score) | `[WAIVED — double-counting]` | `qcPassRate` already carries the QC defect signal into the 2.10 letter grade. Adding defect rate to `DEFAULT_INPUT_WEIGHTS` would double-count QC and silently shift every client's company score. Defect/rework are reported diagnostics only. |
| New "Six Sigma" dashboard page | `[WAIVED — scope guard]` | Not justified by audit. LSS metrics surface on the existing Performance board cards. |

---

## Design Decisions

### Defect rate is NOT a graded input

`qcPassRate` already encodes the defect signal in the 2.10 weighted formula.
Adding `defectRate` to `DEFAULT_INPUT_WEIGHTS` would be double-counting.
The grade (A–F) is derived from the four 2.10 inputs; defect/rework/waste are
a LSS lens layered on top for operator insight without affecting the score.

### Tokens-per-task is honestly null

The only token table in the schema is `provider_usage` (account-aggregate;
`provider, metric, value, snapshot_at`). Dividing a monthly provider total by
task count would produce a fabricated per-department figure with no causal link
to individual tasks. `tokensPerTask` is `null` with the reason
"bridge does not emit token counts" until the OpenClaw bridge is updated to
emit token counts into `task_activities.metadata`. The `computeTokensPerTask`
probe activates automatically when metadata is present — no code change needed.

### Stale loops killed is always an integer

Tasks blocked at the `QC_MAX_REROUTES` cap never get `completed_at` set
(the `trg_tasks_completed_at` trigger only fires on `status='done'`). The window
predicate uses `updated_at` — the column that IS stamped when the task is
blocked. A real zero (`staleLoopsKilled = 0`) is honest and correct; it is NOT
rendered as "no data."

---

*Last updated: PRD 2.14 implementation — 2026-06-10*

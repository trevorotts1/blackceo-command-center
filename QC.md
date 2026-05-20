# Command Center — Quality Control

Per the 10-point v9.3.0 standard rubric used across OpenClaw skills, adapted
for a deployed Next.js dashboard rather than an install-time skill.

This file is for the QC agent (independent of the installer). When the
dashboard is updated, build, or released, this rubric is the gate. Score
yourself honestly.

---

## Rubric (out of 10)

| Section | Points | Item |
|---------|--------|------|
| **1**   | 1.0    | Prerequisites + dashboard prerequisites verified |
| **2**   | 1.0    | All .md root files read before changes (TYP compliance) |
| **3**   | 1.5    | package.json `version` + `version` file agree |
| **4**   | 1.0    | All 17 canonical departments present in `config/departments.json` and `src/lib/routing/departments.config.ts` (no Operations/Creative/HR/IT drift) |
| **5**   | 1.5    | All 23 agents have the 7 ZHC files (4 unique + 3 symlinks). `find agents -type l | wc -l` reports 69 |
| **6**   | 1.0    | `agents/_shared/{AGENTS,TOOLS,USER}.md` exist and are real files (symlink targets) |
| **7**   | 1.5    | All migrations 001-021 present in `src/lib/db/migrations.ts` (no numbered gaps) |
| **8**   | 0.5    | No Anthropic model references in non-orchestrator code |
| **9**   | 0.5    | `npm run build` exits zero |
| **10**  | 0.5    | `qc-cc.sh` exits zero |

Total: 10.0

Gate: **≥ 8.5 to ship**. Below 8.5 → list failures and retry.

---

## Self-Audit Checklist

Before claiming PASS:

- [ ] INSTALL-CONTRACT (root) read in full this session
- [ ] All root .md files read before changes
- [ ] Steps performed in declared order
- [ ] Score above honest (no rounding up; report deductions)
- [ ] `qc-cc.sh` actually ran and exited zero (not assumed)
- [ ] No shortcuts (e.g., bypassed migration, suppressed lint, skipped tests)
- [ ] Owner notified of completion with a one-paragraph summary

---

## Failure Loop

If score < 8.5:
1. List every gate that failed (which row in the rubric)
2. Fix each failure
3. Re-score from scratch (don't carry prior numbers)
4. Hard cap: 5 retry loops. After loop 5, escalate to owner via Telegram with
   structured report: `{run_id, attempts, lowest_score, blocker, ask}`.

---

## What This QC Catches

This rubric exists specifically to catch the failures the 2026-05-19 analysis
identified. If any of the following regress, the matching rubric item should
fail and bring the total below 8.5:

| Regression | Rubric item fails | Why it matters |
|------------|-------------------|----------------|
| Operations/Creative/HR/IT reappear in departments | #4 | N17 binary gate violation |
| Symlink count drops below 69 in agents/ | #5 | N19 ZHC layout |
| `_shared/AGENTS.md` becomes a symlink itself (loop) | #6 | Breaks every agent |
| Migration 008 gap reappears | #7 | DB schema drift |
| `claude-*` / `anthropic/*` model id in code | #8 | Cost policy |
| Build fails after dep upgrade | #9 | Smoke check |

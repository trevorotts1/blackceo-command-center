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
| **4**   | 1.0    | All 18 canonical departments present in `src/lib/routing/departments.config.ts` (the source of truth — no Operations/Creative/HR/IT drift); `config/departments.json` is a valid array (ships empty `[]` per v4.0.3 and is regenerated per-client) with schema-valid entries |
| **5**   | 1.5    | All 23 agents have the 7 ZHC files (4 unique + 3 symlinks). `find agents -type l | wc -l` reports 69 |
| **6**   | 1.0    | `agents/_shared/{AGENTS,TOOLS,USER}.md` exist and are real files (symlink targets) |
| **7**   | 1.5    | All migrations 001-021 present in `src/lib/db/migrations.ts` (no numbered gaps) |
| **8**   | 0.5    | No hardcoded Anthropic model id as an inference target in non-orchestrator business logic. Exempt: the orchestrator layer, `model-providers/anthropic.ts` (emits Claude family *labels* for the UI), and `web-agent/runner.ts` (built on the Anthropic Messages-API tool-use protocol; model id is env-overridable via `WEB_AGENT_MODEL`) |
| **9**   | 0.5    | `npm run build` exits zero |
| **10**  | 0.5    | `qc-cc.sh` exits zero |
| **11**  | 1.0    | Blocked-column gate (N36): migration 071 present in `src/lib/db/migrations.ts`; `src/app/api/tasks/[id]/route.ts` PATCH rejects status=blocked without blocked_reason/blocked_on_human/ask (HTTP 400); `src/app/api/tasks/[id]/return-to-orchestrator/route.ts` exists; `stale-task-sweep` registered in `src/lib/jobs/scheduler.ts` JOBS[]. Auto-fail if any of the four is missing. |
| **12**  | 1.0    | Artifact-mandatory invariant (design item #10 root-cause fix): `src/lib/qc-scorer.ts` detects artifact tasks via `isArtifactTask`; when zero deliverables are registered the scorer calls return-to-orchestrator (NOT Mode-B description re-score, NOT blocked); Mode-B is explicitly guarded to confirmed non-artifact tasks only. `qc-blocked-gate.sh` assertions 7 and 8 enforce both invariants. Auto-fail if `isArtifactTask`, `no artifact registered`, `fileRows.length === 0`, or `Mode B: document/work task (confirmed non-artifact)` are absent from qc-scorer.ts. |

Total: 11.0

Gate: **≥ 9.35 to ship** (same ≥8.5/10 fractional threshold, now denominator 11). Below 9.35 → list failures and retry.

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
| New hardcoded `claude-*` / `anthropic/*` model id in non-exempt `src/lib` business logic | #8 | Cost policy |
| Build fails after dep upgrade | #9 | Smoke check |
| Artifact task with zero deliverables falls through to Mode-B description re-score | #12 | Root-cause of false-blocked bug (design item #10) |
| `isArtifactTask` guard removed from qc-scorer.ts | #12 | Reverts fix #10, re-enables false-done loop |

---

## Whole-app Responsive Audit Program (U54 / spec crosswalk HL-U69)

`qc-cc.sh` section 15 wires a four-stage, ledgered, resumable responsive
audit that extends `scripts/dev-shots.mjs`'s existing invocation to EVERY
Next.js App Router page route — mechanically discovered from
`src/app/**/page.tsx` at run time, so a new page can never silently escape
the audit (the harness's old default list covered 7 of 38+ routes).

- **Stage 1 — inventory freeze:** `scripts/responsive-route-inventory.mjs`
  (`npm run audit:responsive:inventory`). Discovers every route and resolves
  dynamic segments (`[dept]`, `[id]`, `[slug]`, `[[...token]]`) to one pinned
  fixture per route, from a live seeded DB when reachable, else an honest
  `unresolved: true` — never a fabricated value.
- **Stage 2 — measure:** `scripts/responsive-audit.mjs`
  (`npm run audit:responsive`). Invokes `dev-shots.mjs` once per resolved
  route against a live server, persisting one ledger file per
  route/breakpoint (`$TMPDIR/skill6-u54-responsive/responsive-<route>-<bp>.json`)
  plus a consolidated `responsive-ledger.json`, so an interrupted run resumes
  without re-shooting already-ledgered routes. **Requires a live, seeded
  Next.js server — this real run happens on the operator's own box first,
  never a client box.**
- **Stage 3 — fix in waves (by defect class, not by page):** wave A
  (`horizOverflow > 0`), wave B (non-empty `clipped`), wave C (interactive
  affordances hidden below a breakpoint with no documented mobile
  substitute). Each wave is its own merge with a stage-2 re-run as its QC.
- **Stage 4 — gate:** `scripts/responsive-gate.mjs`
  (`npm run audit:responsive:gate`), wired into `qc-cc.sh` 15.6. The wave-C
  static scan (which `hidden sm:*`/`hidden md:*` classes sit on an
  interactive element without an adjacent `mobile-substitute:` comment) runs
  unconditionally against source on disk — no live server needed. The
  ledger half (zero `horizOverflow`, zero `clipped`) requires the stage-2
  baseline; until that baseline exists, 15.6 warns (never a silent pass)
  rather than failing a fresh clone / CI box that has never run a live
  audit.

**Status as of this unit's merge:** the four-stage mechanism (stages 1, 2,
4) is real, tested, and wired. Stage 3's fixes and the first live stage-2
baseline are the owed operator-box leg — they require an actual seeded,
running build and (for wave C's semantic judgment calls) screenshot review,
neither of which a code-only merge can fake.

# Command Center — Quality Control

Per the 10-point v9.3.0 standard rubric used across OpenClaw skills, adapted
for a deployed Next.js dashboard rather than an install-time skill.

This file is for the QC agent (independent of the installer). When the
dashboard is updated, build, or released, this rubric is the gate. Score
yourself honestly.

---

## 🔴🔴🔴 FLEET-REPO CONTENT RULE — what may NOT go in this repo (AUTHORITATIVE, 2026-07-11) 🔴🔴🔴

**READ THIS BEFORE AUTHORING ANY REPO CONTENT.** The command-center repo is FLEET-WIDE — it is cloned to every client box. Exactly **THREE** things are enforceable here, and **nothing else**:

1. **No CLIENT / ROSTER MEMBER real human names.** An actual customer or an actual team member. **NOT** book characters. **NOT** personas. **NOT** authors of referenced works.
2. **No genuine secrets** — live tokens, API keys, `pit-` GHL tokens, bot tokens, private keys. **ABSOLUTE. This one never relaxes.**
3. **Nothing built for ONE client.** Repo content stays generic and fleet-reusable.

### ✅ EXPLICITLY EXEMPT — never flag, block, or scrub these

- Cloudflare Access Application UUIDs / AUD tags
- **Telegram chat IDs**
- **GHL location IDs**
- Any **opaque identifier** — UUID, numeric ID, hash
- **Book titles**
- **Persona names derived from books**
- **Authors of referenced works**
- **Product proper nouns**

> **GOVERNING PRINCIPLE: opaque infrastructure identifiers and product content are NOT the target.**
> A UUID is not a person. A book author is not a customer. A chat ID is not a secret.

### ⛔ NEVER ENFORCE THE NAME RULE WITH A GREP / REGEX / NAME-ROSTER

A pattern match **cannot** tell a client's real name from a book-persona name. It will either miss real leaks or block legitimate product PRs forever — and it has already done both. Do not "fix" a missed name by widening a regex, and do not add an identifier scan pass to any guard.

- **Names → LLM review.** The authoritative name check is `scripts/qc-llm-diff-review.py`, run on every PR by `.github/workflows/qc-llm-diff-review.yml`. It reads the diff's added lines and blocks on the three rules above. It **fails closed**: reviewer error, malformed response, API error, or timeout is a **BLOCK**.
- **Secrets → regex is correct.** A secret has a literal shape; a human name does not. The reviewer runs a `pit-`/token secret regex pre-filter in addition to the model.
- The legacy shell gates (`qc-assert-no-client-names.sh`, `qc-blocked-gate.sh` Assertion 5) survive only as a cheap always-on scan for the operator machine path and `.example` placeholder leaks. Their roster is **human names only** — `client-roster-lib.sh` filters opaque identifiers out at load time.

### History — why this section exists

The guard scripts once encoded an over-broad rule: a chat-ID denylist, an identifier scan pass, and a roster accessor that swept GHL location IDs in as scan terms. The **correct** rule lived only in the operator's head while the **wrong** rule lived in the code, so every fresh agent re-derived the wrong rule from the guards' own comments and repeated the mistake. That is why the rule is written **here**, where an agent authoring repo content actually reads it.

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

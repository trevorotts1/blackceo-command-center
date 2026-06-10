# SOP Layers — the Command Center DB library vs the on-disk role library

The BlackCEO platform carries **two SOP libraries**. They were built for
different purposes, are keyed differently, and historically shared no key. This
doc explains both, why they exist, and how the **role-library bridge** (v4.3.0)
keeps the Command Center board reflecting what the agents actually run.

---

## Layer 1 — Command Center "starter" SOP library (DB)

- **Where:** the `sops` table in the Command Center SQLite DB.
- **Source of truth:** `src/lib/sops-seed.ts` (`STARTER_SOPS`) — 23 starter SOPs,
  one per default Skill-23 department.
- **Seeded by:** `seedStarterSOPs(db)` on first-boot DB init
  (`src/lib/db/migrations.ts`) and the manual `npm run db:seed:sops`
  (`scripts/seed-starter-sops.ts`). Idempotent on `slug`.
- **Keyed by:** `department` (no role). Each starter SOP carries a department
  slug and `task_keywords`.
- **Consumed by:** the Triad Rule. `scoreSOPForTask` (`src/lib/sops.ts`) matches
  a task to a SOP by **department exact match (+0.5)** + keyword overlap, and
  `checkTriad` blocks a task from leaving backlog unless it has a description, a
  valid non-deleted SOP, and a persona.
- **Purpose:** give every fresh client box a working SOP board + Triad gate on
  day one, before any role-specific procedures are authored. Never touches disk.

Two more DB-side mechanisms write into `sops` / `sop_proposals`:

- **Learning loop (nightly auto-writer):** `detectPatternsAndPropose()`
  (`src/lib/sop-learning.ts`) clusters recurring un-SOP'd completed tasks and
  drafts candidate proposals for review. Runs nightly via the in-process
  `sop-learning` cron job (`src/lib/jobs/scheduler.ts`).
- **Triad auto-draft:** when the Triad Rule blocks a task for a missing SOP,
  `proposeDraftFromTask()` pre-fills a draft proposal from the task so the dept
  head has something concrete to approve. Surfaces in `/sops/proposals`.
- **Auto-research replace (Track S):** `src/lib/sop-auto-replace.ts` researches
  and drafts a v2 when an operator deletes a SOP.

All of these are **hand-authored / generated** SOPs and carry `source IS NULL`.

---

## Layer 2 — On-disk per-role SOPs (Skill-23 role library)

- **Where:** the client's workspace tree, emitted by the ZHC build:

  ```
  <workspace>/departments/<dept>/<NN-role-slug>/how-to.md
  ```

  Each role folder also carries `IDENTITY.md`, `SOUL.md`, `MEMORY.md`,
  `HEARTBEAT.md`, and a `SOP/` subfolder.
- **Built by:** `build-workforce.py` + `create_role_workspaces.py` +
  `post-build-role-workspaces.py` in the `openclaw-onboarding` /
  `openclaw-onboarding-vps` Skill-23 (`23-ai-workforce-blueprint`). The
  `how-to.md` is instantiated from the pre-written role-library when a template
  matches, else a stub.
- **Keyed by:** the on-disk directory structure itself — `department` → `role`.
  Genuinely role-resolved (one how-to.md per role folder).
- **Consumed by:** the agents at runtime. A department director dispatches a
  task to a role; the role reads its own `how-to.md` / `SOP/` **before acting**
  (read-first contract).
- **Purpose:** the actual operating procedures the AI workforce executes.

---

## The disconnect (pre-v4.3.0)

The two layers shared no key. An operator browsing the Command Center SOP
library saw the 23 generic department starter SOPs, while the agents on disk
operated from a different, larger, role-specific set. Nothing synced them, and
the DB `sops` table had no `role` column to even represent which role owned a
SOP.

---

## The bridge (v4.3.0) — Layer 2 → Layer 1

`src/lib/role-library-import.ts` ingests the on-disk role library into the CC
`sops` table so the board reflects what the agents run.

### What it does

1. Walks `<departments>/<dept>/<NN-role>/how-to.md`.
2. Parses each: title → SOP name; Section-9 (or body) headings → steps; role +
   department + role-slug tokens → keywords.
3. **Upserts** into `sops` tagged:
   - `department` = dept folder slug
   - `role` = role folder slug (numeric `NN-` prefix stripped) — migration 050
   - `source = 'role-library'` — migration 050
4. Stable key **`slug = role-library:<dept>/<role>`**.

### Safety contract

- **Idempotent / never duplicates:** re-running upserts the same row by slug
  (UPDATE on hit, INSERT on miss).
- **Never deletes user-authored SOPs:** only rows with `source='role-library'`
  are ever written or replaced. Starter, hand-authored, learning-loop, and
  auto-research SOPs (`source IS NULL`) are untouched. If a `role-library:` slug
  is somehow owned by a non-role-library row, the importer skips it.
- **Pruning is opt-in** (`prune_missing`) and still only soft-deletes
  `source='role-library'` rows that no longer exist on disk.

### How to trigger it

- **API:** `POST /api/sops/import-role-library`
  ```json
  { "departments_path": "/abs/path/.../departments", "prune_missing": false }
  ```
  All fields optional. `GET` reports the path it would scan without writing.
  Honors `CRON_SECRET` (`?token=` or `Authorization: Bearer`) like the other
  cron routes.
- **CLI:** `npm run db:import:role-library [departmentsPath] [--prune]`
  (`scripts/import-role-library.ts`).

### Path resolution (when not given explicitly)

1. `departments_path` argument / positional CLI arg
2. `ROLE_LIBRARY_PATH` env var
3. `<OPENCLAW_WORKSPACE_PATH>/departments`

---

---

## Layer 3b — Dispatch-time fast-loop authoring (custom departments only)

- **Introduced:** PRD 2.12-cc (v4.27.0)
- **Where:** `src/lib/sop-authoring.ts`, invoked from `src/lib/task-dispatcher.ts`
- **Trigger:** a task dispatches to a **custom** (non-ZHC-canonical) department with
  NO SOP match above the 0.5 threshold.
- **Canonical departments (24 ZHC slugs) → REFUSED.** The guard is absolute. The
  build gate (`scripts/qc-cc.sh §9`) asserts this in source. Canonical depts use
  `copyCanonicalSOPForTask` to pull from the `role-library` instead (near-zero tokens).
- **Custom departments → authored.** Flow:
  1. Safety cap (≥3 attempts / 7 days → escalate via Telegram, file `escalated` proposal).
  2. Linked "Author SOP" sub-task created, routed to the dept's **research specialist**
     (`role_type='research'`, resolved by `resolveTrioAgents`). The original task is
     HELD in `backlog` until the SOP is filed.
  3. Tavily research under the **Tier-1 mandate** (McKinsey / HBR / IBISWorld / Statista).
  4. Gemini synthesis → `parseDraftedSOP`.
  5. QC gate at **8.5** via `scoreTaskForQC` (per-dept QC agent). Heuristic (no LLM key)
     → file as `pending` proposal for human review, never auto-file.
  6. On QC pass: file to BOTH stores simultaneously:
     - **DB (`sops` table):** `source = NULL` (critical — NOT `'role-library'` — so the
       role-library importer never clobbers it and the canonical guard never mistakes it
       for a library copy). An audit-trail `sop_proposals` row with `status='auto-authored-filed'`
       carries `research_sources` + `confidence`.
     - **Disk (`<OPENCLAW_WORKSPACE_PATH>/departments/<dept>/<role>/how-to.md`):** the
       permanent on-disk procedure so agents read it at runtime. Gated by
       `SOP_AUTHORING_WRITE_DISK !== '0'`. DB row always files even if disk write fails
       (loud `sop_disk_write_failed` event).
  7. `sop_id` attached to the original task; sub-task marked `done`.
  8. Original task dispatch re-fired via `autoDispatchTask(originalTaskId, 'sop-authored-resume')`.

- **`sop_authoring_for_task_id` column (migration 066):** links the authoring sub-task
  back to the original task. The dispatch fast-loop recursion guard skips authoring for
  any task with this column set (infinite-recursion prevention).
- **Slow loop unchanged:** `detectPatternsAndPropose` clustering/dedup logic is
  unmodified. PRD 2.12 adds QC verdict tagging (`[QC-PASS <score>]` /
  `[QC-FAIL <score> — needs rework]`) to each pending proposal so the `/sops/proposals`
  queue surfaces a quality signal to the operator. The slow loop NEVER auto-files —
  it remains human-gated as the catch-all safety net.

### Key invariants

| Property | Value |
|---|---|
| `source` for authored SOPs | `NULL` (never `'role-library'`) |
| Canonical dept authoring | REFUSED (copy from library instead) |
| QC threshold | 8.5 LLM score; heuristic → pending for human |
| Recursion guard | `sop_authoring_for_task_id IS NOT NULL` → skip fast loop |
| Kill switch | `DISABLE_SOP_FAST_LOOP=1` |
| Disk write guard | `SOP_AUTHORING_WRITE_DISK=0` disables disk write (tests) |

---

## Quick reference

| | Layer 1 (DB) | Layer 2 (disk) | After bridge | Layer 3b (fast loop) |
|---|---|---|---|---|
| Lives in | `sops` table | `departments/<dept>/<role>/how-to.md` | `sops` rows w/ `source='role-library'` | `sops` + disk |
| Keyed by | `department` | dept → role folders | `department` + `role` | `department` + `role` |
| `source` | `NULL` | n/a | `'role-library'` | `NULL` |
| Authored by | seed / learning loop / operator | Skill-23 build | imported from disk | dispatch-time fast loop |
| Synced? | — | — | `POST /api/sops/import-role-library` | automatic on dispatch |
| Canonical guard | — | — | n/a | REFUSED (copy instead) |

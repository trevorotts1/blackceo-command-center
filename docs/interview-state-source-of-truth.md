# Interview State — Canonical Source of Truth (U013)

**Status:** normative — every dashboard, fleet view, and API route that reports
interview state MUST follow this document.

---

## The canonical source is the FILES, not the database

The AI Workforce interview keeps its authoritative state on disk, in the
OpenClaw workspace tree. Three files are canonical:

| File | What it holds |
|------|---------------|
| `<workspace>/.workforce-build-state.json` | Interview progress, completion, QC status, decisions, session id |
| `<workspace>/company-discovery/workforce-interview-answers.md` | The Q/A transcript (every question asked, every answer given) |
| `<workspace>/company-discovery/interview-handoff.md` | Resume position, skipped questions, synthesis |

The workspace root resolves per host: `/data/.openclaw/workspace` (VPS/Docker)
or `$HOME/.openclaw/workspace` (Mac/bare install), with `OPENCLAW_WORKSPACE_ROOT`
as the env override. See `src/lib/interview/paths.ts` for the exact resolution.

## The DB tables are a READ-MIRROR — they can be empty

`interview_sessions` and `interview_answers` (migration 087) are a **best-effort
read-mirror** over the files, created so the UI can render a fast index without
re-parsing the transcript on every request. They are:

- **Populated only by the mirror-on-write sync** (`src/lib/interview/mirror.ts`),
  which runs after canonical file writes and on `/api/interview/state` reads.
- **Never a write authority.** If the mirror and the files disagree, **the files
  win.** The mirror never decides `interviewComplete` and never records decisions.
- **Frequently empty (0 rows)** on boxes where the interview completed before
  the mirror existed, where the mirror sync was skipped, or where the interview
  ran entirely through the Telegram agent. **An empty `interview_sessions` table
  does NOT mean "no interview."**

> **TRAP:** any dashboard that queries `interview_sessions` directly will falsely
> report "no interview" for clients whose interview state lives only in the
> canonical files. The fleet dashboard (U009) and every future view MUST NOT
> fall into this trap.

## The sanctioned read path: `/api/interview/state`

Fleet and dashboard code MUST call **`GET /api/interview/state`** per client
(`src/app/api/interview/state/route.ts`). That route:

1. Reads the canonical FILES through the P0-1 seam (`src/lib/interview/seam.ts`) —
   build-state, transcript, and handoff.
2. Computes the three gate flags (`genuineTranscriptReady`,
   `decisionCoverageComplete`, `noUnprovenancedDeclines`) from the files.
3. Returns progress, resume position, transcript facts, and decision coverage —
   all derived from the canonical source.
4. Refreshes the DB mirror as a side effect (best-effort, never gates).

For the review read-back (grouped Q/A), call `GET /api/interview/answers`.
For the durable transcript document, call `GET /api/interview/answers/export`.

## Inventory of direct `interview_sessions` accessors in `src/`

Every file that touches the mirror tables directly carries an annotation
comment pointing back to this document. As of U013:

| File | Access | Why it is safe |
|------|--------|----------------|
| `src/lib/interview/store.ts` | Defines the mirror upsert/get/list helpers | The mirror module itself — annotated with the files-win doctrine |
| `src/lib/interview/mirror.ts` | Syncs the mirror FROM the files | Reconciles mirror ← files, never the reverse |
| `src/lib/db/migrations.ts` | `CREATE TABLE` DDL (migration 087) | Schema definition only; annotated |
| `src/app/api/interview/answer/route.ts` | Triggers mirror refresh after a canonical write | Mirror-on-write; the canonical write is the transcript append |
| `src/app/api/interview/state/route.ts` | Triggers mirror refresh on read; returns file-derived state | The sanctioned read path itself |
| `src/app/api/departments/route.ts` | `getSession()` for the session id on a decision write | Reads a mirror row for a stable id; the decision itself is written through the Skill-23 script to the canonical files |
| `src/lib/jobs/interview-nudge-sweep.ts` | `getSession()` for nudge bookkeeping | Reads progress from the FILES (seam); the mirror row is a secondary signal only |

No other code in `src/` queries `interview_sessions` or `interview_answers`
directly. New code MUST NOT — use `/api/interview/state` (or the seam readers
in server-side code) and add any new accessor to this inventory.

## Rules for future views

1. **Never** `SELECT` from `interview_sessions` / `interview_answers` to decide
   whether an interview exists or is complete.
2. **Always** call `/api/interview/state` (client-side) or the seam readers
   (`readBuildState` / `readAnswers` / `readHandoff` — server-side).
3. If you must read the mirror (e.g. for a fast UI index), treat it as a cache:
   a missing row means "unknown," never "no interview."
4. Document any new direct accessor in the inventory table above.

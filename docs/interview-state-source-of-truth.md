# Interview State Canonical Source of Truth

**Purpose:** Establish definitively where interview state lives so no dashboard, fleet view, or future component queries the wrong source and falsely reports "no interview."

**Unit:** U013
**Created:** 2026-07-23
**Repository:** blackceo-command-center (Lane B)
**Finding:** MASTER-SPEC item #13

---

## 1. The Rule

The canonical source of interview state is the filesystem, not the database.

Any code consuming interview state MUST go through the API endpoint `/api/interview/state` per client. Direct queries of the `interview_sessions` and `interview_answers` database tables will produce false negatives -- those tables are a best-effort read-mirror that may have 0 rows even while a real interview is in progress.

---

## 2. Canonical Files (Single Source of Truth)

These files are written exclusively through Skill-23 shell scripts (`update-interview-state.sh`, `record-dept-decision.sh`). They are the only authority for interview state.

| File | Contents | Resolved via |
|------|----------|-------------|
| `<workspace>/.workforce-build-state.json` | Session id, progress stamp, interviewComplete flag, decision provenance | `resolveWorkspaceDir()` in `src/lib/interview/paths.ts` |
| `<workspace>/company-discovery/workforce-interview-answers.md` | Q/A transcript blocks (append-only, Skill-23 `log_answer`) | `answersFilePath()` in `src/lib/interview/paths.ts` |
| `<workspace>/company-discovery/interview-handoff.md` | Resume position (current question, skip list, status) | `handoffFilePath()` in `src/lib/interview/paths.ts` |

Path resolution mirrors the shell scripts exactly: env override > VPS `/data/.openclaw/workspace` > Mac `$HOME/.openclaw/workspace`.

---

## 3. API Endpoint (How to Read State)

### GET /api/interview/state (per-client)

Implementation: `src/app/api/interview/state/route.ts`

This is the ONLY endpoint dashboard/fleet code should call to determine interview status. It:

1. Reads the canonical FILES via the P0-1 seam (`src/lib/interview/seam.ts`) -- never the DB
2. Derives progress percent, gate flags, decision coverage, and structured resume position
3. Returns a complete JSON snapshot: interviewComplete, buildCompleted, progress rail, coverage, gate flags
4. Is fail-closed: if anything throws, all gate flags return false so Build stays disabled

---

## 4. The Database Trap (Why Direct Table Queries Are Wrong)

### The interview_sessions and interview_answers Tables

These tables (migration 087, `src/lib/db/migrations.ts`) are a READ-MIRROR only. Their purpose is to provide a fast UI index so the dashboard does not re-parse the canonical files on every request.

Critical caveats:

1. **0 rows does NOT mean "no interview."** The real interview state lives in the canonical files. The mirror is refreshed best-effort on writes and reads (P2-2 mirror-on-write sync in `src/lib/interview/mirror.ts`). If the mirror sync fails, it is swallowed -- the canonical write always succeeds.
2. **The mirror is NEVER a write authority.** interviewComplete is NOT stored in the DB. There is NO decisions table or interview_complete column. Completion and decision authority lives EXCLUSIVELY in the files.
3. **If mirror and files disagree, FILES WIN.** The mirror reconciles FROM the files, never the reverse.

---

## 5. Direct DB Query Inventory (src/)

Every direct reference to `interview_sessions` or `interview_answers` in `src/` is enumerated here. These are the mirror implementation itself plus the migration that created the tables. No dashboard or fleet code queries these tables directly.

| File | What it does | Annotation |
|------|------------|------------|
| `src/lib/interview/store.ts` | Mirror store -- INSERT/SELECT/UPDATE on interview_sessions and interview_answers (the only module allowed to touch these tables) | DOCTRINE block declares files as canonical source of truth |
| `src/lib/interview/mirror.ts` | Mirror-on-write sync -- reads canonical FILES and upserts them into the mirror tables | DOCTRINE block declares files as canonical source of truth |
| `src/app/api/interview/state/route.ts` | GET /api/interview/state -- reads canonical FILES via the seam, calls refreshInterviewMirror() as best-effort trailing step | DOCTRINE block declares files as canonical source of truth |
| `src/app/api/interview/answer/route.ts` | POST /api/interview/answer -- writes canonical FILE first, then refreshes mirror | DOCTRINE block declares files as canonical source of truth |
| `src/lib/db/migrations.ts` | Migration 087 -- creates interview_sessions and interview_answers tables | Migration comments declare tables are read-mirror only, files win |

If a future grep shows `interview_sessions` in a new file under `src/`, it MUST carry a comment pointing here (`docs/interview-state-source-of-truth.md`).

---

## 6. Checklist for Future Code

Any new code wanting to know "is there an interview?" MUST:

- Call GET /api/interview/state per client -- do NOT query interview_sessions directly
- Treat ok: false as "no interview / unverifiable state" (fail-closed)
- Never read interview_sessions.status as authoritative -- it is a mirror field that may be stale
- Never write interviewComplete or decision data to the DB -- only the canonical files carry those

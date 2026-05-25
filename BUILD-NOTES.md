# v4.0 Build Notes

Per PRD Section 18.4: log every interpretation decision that was not explicit in the PRD.

## Depth 0 (migrations 031-041 + platform.ts)

### Decisions outside the PRD's explicit spec

1. **Migration 031 schema source of truth.** The Depth 0 brief listed one column set; PRD Section 5.1 listed a different one. I followed PRD Section 5.1 (the more detailed and canonical spec) since the brief explicitly says "per PRD Section 4 and SCOPE-ADDITION.md for the exact schema". Side effect: I also created the companion `model_registry_refresh_log` table that PRD 5.1 specifies, because Migration 031 is the natural slot for both. Track C1 owns updates to `src/lib/model-registry.ts`; the refresh log table is already provisioned here.

2. **Migration 033 status enum widened.** The brief listed `ok / degraded / down`. PRD Section 3.12 defines the canonical six-state vocabulary (`live, working, busy, degraded, offline, unknown`). I made the CHECK constraint accept the union of both so simpler probes can still write `ok` or `down` while richer probes use the six-state set.

3. **Migration 034 rebuild strategy.** PRD said "12-step rebuild" and the brief said `PRAGMA defer_foreign_keys = ON`. The migration runner already wraps every migration in a transaction, and SQLite blocks `PRAGMA foreign_keys` inside transactions. So I used `defer_foreign_keys` exclusively (the documented in-transaction alternative). I also added a runtime `PRAGMA foreign_key_check` after the rebuild that throws if any orphan was created, and an early-return guard if the agents table already has busy and degraded in its CHECK (so re-applying the migration is harmless).

4. **Migration 034 column copy.** Rather than hardcoding the column list, I read `PRAGMA table_info(agents)` at migration time and copy whatever columns are actually live. This survives future column additions without needing a follow-up rebuild.

5. **Migration 037 table naming.** The brief said `operator_journal`, the PRD pattern would suggest `operator_journal_entries`. I went with `operator_journal_entries` to match the plural-entity-collection convention used by `operator_chat_sessions`, `operator_chat_messages`, and `operator_goals`. If Track B6 expects the bare name, this is a one-line rename in a follow-up migration.

6. **Migration 039 lock column.** Migration 029 already added the full lock protocol (locked_by, lock_reason, locked_at, lock_token). The brief asked for "a `lock` BOOLEAN column". I added `lock` as `INTEGER NOT NULL DEFAULT 0` (SQLite has no native BOOLEAN; integer 0/1 is the standard pattern in this codebase) and backfilled it from the existing protocol columns. Both stay: `lock` is the simple flag, the protocol columns carry the audit trail.

7. **platform.ts simplification.** PRD Section 3.6 specified four platforms (`mac_mini_legacy`, `mac_mini_new`, `vps_docker`, `unknown`) and snake_case slugs. The Depth 0 brief said two platforms (`mac-mini`, `vps-docker`) and kebab-case slugs. I followed the Depth 0 brief because it is more recent and more focused. This means platform.ts as built today only knows two platforms. If `mac_mini_legacy` versus `mac_mini_new` discrimination is needed later, expand `detectPlatform()` then.

8. **platform.ts vault and scratch roots.** Brief said `~/clawd/` and `~/clawd/scratch/` for Mac Mini. PRD Section 3.6 said `~/Documents/Obsidian Vault` and `~/operator-scratch`. I followed the brief. If the operator wants the Obsidian-vault layout instead, swap these constants in one place.

### Migrations 042 and 043

Not authored at Depth 0. Reserved for Wave 1 Tracks B7 (research_searches) and B9 (web_agent_sessions). Per SCOPE-ADDITION.md Section 9 the dispatch order is B7 first, then B9 rebases.

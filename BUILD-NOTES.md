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

## Depth 1 Track B1 (Operator Console shell)

### Decisions outside the PRD's explicit spec

1. **Sidebar visual style.** Donor pack (Agent OS) uses a dark Midnight Aubergine theme. BCC v3.7 uses a light theme with green primary (`bcc-primary` / `#43A047`). I rebuilt the sidebar against BCC's tokens (`bg-bcc-white`, `border-bcc-border`, `bcc-primary-light` for active row, `bcc-text-secondary` for inactive labels) rather than porting the donor styling. The vertical-section + active-indicator pattern survives; the colors are BCC's.

2. **Tile count and ordering.** SCOPE-ADDITION.md lists 10 sub-modules. The PRD Section 4.1 list (Bridge, Workspace, Studio, Notebook, Goals, Journal, Memory) is the original 7. Research, Call Mode, and Web Agent are the 3 SCOPE-ADDITION additions. I ordered the tiles in PRD order first (7 originals), then the 3 additions, so the landing page reads as "originals then new". The sidebar matches the same order.

3. **Placeholder behavior for Research / Call Mode / Web Agent.** Per the brief, these tiles ship as placeholders at this depth (their routes are Wave 1). I render them with reduced opacity, a "Wave 1" pill, and `cursor-not-allowed` (no `<Link>`, just a `role="link" aria-disabled="true"` div). The sidebar lists them with a `Soon` pill and still renders them as `<Link>` so that when Wave 1 ships and adds the routes, no sidebar code changes are needed.

4. **Call Mode route path.** PRD does not specify a route for Call Mode (it is described in SCOPE-ADDITION.md as living "inside Bridge"). For the placeholder I picked `/operator/call`. Track B8 may relocate it under `/operator/bridge/call` at Wave 1; the placeholder URL is informational only.

5. **Command Palette scope.** Donor `CommandPalette.tsx` was wired to a `/api/run` endpoint for shell commands. That endpoint does not exist in BCC v3.7. I rewrote the palette as a pure navigation palette (jumps between the 10 sub-modules) using the same `OPERATOR_NAV` list the sidebar consumes (single source of truth). Track B2+ can extend it with command actions later by appending to the actions list.

6. **Command Palette dependency isolation.** `cmdk` is not yet in `package.json`. I added one isolated `// @ts-expect-error` on the `cmdk` import with a comment pointing to the Pending dependencies list below. Everything else in the file type-checks normally.

7. **OperatorSidebar exports `OPERATOR_NAV`.** I exported the nav array so CommandPalette can consume it without duplication. This is a deliberate cross-component contract.

### Pending dependencies

These dependencies are referenced by Depth 1 code but are NOT yet in `package.json`. The integration step installs them in one batch:

  - `cmdk` (Command Palette), imported by `src/components/CommandPalette.tsx`. Pin to a React 18 compatible version (latest 1.x is fine).


---

## Depth 1, Track Install (scripts/install + scripts/integration-tests)

### Decisions outside the PRD's explicit spec

1. **Idempotency hardening.** PRD 6.2/6.3 reference scripts were minimal. I wrapped every step in an existence check so re-running is safe: brew `list` for formulae and casks, `npm list -g --depth=0` for npm globals, `command -v` for uv/cloudflared, `node -v` major version compare for the NodeSource install, `mkdir -p` for directories. Antigravity, free-claude-code, `uv python install`, and `pip install` retain their original behavior because their installers handle idempotency upstream (uv tool install uses `--force`; the rest are no-ops when current). `pm2 startup | bash` and `pm2 save` are followed by `|| true` because they can exit non-zero on re-run without indicating real failure.

2. **Homebrew PATH bootstrap.** PRD 6.2 installs Homebrew but never sources its shellenv before the next `brew install` line. On a fresh Mac that fails because brew is not on PATH yet. I added an Apple-Silicon-first `/opt/homebrew/bin/brew shellenv` eval with an Intel `/usr/local/bin/brew` fallback immediately after install. Does nothing if brew was already present.

3. **`.zshrc` PATH guard for fresh Macs.** PRD 6.2 appends `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` only when grep does not find it. On a brand-new Mac there is no `.zshrc` at all and grep returns non-zero, which under `set -e` aborted the script. Fixed by branching on `-f "$HOME/.zshrc"` and creating the file if absent.

4. **CLI detection list expanded.** PRD 6.2 lists 7 CLIs in the final detection summary. I added `node`, `python3`, `npm`, `brew` (Mac), `uv`, `pm2`, `ffmpeg`, `cloudflared` so the bootstrap output gives the System Status Panel (Section 6.4) a complete inventory on first run. Cost is zero; benefit is one-shot diagnosis of any missing dependency.

5. **VPS apt flags.** Added `--no-install-recommends` to the VPS apt-get install to keep the container thin, and explicit `ca-certificates` + `gnupg` so the NodeSource curl-to-bash works on a barebones image.

6. **Compat test schema probes.** PRD 12.3 uses `departments[*].slug` syntax in REQUIRED_SCHEMAS, which is not valid `jq` filter syntax (jq does not accept `[*]` outside of paths). I changed it to `departments[0].slug` (index-zero probe) which verifies the same fact: the first department has the field. If a stricter array-wide check is needed later, swap to `jq -e '.departments | all(has("slug"))'`.

7. **VPS compat test workspace root override.** PRD 13.3 hardcodes `/data/.openclaw/workspace`. I exposed it as the `VPS_WORKSPACE` env var (default `/data/.openclaw/workspace`) so the test can run against a staging mount without editing the script. Same for `API_BASE` in both compat tests.

8. **`jq` presence check.** PRD compat tests pipe to `jq -e` without checking that jq is installed. On a fresh Mac Mini before brew-installed-tools land, jq may be missing and the test would die with an opaque "command not found". I added an explicit `command -v jq` guard that fails with a clear message.

9. **Compat test exit codes.** PRD 12.3 uses `|| exit 1` only for the curl calls. I made every failure path emit a `FAIL:` line and `exit 1`. `set -euo pipefail` plus the explicit exits guarantees compat scripts exit 0 only on success.

## Depth 1 Track C1 (model_registry library + /api/models routes)

### Decisions outside the PRD's explicit spec

1. **Capability filter implemented as `LIKE '%"<cap>"%'`.** PRD Section 5.1 stores `capabilities` as a JSON array of strings in a TEXT column. To filter by capability without depending on the json1 extension (not guaranteed loaded on every deployment target), I match the quoted token against the raw JSON text. Quoting prevents prefix collisions (for example, the cap `audio` would otherwise match `audio_generation`). When json1 becomes a hard requirement we can swap to `json_each`.

2. **`status` query param defaults to `active`, accepts `all` sentinel.** PRD 5.4 says the UI calls `/api/models?status=active`. To keep the route useful for admin views (deprecated audit, preview rollout) I support every concrete status plus an `all` sentinel that disables the filter entirely. The default matches the PRD's documented call shape.

3. **`markMissingAsDeprecated` refuses to act on an empty seen-list.** PRD 5.3 pseudocode calls this after a successful provider fetch. If a provider's API hiccups and returns zero models, the literal pseudocode would mass-deprecate the entire catalog. I guard against that: zero seen models means "do nothing". The refresh log is the place to surface the outage. The refresh cron (separate track) should treat a zero-result fetch as a soft failure for the same reason.

4. **`/api/models/[id]` accepts natural key OR numeric pk.** The PRD says "GET returns one model's full record" without specifying the id form. Natural key (provider-scoped `model_id`) is the obvious choice for the Intelligence Settings UI. I also accept a bare integer as a fallback for admin tooling that already has the surrogate id in hand. The natural-key lookup runs first so a `model_id` that happens to be numeric still wins.

5. **`bulkUpsertModels` wrapped in a single transaction.** PRD 5.3 leaves the granularity unspecified. Wrapping per-provider keeps an in-flight refresh atomic so a partial failure mid-provider does not leave the catalog half-rewritten. The refresh cron should call `bulkUpsertModels` once per provider (not once across all providers) so providers stay independent, matching the `Promise.allSettled` pattern in the PRD.

6. **Exported types surface.** PRD only explicitly required `ModelRegistryEntry`. I also exported `ModelCapability`, `ModelStatus`, `ModelPricingModel`, `MODEL_CAPABILITIES`, `ModelRegistryUpsertInput`, `ModelRegistryListOptions`, `ModelRegistryRefreshLogEntry`, `BulkUpsertResult`, `UpsertOutcome`. These are surface area the provider connectors (Section 5.2) and the refresh cron (Section 5.3) will need to import without redefining locally.

7. **`raw_metadata` decoded eagerly.** Migration 031 stores it as TEXT (JSON). Callers always want it as an object, never as a string, so `decodeRow` parses it once at read time. Bad JSON logs an error and falls back to `{}` so a single poisoned row cannot 500 the entire `/api/models` list.
